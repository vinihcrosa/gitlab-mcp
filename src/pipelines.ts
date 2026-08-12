// Projeção, decisão e renderização de pipeline e job. Lógica pura, sem I/O.
// Não importa gitlab.ts — invariante 4. É o que deixa a resposta inteira
// testável com literal em vez de fixture de rede.

import {
  INLINE_UNTRUSTED_NOTE,
  inlineUntrusted,
  pick,
  untrusted,
  withUntrustedNote,
} from './format.js';
import type { TraceRender } from './trace.js';

/** O que o GitLab devolve, do que a gente usa. */
export interface RawPipeline {
  id: number;
  status: string;
  sha: string;
  ref: string;
  source?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface RawJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  failure_reason?: string;
  web_url: string;
  started_at?: string | null;
  erased_at?: string | null;
}

/**
 * Toda chave é opcional de propósito: `pick()` descarta o que vier undefined da
 * API, então declarar campo obrigatório aqui seria mentira do tipo — e a mentira
 * vira TypeError no renderizador quando o GitLab omite um campo. Invariante 4
 * exige função total sobre o tipo declarado; é este tipo que torna isso possível.
 */
export interface PipelineView {
  id?: number;
  status?: string;
  sha?: string;
  ref?: string;
  source?: string;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface JobView {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  duration?: number | null;
  failure_reason?: string;
  web_url?: string;
}

const PIPELINE_KEYS = ['id', 'status', 'sha', 'ref', 'source', 'web_url', 'created_at', 'updated_at'] as const;
const JOB_KEYS = ['id', 'name', 'stage', 'status', 'duration', 'failure_reason', 'web_url'] as const;

/** Whitelist. Chave ausente na origem continua ausente na saída. */
export function toPipelineView(raw: unknown): PipelineView {
  return pick(raw, PIPELINE_KEYS) as PipelineView;
}

export function toJobView(raw: unknown): JobView {
  return pick(raw, JOB_KEYS) as JobView;
}

/**
 * Maior id vence. A ordem que o endpoint devolve não é contratual, então não é
 * usada — re-run do mesmo commit produz várias pipelines e só a última descreve
 * o estado atual da branch.
 */
export function newest(pipelines: RawPipeline[]): RawPipeline | undefined {
  // Elemento sem `id` não pode ganhar: `undefined > n` e `n > undefined` são
  // ambos false, então o primeiro da lista nunca era deslocado e voltava — o
  // resultado dependia da ordem, e get_mr_pipeline ia pedir
  // /pipelines/undefined/jobs. `RawPipeline` declara id obrigatório, então o
  // tipo não pega; o resto deste arquivo já foi feito total sobre ausência.
  let best: RawPipeline | undefined;
  for (const p of pipelines) {
    if (typeof p?.id !== 'number') continue;
    if (best === undefined || p.id > best.id) best = p;
  }
  return best;
}

/** Estados finais de um job. Fora daqui, ele ainda pode produzir saída. */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped']);

/**
 * Estados em que o job comprovadamente ainda não rodou. `canceled` entra porque
 * o teste combina com `started_at` ausente: cancelado DEPOIS de começar tem
 * started_at, então só o cancelado antes de começar cai aqui — que senão ia
 * para `ready` e recebia a mensagem de "log pode ter sido arquivado".
 */
const NEVER_RAN_STATUSES = new Set([
  'created',
  'pending',
  'manual',
  'skipped',
  'waiting_for_resource',
  'scheduled',
  'canceled',
]);

export type LogAvailability =
  | { kind: 'ready' }
  | { kind: 'never-started'; status: string }
  | { kind: 'erased'; erasedAt: string; webUrl: string };

/**
 * Decide, só com os metadados do job, se vale pedir o trace. `started_at` e
 * `erased_at` existem para isto e nunca são impressos.
 *
 * Precedência fixa: nunca-começou vence log-apagado. Um job que não começou não
 * tinha log para apagar, então essa é a explicação verdadeira.
 */
export function logAvailability(job: RawJob): LogAvailability {
  // `started_at` ausente só significa "nunca começou" quando o status também
  // diz isso. Colapsar ausência em null fazia um job `success` sem o campo
  // responder "status success, nunca começou a executar" — contradição que o
  // modelo não tem como enxergar. Na dúvida, tenta o trace e deixa o 404 falar.
  const notStarted = job.started_at === null || job.started_at === undefined;
  if (notStarted && NEVER_RAN_STATUSES.has(job.status)) {
    return { kind: 'never-started', status: job.status };
  }
  if (job.erased_at !== null && job.erased_at !== undefined) {
    return { kind: 'erased', erasedAt: job.erased_at, webUrl: job.web_url };
  }
  return { kind: 'ready' };
}

const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : '—');
const dur = (d: number | null | undefined): string => (typeof d === 'number' ? `${d}s` : '—');
/**
 * Campo do servidor que pode faltar. Nunca é texto livre do usuário.
 *
 * Trata null além de undefined: `pick()` descarta só undefined — de propósito,
 * UT-24 depende disso para `duration: null` — então qualquer campo que a API
 * mande como null chega aqui e viraria a string "null" na saída.
 */
export const val = (v: string | number | null | undefined): string =>
  v === undefined || v === null ? '—' : String(v);

export function renderPipeline(
  p: PipelineView,
  jobs: JobView[],
  label: string,
  iid: number,
  /**
   * Lista autoritativa de jobs que falharam. Passada quando a pipeline tem mais
   * jobs que uma página: filtrar `jobs` daria a lista só da primeira página, e
   * uma pipeline `failed` sairia sem nenhum job falho listado.
   */
  failedOverride?: JobView[],
): string {
  const out: string[] = [
    `MR ${label}!${iid} — pipeline #${val(p.id)}: ${val(p.status)}`,
    `  sha        = ${shortSha(p.sha)}`,
    // ref é nome de branch: texto livre de quem abriu o MR.
    `  ref        = ${inlineUntrusted(p.ref)}`,
    `  source     = ${p.source ?? '(não informado)'}`,
    `  criado     = ${val(p.created_at)}`,
    `  atualizado = ${val(p.updated_at)}`,
    `  web_url    = ${val(p.web_url)}`,
    '',
  ];

  if (jobs.length === 0) {
    // `ref` já foi renderizado acima, então esta saída também carrega texto
    // livre — e pipeline sem job ainda é o caso comum de MR recém-pushado,
    // exatamente quando get_mr_pipeline é mais chamada.
    out.push('Nenhum job nesta pipeline ainda.', '', INLINE_UNTRUSTED_NOTE);
    return out.join('\n');
  }

  out.push(`Jobs (${jobs.length}):`);
  for (const j of jobs) {
    const reason = j.failure_reason ? `  failure_reason=${inlineUntrusted(j.failure_reason, 60)}` : '';
    // name e stage vêm do .gitlab-ci.yml da branch do autor do MR.
    const who = `${inlineUntrusted(j.stage, 40)}/${inlineUntrusted(j.name, 80)}`;
    out.push(`  ${val(j.status).padEnd(9)} ${who}  id=${val(j.id)}  duração=${dur(j.duration)}${reason}`);
  }

  const failed = failedOverride ?? jobs.filter((j) => j.status === 'failed');
  if (failed.length > 0) {
    out.push('', `Jobs que falharam (${failed.length}):`);
    for (const j of failed) {
      out.push(
        `  - ${inlineUntrusted(j.name, 80)} (id=${val(j.id)}) — use get_job_log(project="${label}", job_id=${val(j.id)})`,
      );
    }
  }

  // Nome de job, stage, branch e failure_reason são escritos por quem abriu o
  // MR e aparecem no meio de linhas que o servidor escreveu. inlineUntrusted
  // impede que forjem uma linha; a nota é o que diz ao modelo que são dados.
  out.push('', INLINE_UNTRUSTED_NOTE);
  return out.join('\n');
}

export function renderPipelineList(items: PipelineView[], page: Record<string, unknown>): string {
  const pageLine = Object.entries(page)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');

  if (items.length === 0) {
    return `Nenhuma pipeline encontrada com esses filtros.\n${pageLine}`;
  }

  const lines = items.map(
    (p) =>
      `#${val(p.id)} ${val(p.status)} ref=${inlineUntrusted(p.ref)} sha=${shortSha(p.sha)} ` +
      `source=${p.source ?? '—'} criado=${val(p.created_at)} ${val(p.web_url)}`,
  );
  return [`Pipelines (${items.length} nesta página):`, ...lines, '', pageLine, '', INLINE_UNTRUSTED_NOTE].join(
    '\n',
  );
}

/**
 * Cabeçalho do job mais o trace já limpo, embrulhado como não confiável — o
 * embrulho mora aqui, e não na tool, para o invariante 7 ser checável sem rede.
 *
 * O cabeçalho fica FORA do envelope, então todo campo livre dele passa por
 * inlineUntrusted. O aviso de corte também fica fora: é texto do servidor e diz
 * o que fazer em seguida, não pode chegar como dado que a nota manda ignorar.
 */
/**
 * A nota inline vale para toda resposta que carrega nome/stage/branch fora de
 * envelope — inclusive as saídas curtas de "nunca começou" e "log apagado",
 * que também imprimem o nome do job.
 */
export function withInlineNote(text: string): string {
  return `${text}\n\n${INLINE_UNTRUSTED_NOTE}`;
}

export function renderJobLog(job: JobView, trace: TraceRender): string {
  const reason = job.failure_reason ? ` — failure_reason: ${inlineUntrusted(job.failure_reason, 60)}` : '';
  const header =
    `Job ${val(job.id)} — ${inlineUntrusted(job.name, 80)} ` +
    `(stage ${inlineUntrusted(job.stage, 40)}) — status ${val(job.status)}${reason}`;
  const notice = trace.notice ? `\n${trace.notice}` : '';

  // A nota do envelope diz, com as próprias palavras, "o conteúdo em
  // <untrusted>" — não cobre o cabeçalho acima dela, que carrega name, stage e
  // failure_reason escritos por quem abriu o MR. Precisa das duas.
  if (trace.body === '') {
    // "terminou" só quando terminou. Pedir o log de um job que acabou de subir
    // é o primeiro movimento natural, e dizer que acabou é o oposto do que a
    // descrição da tool promete ("chame de novo para atualizar").
    const done = TERMINAL_STATUSES.has(job.status ?? '');
    const verb = done
      ? `terminou com status ${val(job.status)} mas o trace veio vazio`
      : `está com status ${val(job.status)} e ainda não emitiu saída — chame de novo em instantes`;
    return withInlineNote(`${header}${notice}\n\nJob ${val(job.id)} ${verb}.`);
  }

  return withInlineNote(withUntrustedNote(`${header}${notice}\n\n${untrusted('job_trace', trace.body)}`));
}
