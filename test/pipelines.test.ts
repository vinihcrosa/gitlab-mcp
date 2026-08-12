import { describe, expect, it } from 'vitest';
import {
  type JobView,
  type PipelineView,
  type RawJob,
  logAvailability,
  newest,
  renderJobLog,
  renderPipeline,
  renderPipelineList,
  toJobView,
  toPipelineView,
} from '../src/pipelines.js';

const rawPipeline = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 4454,
  status: 'success',
  sha: 'deadbeefcafebabe0123456789abcdef',
  ref: 'dev',
  source: 'merge_request_event',
  web_url: 'https://git.example.com/g/p/-/pipelines/4454',
  created_at: '2026-08-11T10:00:00Z',
  updated_at: '2026-08-11T10:15:00Z',
  ...over,
});

const rawJob = (over: Partial<RawJob> = {}): RawJob => ({
  id: 15965,
  name: 'dotnet-test',
  stage: 'test',
  status: 'failed',
  duration: 900,
  failure_reason: 'job_execution_timeout',
  web_url: 'https://git.example.com/g/p/-/jobs/15965',
  started_at: '2026-08-11T10:01:00Z',
  erased_at: null,
  ...over,
});

/** Constrói a partir do cru, para `failure_reason: undefined` sumir de verdade. */
const job = (over: Partial<RawJob> = {}): JobView => toJobView(rawJob(over));
const pipeline = (over: Partial<PipelineView> = {}): PipelineView => ({ ...toPipelineView(rawPipeline()), ...over });

describe('9. projeção — whitelist explícita', () => {
  it('UT-22 mantém as oito chaves e descarta o resto', () => {
    const view = toPipelineView(rawPipeline({ user: { username: 'x' }, detailed_status: { text: 'passed' } }));
    expect(Object.keys(view).sort()).toEqual(
      ['created_at', 'id', 'ref', 'sha', 'source', 'status', 'updated_at', 'web_url'].sort(),
    );
  });

  it('UT-23 chave ausente na origem continua ausente — não vira undefined presente', () => {
    const raw = rawPipeline();
    delete raw.source;
    expect('source' in toPipelineView(raw)).toBe(false);
  });

  it('UT-24 duration null é mantido, com a chave presente', () => {
    const view = toJobView(rawJob({ status: 'running', duration: null }));
    expect('duration' in view).toBe(true);
    expect(view.duration).toBeNull();
  });

  it('UT-25 job sem failure_reason não ganha a chave', () => {
    const raw = rawJob({ status: 'success' });
    delete raw.failure_reason;
    expect('failure_reason' in toJobView(raw)).toBe(false);
  });
});

describe('10. newest — qual pipeline descreve o estado atual', () => {
  it('UT-26 maior id vence, independente da ordem de entrada', () => {
    const list = [rawPipeline({ id: 10 }), rawPipeline({ id: 42 }), rawPipeline({ id: 7 })] as never;
    expect(newest(list)?.id).toBe(42);
  });

  it('UT-27 lista vazia devolve undefined', () => {
    expect(newest([])).toBeUndefined();
  });
});

describe('11. logAvailability — vale pedir o trace?', () => {
  it('UT-28 job que nunca começou', () => {
    expect(logAvailability(rawJob({ started_at: null, status: 'manual' }))).toEqual({
      kind: 'never-started',
      status: 'manual',
    });
  });

  it('UT-29 job com log apagado', () => {
    const j = rawJob({ erased_at: '2026-08-01T10:00:00Z' });
    expect(logAvailability(j)).toEqual({
      kind: 'erased',
      erasedAt: '2026-08-01T10:00:00Z',
      webUrl: j.web_url,
    });
  });

  it('UT-30 job que rodou e não foi apagado', () => {
    expect(logAvailability(rawJob())).toEqual({ kind: 'ready' });
  });

  it('UT-31 nunca-começou vence log-apagado — precedência fixa', () => {
    const j = rawJob({ started_at: null, erased_at: '2026-08-01T10:00:00Z' });
    expect(logAvailability(j).kind).toBe('never-started');
  });
});

describe('12. renderPipeline', () => {
  it('UT-32 job que falhou é nomeado com a chamada exata que lê o log', () => {
    const out = renderPipeline(pipeline({ status: 'failed' }), [job()], 'tms-3.0/TMS-server', 1);
    expect(out).toContain('dotnet-test');
    expect(out).toContain('get_job_log(project="tms-3.0/TMS-server", job_id=15965)');
  });

  it('UT-33 pipeline toda verde não sugere leitura de log', () => {
    const out = renderPipeline(pipeline(), [job({ status: 'success' })], 'g/p', 1);
    expect(out).not.toContain('get_job_log');
  });

  it('UT-34 pipeline em execução lista o job concluído e não inventa duração para o que corre', () => {
    const done = job({ id: 1, name: 'lint', status: 'success', duration: 30, failure_reason: undefined });
    const running = job({ id: 2, name: 'unit', status: 'running', duration: null, failure_reason: undefined });
    const out = renderPipeline(pipeline({ status: 'running' }), [done, running], 'g/p', 1);
    const lineFor = (id: number): string => out.split('\n').find((l) => l.includes(`id=${id}`)) ?? '';

    expect(out).toContain('pipeline #4454: running');
    expect(lineFor(1)).toContain('duração=30s');
    // A linha do job em curso não pode inventar número nenhum de duração.
    expect(lineFor(2)).toContain('duração=—');
    expect(lineFor(2)).not.toMatch(/duração=\d/);
  });

  it('UT-35 dois jobs falhados são nomeados, cada um com o próprio id', () => {
    const a = job({ id: 11, name: 'lint' });
    const b = job({ id: 22, name: 'unit' });
    const out = renderPipeline(pipeline({ status: 'failed' }), [a, b], 'g/p', 1);
    expect(out).toContain('job_id=11');
    expect(out).toContain('job_id=22');
    expect(out).toContain('Jobs que falharam (2)');
  });

  it('UT-36 nenhuma chave crua do GitLab vaza para a saída', () => {
    const out = renderPipeline(
      toPipelineView(rawPipeline({ detailed_status: { text: 'passed' }, user: { username: 'x' } })),
      [job()],
      'g/p',
      1,
    );
    expect(out).not.toContain('detailed_status');
    expect(out).not.toContain('username');
  });
});

describe('13. renderPipelineList', () => {
  it('UT-37 três pipelines e o bloco de página apontando a próxima', () => {
    const items = [pipeline({ id: 3 }), pipeline({ id: 2 }), pipeline({ id: 1 })];
    const out = renderPipelineList(items, { page: 1, per_page: 20, total_pages: 3, has_more: true, next_page: 2 });
    expect(out.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(3);
    expect(out).toContain('has_more=true');
    expect(out).toContain('next_page=2');
  });

  it('UT-38 lista vazia é uma afirmação, não um erro', () => {
    const out = renderPipelineList([], { page: 1, per_page: 20, has_more: false });
    expect(out).toContain('Nenhuma pipeline encontrada');
    expect(out).toContain('page=1');
  });
});

describe('14. renderJobLog', () => {
  it('UT-39 o corpo vai embrulhado como não confiável, com a nota uma vez só', () => {
    const out = renderJobLog(job(), 'boom');
    expect(out).toContain('<untrusted source="gitlab:job_trace">');
    expect(out).toContain('boom');
    expect(out.match(/nota do servidor/g)).toHaveLength(1);
  });

  it('UT-40 o cabeçalho carrega nome, stage, status e failure_reason', () => {
    const out = renderJobLog(job(), 'x');
    expect(out).toContain('dotnet-test');
    expect(out).toContain('stage test');
    expect(out).toContain('status failed');
    expect(out).toContain('failure_reason: job_execution_timeout');
  });

  it('UT-41 trace vazio é dito, não vira bloco untrusted vazio', () => {
    const out = renderJobLog(job(), '');
    expect(out).toContain('trace veio vazio');
    expect(out).not.toContain('<untrusted');
  });
});
