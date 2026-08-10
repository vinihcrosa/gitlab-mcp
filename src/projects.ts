// Resolução de projeto. O modelo passa "grupo/subgrupo/projeto", a API quer o
// path URL-encoded (barra vira %2F) ou o ID numérico. Cache em Map pra não
// gastar uma chamada extra por operação.
import { gl } from './gitlab.js';
import { GitLabError } from './errors.js';

export interface ProjectRef {
  id: number;
  path_with_namespace: string;
}

/** Chave = o que o usuário digitou (path ou id em string). */
const byInput = new Map<string, ProjectRef>();
/** Chave = id numérico. Usado para traduzir project_id -> path nas listagens globais. */
const byId = new Map<number, string>();

/** Registra um par id/path descoberto de graça (ex.: vindo de references.full de um MR). */
export function rememberProject(id: number, pathWithNamespace: string): void {
  if (!id || !pathWithNamespace) return;
  const ref: ProjectRef = { id, path_with_namespace: pathWithNamespace };
  byId.set(id, pathWithNamespace);
  byInput.set(String(id), ref);
  byInput.set(pathWithNamespace, ref);
}

export async function resolveProject(input: string): Promise<ProjectRef> {
  const key = input.trim();
  if (!key) throw new GitLabError('Parâmetro "project" vazio. Use o path (grupo/subgrupo/projeto) ou o id numérico.', 0);

  const cached = byInput.get(key);
  if (cached) return cached;

  // Só dígitos = id. Senão, path completo URL-encoded (a barra TEM que virar %2F).
  const segment = /^\d+$/.test(key) ? key : encodeURIComponent(key);

  try {
    const { data } = await gl<{ id: number; path_with_namespace: string }>(`/projects/${segment}`, {
      query: { license: false, statistics: false },
      resource: `projeto "${key}"`,
    });
    const ref: ProjectRef = { id: data.id, path_with_namespace: data.path_with_namespace };
    rememberProject(ref.id, ref.path_with_namespace);
    byInput.set(key, ref);
    return ref;
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) {
      throw new GitLabError(
        `Projeto "${key}" não encontrado ou sem acesso. Use list_my_projects para ver os disponíveis.`,
        404,
        e.body,
      );
    }
    throw e;
  }
}

/**
 * Path de um projeto a partir do id. Tenta o cache; só chama a API se preciso.
 * Se nem isso der, devolve "id:<n>" em vez de estourar a listagem inteira.
 */
export async function projectPathById(id: number): Promise<string> {
  const hit = byId.get(id);
  if (hit) return hit;
  try {
    const ref = await resolveProject(String(id));
    return ref.path_with_namespace;
  } catch {
    return `id:${id}`;
  }
}

/**
 * Deriva o path do projeto direto do payload do MR, sem chamada extra.
 * `references.full` vem como "grupo/subgrupo/projeto!123".
 */
export function projectPathFromMr(mr: {
  project_id?: number;
  web_url?: string;
  references?: { full?: string };
}): string | undefined {
  const full = mr.references?.full;
  if (full && full.includes('!')) {
    const path = full.slice(0, full.lastIndexOf('!'));
    if (path) {
      if (mr.project_id) rememberProject(mr.project_id, path);
      return path;
    }
  }
  // Fallback: https://host/grupo/proj/-/merge_requests/5
  if (mr.web_url) {
    const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(mr.web_url);
    if (m?.[1]) {
      if (mr.project_id) rememberProject(mr.project_id, m[1]);
      return m[1];
    }
  }
  return undefined;
}
