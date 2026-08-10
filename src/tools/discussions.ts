import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gl } from '../gitlab.js';
import { json, pageBlock, truncate, untrusted, username, withUntrustedNote } from '../format.js';
import { resolveProject } from '../projects.js';
import { tool } from './register.js';

interface RawNote {
  id: number;
  body?: string;
  author?: { username?: string };
  created_at?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number | null;
    old_line?: number | null;
  };
}

interface RawDiscussion {
  id: string;
  notes?: RawNote[];
}

const schema = {
  project: z.string().describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico.'),
  iid: z.number().int().min(1).describe('O iid do MR — o número que aparece na URL. NÃO é o id global.'),
  include_resolved: z
    .boolean()
    .optional()
    .describe('Inclui threads já resolvidas. Default false — normalmente só interessa o que está em aberto.'),
  per_page: z.number().int().min(1).max(100).optional().describe('Threads por página. Default 20, máximo 100.'),
  page: z.number().int().min(1).optional().describe('Página, começando em 1. Default 1.'),
};

export function registerDiscussions(server: McpServer): void {
  tool(
    server,
    'list_mr_discussions',
    [
      'Lista as threads de comentário de um merge request, com o discussion_id de cada uma e a posição no diff quando o comentário está ancorado em código.',
      'Use para ver o que já foi comentado antes de comentar de novo, e para pegar o discussion_id que reply_to_mr_discussion precisa.',
      'Notas de sistema ("changed target branch", "assigned to...") são filtradas — não aparecem aqui.',
    ].join(' '),
    schema,
    async (args) => {
      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const perPage = (args.per_page as number | undefined) ?? 20;
      const includeResolved = (args.include_resolved as boolean | undefined) ?? false;

      const { data, page } = await gl<RawDiscussion[]>(
        `/projects/${project.id}/merge_requests/${iid}/discussions`,
        {
          query: { per_page: perPage, page: (args.page as number | undefined) ?? 1 },
          resource: `as discussions do MR !${iid} de ${project.path_with_namespace}`,
        },
      );

      const items: Record<string, unknown>[] = [];
      for (const d of data ?? []) {
        const notes = (d.notes ?? []).filter((n) => n.system !== true);
        if (notes.length === 0) continue;

        const resolvable = notes.filter((n) => n.resolvable === true);
        const resolved = resolvable.length > 0 && resolvable.every((n) => n.resolved === true);
        if (resolved && !includeResolved) continue;

        const pos = notes.find((n) => n.position)?.position;

        items.push({
          discussion_id: d.id,
          resolved,
          ...(pos
            ? {
                position: {
                  new_path: pos.new_path,
                  old_path: pos.old_path,
                  new_line: pos.new_line ?? null,
                  old_line: pos.old_line ?? null,
                },
              }
            : {}),
          notes: notes.map((n) => ({
            author: username(n.author),
            created_at: n.created_at,
            body: untrusted('mr_note', truncate(n.body, 1500)),
          })),
        });
      }

      return withUntrustedNote(
        json({
          project_path: project.path_with_namespace,
          iid,
          include_resolved: includeResolved,
          ...pageBlock(perPage, page),
          items,
        }),
      );
    },
  );
}
