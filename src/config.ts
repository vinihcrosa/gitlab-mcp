// Configuração via env. Validada no boot: se algo essencial faltar, escreve em
// stderr e mata o processo. Nunca subir um server quebrado.
import { existsSync } from 'node:fs';

export interface Config {
  /** Base normalizada, sem barra final e sem /api/v4. */
  url: string;
  token: string;
  /** true = as tools de escrita recusam. */
  readOnly: boolean;
  caCert?: string;
  timeoutMs: number;
}

let cfg: Config | null = null;

/**
 * Remove barras finais e um sufixo /api/v4 colado por engano.
 * Exportada para teste manual / reuso.
 */
export function normalizeGitlabUrl(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/api\/v4$/i, '');
  return s.replace(/\/+$/, '');
}

export function loadConfig(): Config {
  const errors: string[] = [];

  const rawUrl = (process.env.GITLAB_URL ?? '').trim();
  const token = (process.env.GITLAB_TOKEN ?? '').trim();

  if (!rawUrl) {
    errors.push('GITLAB_URL não definida. Ex.: GITLAB_URL=https://gitlab.empresa.com');
  }
  if (!token) {
    errors.push('GITLAB_TOKEN não definido. Gere um Personal Access Token no GitLab.');
  }

  let url = '';
  if (rawUrl) {
    url = normalizeGitlabUrl(rawUrl);
    if (!/^https?:\/\/[^/]+/.test(url)) {
      errors.push(`GITLAB_URL inválida: "${rawUrl}". Precisa começar com http:// ou https://`);
    }
  }

  let timeoutMs = 20000;
  const rawTimeout = (process.env.GITLAB_TIMEOUT_MS ?? '').trim();
  if (rawTimeout !== '') {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`GITLAB_TIMEOUT_MS inválido: "${rawTimeout}". Use um número de milissegundos > 0.`);
    } else {
      timeoutMs = n;
    }
  }

  const caCert = (process.env.GITLAB_CA_CERT ?? '').trim() || undefined;
  if (caCert && !existsSync(caCert)) {
    errors.push(`GITLAB_CA_CERT aponta para arquivo inexistente: ${caCert}`);
  }

  // Só o literal 'false' habilita escrita. Qualquer outra coisa (inclusive ausente) = read-only.
  const readOnly = (process.env.GITLAB_READ_ONLY ?? '').trim().toLowerCase() !== 'false';

  if (errors.length > 0) {
    console.error('[gitlab-mcp] configuração inválida:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('[gitlab-mcp] veja .env.example. Abortando.');
    process.exit(1);
  }

  cfg = { url, token, readOnly, caCert, timeoutMs };
  return cfg;
}

export function getConfig(): Config {
  if (!cfg) throw new Error('config não carregada — chame loadConfig() no boot');
  return cfg;
}

export function isReadOnly(): boolean {
  return getConfig().readOnly;
}
