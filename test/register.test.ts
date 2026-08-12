import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerAll } from '../src/tools/index.js';
import { jobLogSchema } from '../src/tools/pipelines.js';

/**
 * Servidor falso: só anota o nome de cada tool registrada. Serve porque todo
 * registro passa por um ponto só (src/tools/register.ts) e isReadOnly() é
 * alcançado apenas de dentro de assertWritable(), em tempo de chamada — o
 * registro em si não toca config nem rede.
 */
function recorder(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string): void => {
      names.push(name);
    },
  } as unknown as McpServer;
  return { server, names };
}

const EXISTING = [
  'whoami',
  'list_my_projects',
  'list_my_authored_mrs',
  'list_mrs_awaiting_my_review',
  'get_mr',
  'get_mr_diff',
  'list_mr_discussions',
  'comment_on_mr',
  'comment_on_mr_line',
  'reply_to_mr_discussion',
];

const NEW = ['get_mr_pipeline', 'get_job_log', 'list_pipelines'];

describe('15. superfície de tools', () => {
  it('UT-42 registra exatamente 13 tools, sem nome repetido', () => {
    const { server, names } = recorder();
    registerAll(server);
    expect(names).toHaveLength(13);
    expect(new Set(names).size).toBe(13);
  });

  it('UT-43 as dez que já existiam continuam, e as três novas entraram', () => {
    const { server, names } = recorder();
    registerAll(server);
    for (const name of EXISTING) expect(names).toContain(name);
    for (const name of NEW) expect(names).toContain(name);
  });

  it('UT-44 read-only não muda o registro — o guard é em tempo de chamada', () => {
    const previous = process.env.GITLAB_READ_ONLY;
    process.env.GITLAB_READ_ONLY = 'true';
    try {
      const { server, names } = recorder();
      registerAll(server);
      expect(names).toHaveLength(13);
      for (const name of NEW) expect(names).toContain(name);
    } finally {
      if (previous === undefined) delete process.env.GITLAB_READ_ONLY;
      else process.env.GITLAB_READ_ONLY = previous;
    }
  });
});

describe('16. limites do argumento de get_job_log', () => {
  const schema = z.object(jobLogSchema);
  const base = { project: 'g/p', job_id: 1 };

  it('UT-45 max_lines acima do teto é recusado; 400 e ausente passam', () => {
    expect(schema.safeParse({ ...base, max_lines: 6000 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_lines: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_lines: 400 }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
  });
});
