import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerAll } from '../src/tools/index.js';
import { jobLogSchema } from '../src/tools/pipelines.js';
import { assertWritable } from '../src/tools/register.js';
import { isReadOnly, loadConfig } from '../src/config.js';

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
    withEnv({ GITLAB_READ_ONLY: 'true' }, () => {
      loadConfig();
      const { server, names } = recorder();
      registerAll(server);
      expect(names).toHaveLength(13);
      for (const name of NEW) expect(names).toContain(name);
    });
  });
});

/**
 * Troca env, recarrega config, restaura. `loadConfig()` é o único ponto que
 * popula `cfg` — sem chamá-lo, mexer em process.env não influencia assertion
 * nenhuma, que era o defeito do UT-44 original.
 */
function withEnv(vars: Record<string, string>, body: () => void): void {
  const previous: Record<string, string | undefined> = {};
  const base = { GITLAB_URL: 'https://gitlab.exemplo.test', GITLAB_TOKEN: 'glpat-teste', ...vars };
  for (const [k, v] of Object.entries(base)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Sem recarregar: o ambiente real do processo de teste não tem GITLAB_URL,
    // e loadConfig() chama process.exit(1) quando a validação falha. A config
    // carregada fica como estava; cada caso que depende dela chama loadConfig()
    // dentro do próprio withEnv.
  }
}

describe('17. o guard de escrita em tempo de chamada', () => {
  it('UT-48 read-only faz assertWritable lançar, com a mensagem exata', () => {
    withEnv({ GITLAB_READ_ONLY: 'true' }, () => {
      loadConfig();
      expect(isReadOnly()).toBe(true);
      expect(() => assertWritable()).toThrowError(
        'Escrita desabilitada. Defina GITLAB_READ_ONLY=false para habilitar.',
      );
    });
  });

  it('UT-49 a comparação é case-insensitive e com trim; qualquer outro valor é read-only', () => {
    // Comportamento REAL de src/config.ts:66 — `.trim().toLowerCase() !== 'false'`.
    // README.md:11 e AGENTS.md §7 dizem "só o literal 'false' (exato)", o que
    // não bate: 'FALSE' e ' false ' também liberam. Divergência pré-existente,
    // fora do escopo desta feature; este caso fixa o que o código faz hoje para
    // que uma mudança futura seja deliberada em vez de silenciosa.
    for (const liberating of ['false', 'FALSE', ' false ']) {
      withEnv({ GITLAB_READ_ONLY: liberating }, () => {
        loadConfig();
        expect(() => assertWritable(), `valor ${JSON.stringify(liberating)}`).not.toThrow();
      });
    }
    for (const value of ['0', 'no', '', 'true']) {
      withEnv({ GITLAB_READ_ONLY: value }, () => {
        loadConfig();
        expect(() => assertWritable(), `valor ${JSON.stringify(value)}`).toThrow();
      });
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
