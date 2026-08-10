import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gl } from '../gitlab.js';
import { json, pageBlock, truncate, untrusted, username, usernames, withUntrustedNote } from '../format.js';
import { projectPathById, projectPathFromMr, resolveProject } from '../projects.js';
import { getMe } from './whoami.js';
import { tool } from './register.js';

export interface DiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface MrPayload extends Record<string, unknown> {
  id: number;
  iid: number;
  project_id: number;
  web_url: string;
  diff_refs?: DiffRefs | null;
}

/** GET de um MR pelo iid. `iid` é o número que aparece na URL, não o `id` global. */
export async function fetchMr(projectId: number, iid: number, projectLabel: string): Promise<MrPayload> {
  const { data } = await gl<MrPayload>(`/projects/${projectId}/merge_requests/${iid}`, {
    resource: `o MR !${iid} de ${projectLabel}`,
  });
  return data;
}

// Whitelist de listagem. `description` fica de fora de propósito — só em get_mr.
async function listItem(mr: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectPath =
    projectPathFromMr(mr as never) ?? (await projectPathById(mr.project_id as number));
  return {
    project_path: projectPath,
    iid: mr.iid,
    title: mr.title,
    web_url: mr.web_url,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    updated_at: mr.updated_at,
    reviewers: usernames(mr.reviewers),
    merge_status: mr.merge_status ?? mr.detailed_merge_status,
  };
}

const listSchema = {
  state: z
    .enum(['opened', 'merged', 'closed', 'all'])
    .optional()
    .describe('Estado dos MRs. Default "opened". Use "all" só quando precisar de histórico.'),
  per_page: z.number().int().min(1).max(100).optional().describe('Itens por página. Default 20, máximo 100.'),
  page: z.number().int().min(1).optional().describe('Página, começando em 1. Default 1.'),
};

const reviewSchema = {
  per_page: z.number().int().min(1).max(100).optional().describe('Itens por página. Default 20, máximo 100.'),
  page: z.number().int().min(1).optional().describe('Página, começando em 1. Default 1.'),
};

const getSchema = {
  project: z
    .string()
    .describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico. Pegue em list_my_projects.'),
  iid: z
    .number()
    .int()
    .min(1)
    .describe('O iid do MR — o número que aparece na URL (/-/merge_requests/123). NÃO é o id global do MR.'),
};

export function registerMrs(server: McpServer): void {
  tool(
    server,
    'list_my_authored_mrs',
    [
      'Lista os merge requests que VOCÊ criou, atravessando todos os projetos a que tem acesso.',
      'Use para responder "quais MRs eu abri" ou "o que ainda está em aberto meu".',
      'Não use para MRs em que você é reviewer — para isso use list_mrs_awaiting_my_review.',
      'A descrição do MR não vem aqui; use get_mr quando precisar dela.',
    ].join(' '),
    listSchema,
    async (args) => {
      const perPage = (args.per_page as number | undefined) ?? 20;
      const { data, page } = await gl<Record<string, unknown>[]>('/merge_requests', {
        query: {
          scope: 'created_by_me',
          state: (args.state as string | undefined) ?? 'opened',
          per_page: perPage,
          page: (args.page as number | undefined) ?? 1,
        },
        resource: 'a lista global de MRs (GET /merge_requests)',
      });

      const items = [];
      for (const mr of data ?? []) items.push(await listItem(mr));
      return json({ ...pageBlock(perPage, page), items });
    },
  );

  tool(
    server,
    'list_mrs_awaiting_my_review',
    [
      'Lista os merge requests abertos em que VOCÊ está como reviewer (não assignee) — ou seja, o que está esperando review seu.',
      'Este é o ponto de partida do fluxo de review: use esta tool, depois get_mr, depois get_mr_diff.',
      'Não precisa passar seu username: a tool descobre sozinha pelo token.',
    ].join(' '),
    reviewSchema,
    async (args) => {
      const me = await getMe();
      const perPage = (args.per_page as number | undefined) ?? 20;
      const { data, page } = await gl<Record<string, unknown>[]>('/merge_requests', {
        query: {
          // scope=all é obrigatório: o default do endpoint global é created_by_me,
          // o que devolveria só a interseção "criei E sou reviewer" (quase sempre vazio).
          scope: 'all',
          state: 'opened',
          // reviewer_username != assignee. São campos diferentes no GitLab.
          reviewer_username: me.username,
          per_page: perPage,
          page: (args.page as number | undefined) ?? 1,
        },
        resource: `os MRs aguardando review de @${me.username}`,
      });

      const items = [];
      for (const mr of data ?? []) {
        items.push({ ...(await listItem(mr)), author: username(mr.author) });
      }
      return json({ reviewer: me.username, ...pageBlock(perPage, page), items });
    },
  );

  tool(
    server,
    'get_mr',
    [
      'Detalhe completo de um merge request: título, descrição, branches, reviewers, status de merge e diff_refs.',
      'Use depois de localizar o MR numa listagem, antes de ler o diff.',
      'O parâmetro iid é o número da URL do MR, não o id global.',
      'diff_refs (base_sha/start_sha/head_sha) sai daqui e é o que comment_on_mr_line precisa.',
    ].join(' '),
    getSchema,
    async (args) => {
      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const mr = await fetchMr(project.id, iid, project.path_with_namespace);

      const pipeline = (mr.head_pipeline ?? mr.pipeline) as { status?: string } | null | undefined;
      const refs = mr.diff_refs ?? null;

      const out: Record<string, unknown> = {
        project_path: project.path_with_namespace,
        iid: mr.iid,
        title: mr.title,
        description: untrusted('mr_description', truncate(mr.description as string | null, 4000)),
        state: mr.state,
        draft: mr.draft ?? mr.work_in_progress ?? false,
        author: username(mr.author),
        reviewers: usernames(mr.reviewers),
        assignees: usernames(mr.assignees),
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        web_url: mr.web_url,
        created_at: mr.created_at,
        updated_at: mr.updated_at,
        merge_status: mr.merge_status ?? mr.detailed_merge_status,
        has_conflicts: mr.has_conflicts ?? null,
        changes_count: mr.changes_count ?? null,
        diff_refs: refs,
        pipeline_status: pipeline?.status ?? null,
      };

      if (!refs) {
        out.diff_refs_note =
          'diff_refs veio null — este MR não tem diff utilizável (sem commits ou ainda sendo preparado). comment_on_mr_line não vai funcionar aqui; use comment_on_mr.';
      }

      return withUntrustedNote(json(out));
    },
  );
}
