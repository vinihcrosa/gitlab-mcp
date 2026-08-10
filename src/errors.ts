/**
 * Erros que viram texto lido pelo modelo. Regra: a mensagem tem que dizer o que
 * fazer em seguida. Stack trace não ajuda o modelo a se corrigir.
 */

/** Falha vinda da API do GitLab, já traduzida. `body` guarda o corpo cru. */
export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

/** Falha detectada localmente (validação, read-only, input incoerente). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function messageOf(e: unknown): string {
  if (e instanceof GitLabError || e instanceof ToolError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
