// Projeção, decisão e renderização de pipeline e job. Lógica pura, sem I/O.
// Não importa gitlab.ts — invariante 4. É o que deixa a resposta inteira
// testável com literal em vez de fixture de rede.

import { pick, untrusted, withUntrustedNote } from './format.js';

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

export interface PipelineView {
  id: number;
  status: string;
  sha: string;
  ref: string;
  source?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface JobView {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  failure_reason?: string;
  web_url: string;
}

const PIPELINE_KEYS = ['id', 'status', 'sha', 'ref', 'source', 'web_url', 'created_at', 'updated_at'] as const;
const JOB_KEYS = ['id', 'name', 'stage', 'status', 'duration', 'failure_reason', 'web_url'] as const;

/** Whitelist. Chave ausente na origem continua ausente na saída. */
export function toPipelineView(raw: unknown): PipelineView {
  return pick(raw, PIPELINE_KEYS) as unknown as PipelineView;
}

export function toJobView(raw: unknown): JobView {
  return pick(raw, JOB_KEYS) as unknown as JobView;
}

/**
 * Maior id vence. A ordem que o endpoint devolve não é contratual, então não é
 * usada — re-run do mesmo commit produz várias pipelines e só a última descreve
 * o estado atual da branch.
 */
export function newest(pipelines: RawPipeline[]): RawPipeline | undefined {
  let best: RawPipeline | undefined;
  for (const p of pipelines) {
    if (best === undefined || p.id > best.id) best = p;
  }
  return best;
}

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
  if (job.started_at === null || job.started_at === undefined) {
    return { kind: 'never-started', status: job.status };
  }
  if (job.erased_at !== null && job.erased_at !== undefined) {
    return { kind: 'erased', erasedAt: job.erased_at, webUrl: job.web_url };
  }
  return { kind: 'ready' };
}

const shortSha = (sha: string): string => sha.slice(0, 8);
const dur = (d: number | null): string => (typeof d === 'number' ? `${d}s` : '—');

export function renderPipeline(p: PipelineView, jobs: JobView[], label: string, iid: number): string {
  const out: string[] = [
    `MR ${label}!${iid} — pipeline #${p.id}: ${p.status}`,
    `  sha        = ${shortSha(p.sha)}`,
    `  ref        = ${p.ref}`,
    `  source     = ${p.source ?? '(não informado)'}`,
    `  criado     = ${p.created_at}`,
    `  atualizado = ${p.updated_at}`,
    `  web_url    = ${p.web_url}`,
    '',
  ];

  if (jobs.length === 0) {
    out.push('Nenhum job nesta pipeline ainda.');
    return out.join('\n');
  }

  out.push(`Jobs (${jobs.length}):`);
  for (const j of jobs) {
    const reason = j.failure_reason ? `  failure_reason=${j.failure_reason}` : '';
    out.push(`  ${j.status.padEnd(9)} ${j.stage}/${j.name}  id=${j.id}  duração=${dur(j.duration)}${reason}`);
  }

  const failed = jobs.filter((j) => j.status === 'failed');
  if (failed.length > 0) {
    out.push('', `Jobs que falharam (${failed.length}):`);
    for (const j of failed) {
      out.push(`  - ${j.name} (id=${j.id}) — use get_job_log(project="${label}", job_id=${j.id})`);
    }
  }

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
      `#${p.id} ${p.status} ref=${p.ref} sha=${shortSha(p.sha)} source=${p.source ?? '—'} criado=${p.created_at} ${p.web_url}`,
  );
  return [`Pipelines (${items.length} nesta página):`, ...lines, '', pageLine].join('\n');
}

/**
 * Cabeçalho do job mais o trace já limpo, embrulhado como não confiável — o
 * embrulho mora aqui, e não na tool, para o invariante 7 ser checável sem rede.
 */
export function renderJobLog(job: JobView, traceBody: string): string {
  const reason = job.failure_reason ? ` — failure_reason: ${job.failure_reason}` : '';
  const header = `Job ${job.id} — ${job.name} (stage ${job.stage}) — status ${job.status}${reason}`;

  if (traceBody === '') {
    return `${header}\n\nJob ${job.id} (${job.name}) terminou com status ${job.status} mas o trace veio vazio.`;
  }

  return withUntrustedNote(`${header}\n\n${untrusted('job_trace', traceBody)}`);
}
