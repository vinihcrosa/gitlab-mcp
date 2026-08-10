// As três tools de escrita. Todas passam por assertWritable() antes de tocar na rede.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gl } from '../gitlab.js';
import { GitLabError, ToolError } from '../errors.js';
import { json } from '../format.js';
import { resolveProject } from '../projects.js';
import { addedLines, contextPairs, deletedLines, parseDiffFiles, type ParsedFile } from '../diff.js';
import { fetchMr } from './mrs.js';
import { loadAllDiffFiles, matchesPath } from './diff.js';
import { assertWritable, tool } from './register.js';

interface NoteResponse {
  id: number;
}

interface DiscussionResponse {
  id: string;
  notes?: NoteResponse[];
}

function listNumbers(ns: number[], max = 60): string {
  if (ns.length === 0) return '(nenhuma)';
  const shown = ns.slice(0, max).join(', ');
  return ns.length > max ? `${shown} (+${ns.length - max} outras)` : shown;
}

/** position[] do GitLab. Chave ausente ≠ chave com null — o GitLab rejeita null. */
interface TextPosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line?: number;
  old_line?: number;
}

const commentSchema = {
  project: z.string().describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico.'),
  iid: z.number().int().min(1).describe('O iid do MR — o número que aparece na URL. NÃO é o id global.'),
  body: z.string().min(1).describe('Texto do comentário, em Markdown. Não pode ser vazio.'),
};

const lineSchema = {
  project: z.string().describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico.'),
  iid: z.number().int().min(1).describe('O iid do MR — o número que aparece na URL. NÃO é o id global.'),
  body: z.string().min(1).describe('Texto do comentário, em Markdown. Não pode ser vazio.'),
  file_path: z
    .string()
    .min(1)
    .describe('Caminho do arquivo exatamente como aparece no cabeçalho "=== ... ===" de get_mr_diff.'),
  line: z
    .number()
    .int()
    .min(1)
    .describe(
      'Número da linha. Para side="new" e side="context", é o número new= impresso por get_mr_diff. Para side="old", é o old=.',
    ),
  side: z
    .enum(['new', 'old', 'context'])
    .describe(
      'new = linha adicionada (verde, prefixo "add" no get_mr_diff); old = linha removida (vermelha, prefixo "del"); context = linha não modificada (prefixo "ctx").',
    ),
  context_old_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Obrigatório quando side="context": o número old= da mesma linha ctx no get_mr_diff. Comentário em linha de contexto exige os dois lados.',
    ),
};

const replySchema = {
  project: z.string().describe('Path completo do projeto (ex.: "grupo/subgrupo/projeto") ou o id numérico.'),
  iid: z.number().int().min(1).describe('O iid do MR — o número que aparece na URL. NÃO é o id global.'),
  discussion_id: z
    .string()
    .min(1)
    .describe('O discussion_id da thread, exatamente como veio de list_mr_discussions.'),
  body: z.string().min(1).describe('Texto da resposta, em Markdown. Não pode ser vazio.'),
};

function findFile(files: ParsedFile[], filePath: string): ParsedFile {
  const hit = files.find((f) => matchesPath(f, filePath));
  if (hit) return hit;
  const names = files.map((f) => f.path);
  const shown = names.slice(0, 40).join(', ');
  const more = names.length > 40 ? ` (+${names.length - 40} outros)` : '';
  throw new ToolError(
    `Arquivo "${filePath}" não faz parte deste MR. Arquivos no diff: ${shown}${more}. Confira com get_mr_diff.`,
  );
}

export function registerWrite(server: McpServer): void {
  tool(
    server,
    'comment_on_mr',
    [
      'Publica um comentário geral no merge request, sem âncora em código.',
      'Use para resumo de review, dúvida ampla ou aprovação informal.',
      'Para comentar numa linha específica do diff use comment_on_mr_line; para responder numa thread existente use reply_to_mr_discussion.',
      'Requer GITLAB_READ_ONLY=false e token com escopo api.',
    ].join(' '),
    commentSchema,
    async (args) => {
      assertWritable();
      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const mr = await fetchMr(project.id, iid, project.path_with_namespace);
      const body = args.body as string;

      const { data } = await gl<NoteResponse>(`/projects/${project.id}/merge_requests/${iid}/notes`, {
        method: 'POST',
        body: { body },
        resource: `comentar no MR !${iid} de ${project.path_with_namespace}`,
      });

      return json({
        note_id: data.id,
        web_url: `${mr.web_url}#note_${data.id}`,
        body,
      });
    },
  );

  tool(
    server,
    'comment_on_mr_line',
    [
      'Cria uma thread de review ancorada numa linha específica do diff do merge request.',
      'Chame get_mr_diff antes: os números old=/new= de lá são exatamente o que esta tool espera, e ela valida localmente antes de postar.',
      'Para linha de contexto (prefixo "ctx"), passe side="context" com line = new= e context_old_line = old=; os dois são obrigatórios.',
      'Só suporta comentário em linha única — comentário multi-linha está fora de escopo neste MVP.',
      'Requer GITLAB_READ_ONLY=false e token com escopo api.',
    ].join(' '),
    lineSchema,
    async (args) => {
      assertWritable();

      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const label = project.path_with_namespace;
      const filePath = args.file_path as string;
      const line = args.line as number;
      const side = args.side as 'new' | 'old' | 'context';
      const contextOldLine = args.context_old_line as number | undefined;
      const body = args.body as string;

      // diff_refs SEMPRE fresco: se alguém deu push desde a última leitura, os
      // shas mudaram e a posição fica inválida. Por isso não são parâmetro.
      const mr = await fetchMr(project.id, iid, label);
      const refs = mr.diff_refs;
      if (!refs) {
        throw new ToolError(
          `MR !${iid} de ${label} não tem diff_refs (diff indisponível). Não dá para ancorar comentário em linha; use comment_on_mr.`,
        );
      }

      // Validação local: erro de API que o modelo não sabe corrigir vira loop de retry.
      const files = parseDiffFiles(await loadAllDiffFiles(project.id, iid, label));
      const file = findFile(files, filePath);
      if (file.binary) {
        throw new ToolError(`Arquivo "${filePath}" é binário neste MR — não há linha para ancorar. Use comment_on_mr.`);
      }

      const position: TextPosition = {
        position_type: 'text',
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        // Os dois caminhos vão sempre, mesmo iguais. Omitir um falha em vários cenários.
        old_path: file.oldPath,
        new_path: file.newPath,
      };

      if (side === 'new') {
        const added = addedLines(file);
        if (!added.includes(line)) {
          throw new ToolError(
            `Linha ${line} de ${filePath} não aparece como linha adicionada neste diff. Linhas adicionadas: ${listNumbers(added)}.`,
          );
        }
        position.new_line = line;
      } else if (side === 'old') {
        const removed = deletedLines(file);
        if (!removed.includes(line)) {
          throw new ToolError(
            `Linha ${line} de ${filePath} não aparece como linha removida neste diff. Linhas removidas: ${listNumbers(removed)}.`,
          );
        }
        position.old_line = line;
      } else {
        const pairs = contextPairs(file);
        const pair = pairs.find((p) => p.newLine === line);
        if (!pair) {
          throw new ToolError(
            `Linha ${line} de ${filePath} não aparece como linha de contexto (não modificada) neste diff. Linhas de contexto (new=): ${listNumbers(
              pairs.map((p) => p.newLine),
            )}.`,
          );
        }
        if (contextOldLine === undefined) {
          throw new ToolError(
            `side="context" exige context_old_line. Para new=${line} em ${filePath}, o valor correto é context_old_line=${pair.oldLine} (veja a coluna old= em get_mr_diff).`,
          );
        }
        if (contextOldLine !== pair.oldLine) {
          throw new ToolError(
            `context_old_line=${contextOldLine} não bate com o diff: para new=${line} em ${filePath} o old= é ${pair.oldLine}.`,
          );
        }
        position.new_line = pair.newLine;
        position.old_line = pair.oldLine;
      }

      const payload = { body, position };

      let data: DiscussionResponse;
      try {
        const res = await gl<DiscussionResponse>(`/projects/${project.id}/merge_requests/${iid}/discussions`, {
          method: 'POST',
          body: payload,
          resource: `criar discussion em ${filePath}:${line} do MR !${iid} de ${label}`,
        });
        data = res.data;
      } catch (e) {
        if (e instanceof GitLabError && e.status === 400) {
          // Repassa a mensagem do GitLab na íntegra + o payload enviado: é o que
          // permite o modelo se corrigir sozinho.
          throw new ToolError(
            `${e.message}\nResposta crua do GitLab: ${e.body ?? '(vazia)'}\nPayload enviado: ${JSON.stringify(payload)}`,
          );
        }
        throw e;
      }

      const noteId = data.notes?.[0]?.id;
      return json({
        discussion_id: data.id,
        note_id: noteId ?? null,
        web_url: noteId ? `${mr.web_url}#note_${noteId}` : mr.web_url,
        position_used: position,
      });
    },
  );

  tool(
    server,
    'reply_to_mr_discussion',
    [
      'Responde numa thread de comentário já existente do merge request.',
      'Pegue o discussion_id em list_mr_discussions. Fecha o loop: ler threads, responder.',
      'Para abrir uma thread nova numa linha use comment_on_mr_line; para comentário solto use comment_on_mr.',
      'Requer GITLAB_READ_ONLY=false e token com escopo api.',
    ].join(' '),
    replySchema,
    async (args) => {
      assertWritable();
      const project = await resolveProject(args.project as string);
      const iid = args.iid as number;
      const discussionId = args.discussion_id as string;
      const body = args.body as string;

      const mr = await fetchMr(project.id, iid, project.path_with_namespace);

      const { data } = await gl<NoteResponse>(
        `/projects/${project.id}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
        {
          method: 'POST',
          body: { body },
          resource: `responder na discussion ${discussionId} do MR !${iid} de ${project.path_with_namespace}`,
        },
      );

      return json({
        note_id: data.id,
        web_url: `${mr.web_url}#note_${data.id}`,
      });
    },
  );
}
