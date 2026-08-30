// Projeção e marcação de merge request. Lógica pura, sem I/O — mesmo corte de
// diff.ts, trace.ts e pipelines.ts. É o que deixa a regra de marcação abaixo
// verificável com literal, sem fixture de rede.

import {
  inlineUntrusted,
  truncate,
  untrusted,
  username,
  usernames,
} from './format.js';

/**
 * REGRA ÚNICA DE MARCAÇÃO — vale aqui e em `src/pipelines.ts`.
 *
 * Texto escrito por quem abriu o MR é dado, nunca instrução, e isso não muda
 * conforme a tool por onde ele sai. Título e nomes de branch são dessa classe:
 * o autor do MR escolhe os três, e `source_branch` é literalmente a mesma
 * string que volta como `ref` da pipeline — onde já era marcada. Marcar num
 * módulo e não no outro não é decisão, é inconsistência; era o estado anterior
 * deste arquivo (issue #11).
 *
 * A forma é inline, não envelope: estes campos saem como VALOR de JSON, no meio
 * de uma linha que o servidor escreveu. `inlineUntrusted()` neutraliza ANSI,
 * quebra de linha e o delimitador; `INLINE_UNTRUSTED_NOTE` é o que diz ao
 * modelo que aquilo é dado. Descrição de MR e corpo de nota continuam em
 * envelope `untrusted()` — são blocos, ocupam linhas próprias.
 */
export const MR_FREE_TEXT_KEYS = ['title', 'source_branch', 'target_branch'] as const;

export type MrFreeTextKey = (typeof MR_FREE_TEXT_KEYS)[number];

/**
 * Teto do GitLab para título de MR e para nome de ref. Nome de branch real
 * nunca é cortado aqui — e ref não aceita espaço nem caractere de controle,
 * então `list_pipelines(ref=…)` continua recebendo a string exata que leu.
 */
const MAX_MR_FREE_TEXT = 255;

/**
 * Só as chaves de texto livre, já marcadas. Chave ausente ou null na origem
 * continua ausente — mesma semântica de `pick()`, e evita inventar `title: ""`
 * para um MR que veio sem título.
 */
export function mrFreeText(mr: Record<string, unknown>): Partial<Record<MrFreeTextKey, string>> {
  const out: Partial<Record<MrFreeTextKey, string>> = {};
  for (const k of MR_FREE_TEXT_KEYS) {
    const v = mr[k];
    if (v === undefined || v === null) continue;
    out[k] = inlineUntrusted(String(v), MAX_MR_FREE_TEXT);
  }
  return out;
}

/**
 * Chaves de listagem escritas pelo servidor — GitLab ou este processo — e que
 * por isso NÃO passam por marcação. `author`/`reviewers` saem como username,
 * que o GitLab restringe a um charset seguro.
 *
 * Esta lista mais `MR_FREE_TEXT_KEYS` tem que cobrir toda chave da saída: é
 * disso que o teste de guarda vive. Campo novo entra classificado, ou quebra.
 */
export const MR_LIST_SERVER_KEYS = [
  'project_path',
  'iid',
  'web_url',
  'draft',
  'updated_at',
  'reviewers',
  'merge_status',
  'author',
] as const;

/** Idem, para `get_mr`. `description` é envelope, não inline — mas é marcada. */
export const MR_GET_SERVER_KEYS = [
  'project_path',
  'iid',
  'description',
  'state',
  'draft',
  'author',
  'reviewers',
  'assignees',
  'web_url',
  'created_at',
  'updated_at',
  'merge_status',
  'has_conflicts',
  'changes_count',
  'diff_refs',
  'pipeline_status',
  'diff_refs_note',
] as const;

/**
 * Item de listagem. `description` fica de fora de propósito — só em `get_mr`.
 * `author` só entra em list_mrs_awaiting_my_review, onde a autoria é a
 * informação que falta; na listagem do próprio usuário seria sempre ele.
 */
export function listItemView(
  mr: Record<string, unknown>,
  projectPath: string | undefined,
  includeAuthor = false,
): Record<string, unknown> {
  const free = mrFreeText(mr);
  return {
    project_path: projectPath,
    iid: mr.iid,
    title: free.title,
    web_url: mr.web_url,
    source_branch: free.source_branch,
    target_branch: free.target_branch,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    updated_at: mr.updated_at,
    reviewers: usernames(mr.reviewers),
    merge_status: mr.merge_status ?? mr.detailed_merge_status,
    ...(includeAuthor ? { author: username(mr.author) } : {}),
  };
}

export function getMrView(mr: Record<string, unknown>, projectPath: string): Record<string, unknown> {
  const pipeline = (mr.head_pipeline ?? mr.pipeline) as { status?: string } | null | undefined;
  const refs = mr.diff_refs ?? null;
  const free = mrFreeText(mr);

  const out: Record<string, unknown> = {
    project_path: projectPath,
    iid: mr.iid,
    title: free.title,
    description: untrusted('mr_description', truncate(mr.description as string | null, 4000)),
    state: mr.state,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    author: username(mr.author),
    reviewers: usernames(mr.reviewers),
    assignees: usernames(mr.assignees),
    source_branch: free.source_branch,
    target_branch: free.target_branch,
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

  return out;
}
