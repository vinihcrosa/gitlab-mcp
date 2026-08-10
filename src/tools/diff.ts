import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gl, log, type Page } from '../gitlab.js';
import { GitLabError } from '../errors.js';
import { parseDiffFiles, renderFiles, type ParsedFile, type RawDiffFile } from '../diff.js';
import { resolveProject } from '../projects.js';
import { fetchMr } from './mrs.js';
import { tool } from './register.js';

/** GitLab < 15.7 não tem /diffs. Detectado por 404 uma vez e lembrado. */
let diffsEndpointMissing = false;

interface DiffPage {
  files: RawDiffFile[];
  page: Page;
}

async function viaChanges(projectId: number, iid: number, label: string, page: number, perPage: number): Promise<DiffPage> {
  const { data } = await gl<{ changes?: RawDiffFile[] }>(`/projects/${projectId}/merge_requests/${iid}/changes`, {
    resource: `o diff do MR !${iid} de ${label} (fallback GET /changes)`,
  });
  const all = data?.changes ?? [];
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  return {
    files: slice,
    page: { page, totalPages, nextPage: page < totalPages ? page + 1 : 0 },
  };
}

/** Uma página de arquivos do diff, com fallback automático para /changes. */
export async function loadDiffPage(
  projectId: number,
  iid: number,
  label: string,
  page: number,
  perPage: number,
): Promise<DiffPage> {
  if (diffsEndpointMissing) return viaChanges(projectId, iid, label, page, perPage);

  try {
    const res = await gl<RawDiffFile[]>(`/projects/${projectId}/merge_requests/${iid}/diffs`, {
      query: { page, per_page: perPage },
      resource: `o diff do MR !${iid} de ${label}`,
    });
    return { files: res.data ?? [], page: res.page };
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) {
      diffsEndpointMissing = true;
      log('endpoint /diffs devolveu 404 (GitLab < 15.7?). Usando fallback GET /changes daqui em diante.');
      return viaChanges(projectId, iid, label, page, perPage);
    }
    throw e;
  }
}

const MAX_SCAN_PAGES = 3;

/** Varre até 3 páginas de 100 arquivos. Usado quando o path importa (filtro e validação). */
export async function loadAllDiffFiles(projectId: number, iid: number, label: string): Promise<RawDiffFile[]> {
  const out: RawDiffFile[] = [];
  for (let p = 1; p <= MAX_SCAN_PAGES; p++) {
    const { files, page } = await loadDiffPage(projectId, iid, label, p, 100);
    out.push(...files);
    const next = page.nextPage;
    if (!next || next <= 0 || files.length === 0) break;
    if (p === MAX_SCAN_PAGES) {
      log(`MR !${iid} de ${label} tem mais de ${MAX_SCAN_PAGES * 100} arquivos; varredura parou aí.`);
    }
  }
  return out;
}

export function matchesPath(f: ParsedFile, path: string): boolean {
  return f.path === path || f.newPath === path || f.oldPath === path;
}

const schema = {
  project: z.string().describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico.'),
  iid: z.number().int().min(1).describe('O iid do MR — o número que aparece na URL. NÃO é o id global.'),
  path: z
    .string()
    .optional()
    .describe('Caminho de um arquivo para ver isolado (ex.: "src/auth/session.ts"). Use quando a saída vier truncada.'),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Arquivos por página. Default 10. Ignorado quando "path" é informado.'),
  page: z.number().int().min(1).optional().describe('Página de arquivos, começando em 1. Default 1.'),
};

export function registerDiff(server: McpServer): void {
  tool(
    server,
    'get_mr_diff',
    [
      'Diff do merge request em texto, com o número de linha de cada lado impresso explicitamente (old=/new=).',
      'Use antes de comentar em linha: os números old= e new= que aparecem aqui são exatamente os que comment_on_mr_line espera.',
      'Prefixos: "add" = linha só no lado novo, "del" = linha só no antigo, "ctx" = linha inalterada (tem os dois números).',
      'Se a saída vier truncada, chame de novo com path="<arquivo>" para ver aquele arquivo inteiro.',
      'Não use para ler o arquivo completo do repositório — só mostra o que mudou no MR.',
    ].join(' '),
    schema,
    async (args) => {
      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const label = project.path_with_namespace;
      const wantedPath = args.path as string | undefined;
      const perPage = (args.per_page as number | undefined) ?? 10;
      const pageNum = (args.page as number | undefined) ?? 1;

      let parsed: ParsedFile[];
      let header: string;

      if (wantedPath) {
        const all = parseDiffFiles(await loadAllDiffFiles(project.id, iid, label));
        parsed = all.filter((f) => matchesPath(f, wantedPath));
        if (parsed.length === 0) {
          const names = all.map((f) => f.path);
          const shown = names.slice(0, 40).join(', ');
          const more = names.length > 40 ? ` (+${names.length - 40} outros)` : '';
          return `Arquivo "${wantedPath}" não aparece no diff do MR !${iid} de ${label}. Arquivos no diff: ${shown}${more}`;
        }
        header = `MR ${label}!${iid} — arquivo isolado: ${wantedPath}`;
      } else {
        const { files, page } = await loadDiffPage(project.id, iid, label, pageNum, perPage);
        parsed = parseDiffFiles(files);
        const hasMore = typeof page.nextPage === 'number' && page.nextPage > 0;
        header =
          `MR ${label}!${iid} — ${parsed.length} arquivo(s) nesta página ` +
          `(page=${page.page ?? pageNum}, per_page=${perPage}, total_pages=${page.totalPages ?? '?'}` +
          `${hasMore ? `, há mais: use page=${page.nextPage}` : ', última página'})`;
      }

      const body =
        parsed.length === 0 ? '(nenhum arquivo alterado nesta página)' : renderFiles(parsed, { maxLinesPerFile: 400, maxTotalLines: 1500 });

      const mr = await fetchMr(project.id, iid, label);
      const refs = mr.diff_refs;
      const refsBlock = refs
        ? [
            'diff_refs (é isto que comment_on_mr_line usa — não precisa passar, a tool busca sozinha):',
            `  base_sha  = ${refs.base_sha}`,
            `  start_sha = ${refs.start_sha}`,
            `  head_sha  = ${refs.head_sha}`,
          ].join('\n')
        : 'diff_refs = null — este MR não tem posição de diff válida; comment_on_mr_line não vai funcionar aqui.';

      return `${header}\n\n${body}\n${refsBlock}`;
    },
  );
}
