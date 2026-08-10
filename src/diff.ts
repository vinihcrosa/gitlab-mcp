// Parser de diff unificado. Lógica pura, sem I/O — é o único ponto do MVP que
// merece teste. Se os números de linha saírem errados aqui, comment_on_mr_line
// devolve 400 e o problema parece ser da API quando é de apresentação.

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Presente em ctx e del. */
  oldLine?: number;
  /** Presente em ctx e add. */
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  /** Linha `@@ -a,b +c,d @@` original, preservada. */
  header: string;
  lines: DiffLine[];
}

export type FileStatus = 'new' | 'deleted' | 'renamed' | 'modified' | 'binary';

/** Subconjunto do que o GitLab devolve em /diffs e em changes[]. */
export interface RawDiffFile {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

export interface ParsedFile {
  /** Caminho a usar em file_path (lado novo, exceto em arquivo deletado). */
  path: string;
  oldPath: string;
  newPath: string;
  status: FileStatus;
  binary: boolean;
  /** `src/x.ts (modified)` — já pronto pro cabeçalho. */
  label: string;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isBinary(raw: RawDiffFile): boolean {
  const d = raw.diff ?? '';
  return d.startsWith('Binary files') || d.includes('GIT binary patch');
}

/**
 * Quebra a string de diff em hunks com numeração explícita.
 * Contadores reiniciam a cada `@@`. `\ No newline at end of file` não avança nada.
 */
export function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = diff.split('\n');
  // split() deixa um '' fantasma quando a string termina em \n.
  if (diff.endsWith('\n') && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      current = { header: line.replace(/\s+$/, ''), lines: [] };
      hunks.push(current);
      continue;
    }

    // Tudo antes do primeiro @@ é cabeçalho do git (--- / +++ / index / rename ...).
    // Depois do primeiro @@, '-' e '+' são sempre conteúdo.
    if (!current) continue;

    if (line.startsWith('\\')) continue; // \ No newline at end of file

    const tag = line[0];
    const text = line.slice(1);

    if (tag === '+') {
      current.lines.push({ kind: 'add', newLine: newNo++, text });
    } else if (tag === '-') {
      current.lines.push({ kind: 'del', oldLine: oldNo++, text });
    } else if (tag === ' ') {
      current.lines.push({ kind: 'ctx', oldLine: oldNo++, newLine: newNo++, text });
    } else if (line === '') {
      // Linha de contexto vazia: alguns geradores omitem o espaço do prefixo.
      current.lines.push({ kind: 'ctx', oldLine: oldNo++, newLine: newNo++, text: '' });
    }
    // Qualquer outro prefixo é ruído — ignora sem mexer nos contadores.
  }

  return hunks;
}

function statusOf(raw: RawDiffFile, binary: boolean): FileStatus {
  if (binary) return 'binary';
  if (raw.new_file) return 'new';
  if (raw.deleted_file) return 'deleted';
  if (raw.renamed_file) return 'renamed';
  return 'modified';
}

export function parseDiffFile(raw: RawDiffFile): ParsedFile {
  const newPath = raw.new_path || raw.old_path;
  const oldPath = raw.old_path || raw.new_path;
  const binary = isBinary(raw);
  const status = statusOf(raw, binary);
  const path = status === 'deleted' ? oldPath : newPath;

  let marker: string;
  switch (status) {
    case 'new':
      marker = 'new file';
      break;
    case 'deleted':
      marker = 'deleted';
      break;
    case 'renamed':
      marker = `renamed (${oldPath} → ${newPath})`;
      break;
    case 'binary':
      marker = 'binary, diff omitido';
      break;
    default:
      marker = 'modified';
  }

  return {
    path,
    oldPath,
    newPath,
    status,
    binary,
    label: `${path} (${marker})`,
    hunks: binary ? [] : parseHunks(raw.diff ?? ''),
  };
}

export function parseDiffFiles(raws: RawDiffFile[]): ParsedFile[] {
  return raws.map(parseDiffFile);
}

// --- consultas usadas na validação de comment_on_mr_line -------------------

export function addedLines(file: ParsedFile): number[] {
  const out: number[] = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newLine !== undefined) out.push(l.newLine);
  return out;
}

export function deletedLines(file: ParsedFile): number[] {
  const out: number[] = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === 'del' && l.oldLine !== undefined) out.push(l.oldLine);
  return out;
}

export interface ContextPair {
  oldLine: number;
  newLine: number;
}

export function contextPairs(file: ParsedFile): ContextPair[] {
  const out: ContextPair[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'ctx' && l.oldLine !== undefined && l.newLine !== undefined) {
        out.push({ oldLine: l.oldLine, newLine: l.newLine });
      }
    }
  }
  return out;
}

// --- renderização ---------------------------------------------------------

export interface RenderOptions {
  /** Default 400. */
  maxLinesPerFile?: number;
  /** Default 1500. */
  maxTotalLines?: number;
}

/** Linhas renderizadas de um arquivo (cabeçalhos @@ inclusos), sem o `=== ... ===`. */
export function renderBody(file: ParsedFile): string[] {
  let wOld = 0;
  let wNew = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.oldLine !== undefined) wOld = Math.max(wOld, `old=${l.oldLine}`.length);
      if (l.newLine !== undefined) wNew = Math.max(wNew, `new=${l.newLine}`.length);
    }
  }

  const out: string[] = [];
  for (const h of file.hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const o = (l.oldLine !== undefined ? `old=${l.oldLine}` : '').padEnd(wOld);
      const n = (l.newLine !== undefined ? `new=${l.newLine}` : '').padEnd(wNew);
      out.push(`  ${l.kind}  ${o} ${n} | ${l.text}`);
    }
  }
  return out;
}

/**
 * Texto final do diff. Trunca por arquivo e no total, sempre em limites de
 * linha — nunca no meio de uma.
 */
export function renderFiles(files: ParsedFile[], opts: RenderOptions = {}): string {
  const maxPerFile = opts.maxLinesPerFile ?? 400;
  const maxTotal = opts.maxTotalLines ?? 1500;

  const out: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const file of files) {
    if (file.binary) {
      out.push(`=== ${file.label} ===`, '');
      continue;
    }

    const body = renderBody(file);
    if (body.length === 0) {
      out.push(`=== ${file.label} ===`, '  (sem alterações de texto)', '');
      continue;
    }

    const budget = Math.min(maxPerFile, maxTotal - used);
    if (budget <= 0) {
      omitted.push(file.path);
      continue;
    }

    out.push(`=== ${file.label} ===`);
    const take = Math.min(budget, body.length);
    out.push(...body.slice(0, take));
    used += take;

    if (take < body.length) {
      out.push(
        `[truncado: ${body.length - take} linhas restantes neste arquivo — use path="${file.path}" para ver isolado]`,
      );
    }
    out.push('');
  }

  if (omitted.length > 0) {
    out.push(
      `[${omitted.length} arquivo(s) omitido(s) pelo limite global de ${maxTotal} linhas: ${omitted.join(', ')} — use path="<arquivo>" para ver isolado]`,
    );
  }

  return out.join('\n').replace(/\n+$/, '\n');
}
