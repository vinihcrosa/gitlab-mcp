// Único ponto de saída HTTP do server. Toda tool passa por aqui.
import { readFileSync } from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';
import { getConfig } from './config.js';
import { GitLabError } from './errors.js';

/** Log sempre em stderr. stdout é do protocolo MCP. */
export function log(msg: string): void {
  console.error(`[gitlab-mcp] ${msg}`);
}

/**
 * Instala o CA privado no dispatcher global do fetch nativo.
 * Não existe opção de desabilitar verificação TLS — de propósito.
 */
export function initHttp(): void {
  const cfg = getConfig();
  if (!cfg.caCert) return;
  const ca = readFileSync(cfg.caCert, 'utf8');
  setGlobalDispatcher(new Agent({ connect: { ca } }));
  log(`CA privada carregada de ${cfg.caCert}`);
}

export interface Page {
  page?: number;
  totalPages?: number;
  nextPage?: number;
}

export interface GitLabResponse<T> {
  data: T;
  page: Page;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** Pares de query string. Valores undefined/null são descartados. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Corpo JSON. Chaves ausentes continuam ausentes — nada de null implícito. */
  body?: unknown;
  /** Nome legível do recurso, usado nas mensagens de erro. Ex.: `projeto "grupo/x"`. */
  resource?: string;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const cfg = getConfig();
  const url = new URL(`${cfg.url}/api/v4${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function readPage(h: Headers): Page {
  const num = (name: string): number | undefined => {
    const raw = h.get(name);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return { page: num('x-page'), totalPages: num('x-total-pages'), nextPage: num('x-next-page') };
}

function extractGitlabMessage(raw: string): string {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const m = j.message ?? j.error ?? j.error_description;
    if (typeof m === 'string') return m;
    if (m !== undefined) return JSON.stringify(m);
  } catch {
    /* corpo não-JSON: devolve cru, truncado */
  }
  return raw.slice(0, 500);
}

function toGitLabError(status: number, raw: string, resource: string): GitLabError {
  const detail = extractGitlabMessage(raw);
  const suffix = detail ? ` GitLab disse: ${detail}` : '';

  switch (status) {
    case 401:
      return new GitLabError('Token inválido ou expirado.', status, raw);
    case 403:
      return new GitLabError(
        `Token sem permissão para ${resource}. Escopo necessário: api (você provavelmente está com read_api).`,
        status,
        raw,
      );
    case 404:
      return new GitLabError(`Não encontrado ou sem acesso: ${resource}.${suffix}`, status, raw);
    case 400:
      return new GitLabError(`GitLab recusou a requisição (400) em ${resource}.${suffix}`, status, raw);
    case 429:
      return new GitLabError(
        `Rate limit do GitLab (429) em ${resource}. Já tentei de novo respeitando Retry-After e falhou. Espere e repita.`,
        status,
        raw,
      );
    default:
      if (status >= 500) {
        return new GitLabError(`GitLab respondeu ${status} em ${resource}.${suffix}`, status, raw);
      }
      return new GitLabError(`Falha ${status} em ${resource}.${suffix}`, status, raw);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** O que a chamada aceita de volta. Só isso difere entre gl() e glText(). */
type Accept = 'application/json' | 'text/plain';

async function once(url: string, opts: RequestOptions, accept: Accept): Promise<Response> {
  const cfg = getConfig();
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': cfg.token,
    Accept: accept,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
}

/**
 * Núcleo compartilhado: url, header, timeout, retry único de 429 e tradução de
 * erro. Devolve a Response já garantidamente ok — quem chama só decide como ler
 * o corpo. Existir uma vez só é o que impede gl() e glText() de divergirem.
 */
async function request(path: string, opts: RequestOptions, accept: Accept): Promise<Response> {
  const cfg = getConfig();
  const resource = opts.resource ?? path;
  const url = buildUrl(path, opts.query);

  /**
   * Traduz falha de rede/timeout. Toda ida à rede passa por aqui — inclusive a
   * segunda tentativa do 429 e a leitura do corpo. Deixar qualquer uma de fora
   * faz um DOMException cru chegar ao modelo, sem citar GITLAB_TIMEOUT_MS,
   * GITLAB_URL nem GITLAB_CA_CERT.
   */
  const translate = (e: unknown): never => {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new GitLabError(
        `Timeout de ${cfg.timeoutMs}ms falando com ${cfg.url} (${resource}). Aumente GITLAB_TIMEOUT_MS ou verifique rede/VPN. Se o corpo for grande, reduza max_lines.`,
        0,
      );
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new GitLabError(
      `Não consegui falar com ${cfg.url} (${resource}): ${detail}. Verifique GITLAB_URL, rede/VPN e GITLAB_CA_CERT se o cert for privado.`,
      0,
    );
  };

  const attempt = async (): Promise<Response> => {
    try {
      return await once(url, opts, accept);
    } catch (e) {
      return translate(e);
    }
  };

  let res = await attempt();

  // 429: respeita Retry-After, tenta uma vez, depois desiste.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '');
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 5000;
    log(`429 em ${resource}; aguardando ${waitMs}ms e tentando uma vez.`);
    await sleep(waitMs);
    res = await attempt();
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw toGitLabError(res.status, raw, resource);
  }

  return res;
}

/**
 * Lê o corpo com a mesma tradução de erro. O AbortSignal do timeout continua
 * armado enquanto o corpo baixa: um trace grande em VPN lenta devolve 200 OK e
 * só então falha aqui.
 */
async function readBody(res: Response, path: string, opts: RequestOptions): Promise<string> {
  const cfg = getConfig();
  const resource = opts.resource ?? path;
  try {
    return await res.text();
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new GitLabError(
        `Timeout de ${cfg.timeoutMs}ms baixando a resposta de ${resource}. Aumente GITLAB_TIMEOUT_MS, verifique rede/VPN, ou peça menos dados (max_lines menor).`,
        0,
      );
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new GitLabError(`Falha lendo a resposta de ${resource}: ${detail}.`, 0);
  }
}

/** Uma chamada à API v4. Lança GitLabError já traduzido. */
export async function gl<T>(path: string, opts: RequestOptions = {}): Promise<GitLabResponse<T>> {
  const res = await request(path, opts, 'application/json');
  const text = await readBody(res, path, opts);
  const data = (text ? JSON.parse(text) : null) as T;
  return { data, page: readPage(res.headers) };
}

/**
 * Mesma requisição, mesmo tratamento de erro, mesmo retry — corpo devolvido
 * cru, sem parse. Para endpoint que não responde JSON: hoje, trace de job.
 */
export async function glText(path: string, opts: RequestOptions = {}): Promise<GitLabResponse<string>> {
  const res = await request(path, opts, 'text/plain');
  return { data: await readBody(res, path, opts), page: readPage(res.headers) };
}
