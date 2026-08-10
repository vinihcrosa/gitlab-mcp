import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gl } from '../gitlab.js';
import { json, pageBlock, pick } from '../format.js';
import { rememberProject } from '../projects.js';
import { tool } from './register.js';

// Whitelist de saída. Mesmo com simple=true o GitLab manda campo demais.
const PROJECT_FIELDS = ['id', 'path_with_namespace', 'name', 'web_url', 'last_activity_at'] as const;

const schema = {
  search: z
    .string()
    .optional()
    .describe('Filtro por nome/path do projeto. Omita para listar todos os projetos onde você é membro.'),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Itens por página. Default 20, máximo 100. Só aumente se realmente precisar.'),
  page: z.number().int().min(1).optional().describe('Página, começando em 1. Default 1.'),
};

export function registerProjects(server: McpServer): void {
  tool(
    server,
    'list_my_projects',
    [
      'Lista os projetos GitLab onde você é membro, ordenados por atividade recente.',
      'Use para descobrir o path exato de um projeto (grupo/subgrupo/projeto) antes de chamar get_mr, get_mr_diff etc.',
      'Não use para procurar um MR específico — para isso use list_my_authored_mrs ou list_mrs_awaiting_my_review.',
    ].join(' '),
    schema,
    async (args) => {
      const perPage = (args.per_page as number | undefined) ?? 20;
      const { data, page } = await gl<Record<string, unknown>[]>('/projects', {
        query: {
          membership: true,
          simple: true,
          order_by: 'last_activity_at',
          sort: 'desc',
          search: args.search as string | undefined,
          per_page: perPage,
          page: (args.page as number | undefined) ?? 1,
        },
        resource: 'a lista de projetos (GET /projects)',
      });

      const items = (data ?? []).map((p) => {
        const id = p.id as number;
        const path = p.path_with_namespace as string;
        rememberProject(id, path);
        return pick(p, PROJECT_FIELDS);
      });

      return json({ ...pageBlock(perPage, page), items });
    },
  );
}
