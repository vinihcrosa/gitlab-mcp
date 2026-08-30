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

/**
 * Teto por linha renderizada, para a linha única gigante — bundle minificado,
 * lockfile, `.svg` gerado, fixture base64. Mesmo número e mesma razão do
 * `MAX_LINE_CHARS` de `src/trace.ts`: teto de linhas sozinho não segura nada
 * quando UMA linha tem megabytes.
 */
export const MAX_DIFF_LINE_CHARS = 2_000;

/**
 * Teto do corpo DEVOLVIDO, aplicado depois do teto por linha e em limite de
 * linha. O teto por linha não limita o total: 1500 linhas de 2 KB passam pelo
 * corte anterior e ainda são ~3 MB de contexto. Mesmo número do
 * `MAX_BODY_CHARS` de `src/trace.ts`.
 */
export const MAX_DIFF_BODY_CHARS = 60_000;

export interface RenderOptions {
  /** Default 400. */
  maxLinesPerFile?: number;
  /** Default 1500. */
  maxTotalLines?: number;
  /** Default MAX_DIFF_LINE_CHARS. */
  maxLineChars?: number;
  /** Default MAX_DIFF_BODY_CHARS. */
  maxBodyChars?: number;
}

/** Corta a linha renderizada e diz quanto ficou de fora. Nunca corta em silêncio. */
function capLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) return line;
  return `${line.slice(0, maxLineChars)}…[linha truncada: +${line.length - maxLineChars} chars]`;
}

/** Linhas renderizadas de um arquivo (cabeçalhos @@ inclusos), sem o `=== ... ===`. */
export function renderBody(file: ParsedFile, maxLineChars: number = MAX_DIFF_LINE_CHARS): string[] {
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
    // O cabeçalho @@ também passa pelo teto: o trecho depois do segundo @@ é
    // texto livre do arquivo e pode ser tão longo quanto qualquer linha.
    out.push(capLine(h.header, maxLineChars));
    for (const l of h.lines) {
      const o = (l.oldLine !== undefined ? `old=${l.oldLine}` : '').padEnd(wOld);
      const n = (l.newLine !== undefined ? `new=${l.newLine}` : '').padEnd(wNew);
      out.push(capLine(`  ${l.kind}  ${o} ${n} | ${l.text}`, maxLineChars));
    }
  }
  return out;
}

/**
 * Texto final do diff. Trunca por arquivo, no total de linhas e no total de
 * caracteres, sempre em limites de linha — nunca no meio de uma.
 *
 * Corte por CONTAGEM e corte por TAMANHO recebem conselhos diferentes, como em
 * `renderTrace`: pedir `path=` resolve o primeiro, mas o teto de tamanho vale
 * igual na chamada isolada, e prometer o contrário vira retry sem progresso.
 */
export function renderFiles(files: ParsedFile[], opts: RenderOptions = {}): string {
  const maxPerFile = opts.maxLinesPerFile ?? 400;
  const maxTotal = opts.maxTotalLines ?? 1500;
  const maxLineChars = opts.maxLineChars ?? MAX_DIFF_LINE_CHARS;
  const maxBodyChars = opts.maxBodyChars ?? MAX_DIFF_BODY_CHARS;

  const out: string[] = [];
  const omittedByLines: string[] = [];
  const omittedBySize: string[] = [];
  let usedLines = 0;
  let usedChars = 0;
  // Uma vez estourado o teto de tamanho, nenhum arquivo seguinte entra: um
  // cabeçalho curto ainda caberia e produziria um `=== x ===` sem corpo, que
  // lê como "arquivo sem alterações" e é mentira.
  let sizeExhausted = false;

  const push = (...lines: string[]): void => {
    for (const l of lines) {
      out.push(l);
      usedChars += l.length + 1;
    }
  };
  const fits = (line: string): boolean => usedChars + line.length + 1 <= maxBodyChars;

  for (const file of files) {
    if (sizeExhausted) {
      omittedBySize.push(file.path);
      continue;
    }

    const head = `=== ${file.label} ===`;

    if (file.binary) {
      if (!fits(head)) {
        sizeExhausted = true;
        omittedBySize.push(file.path);
        continue;
      }
      push(head, '');
      continue;
    }

    const body = renderBody(file, maxLineChars);
    if (body.length === 0) {
      if (!fits(head)) {
        sizeExhausted = true;
        omittedBySize.push(file.path);
        continue;
      }
      push(head, '  (sem alterações de texto)', '');
      continue;
    }

    const lineBudget = Math.min(maxPerFile, maxTotal - usedLines);
    if (lineBudget <= 0) {
      omittedByLines.push(file.path);
      continue;
    }
    if (!fits(head)) {
      sizeExhausted = true;
      omittedBySize.push(file.path);
      continue;
    }
    push(head);

    const wanted = Math.min(lineBudget, body.length);
    let taken = 0;
    let cutBySize = false;
    while (taken < wanted) {
      const line = body[taken]!;
      if (!fits(line)) {
        cutBySize = true;
        sizeExhausted = true;
        break;
      }
      push(line);
      taken++;
    }
    usedLines += taken;

    if (taken < body.length) {
      const rest = body.length - taken;
      // Aviso e separador contam no orçamento: são poucos chars por arquivo,
      // mas com 100 arquivos o "teto" viraria teto + 100 linhas de aviso.
      push(
        cutBySize
          ? `[truncado: ${rest} linha(s) restantes neste arquivo — limite de ${maxBodyChars} chars da resposta atingido; path="${file.path}" isola o arquivo, mas o mesmo teto de tamanho vale lá]`
          : `[truncado: ${rest} linhas restantes neste arquivo — use path="${file.path}" para ver isolado]`,
      );
    }
    push('');
  }

  if (omittedByLines.length > 0) {
    out.push(
      `[${omittedByLines.length} arquivo(s) omitido(s) pelo limite global de ${maxTotal} linhas: ${omittedByLines.join(', ')} — use path="<arquivo>" para ver isolado]`,
    );
  }

  if (omittedBySize.length > 0) {
    out.push(
      `[${omittedBySize.length} arquivo(s) omitido(s) pelo limite de ${maxBodyChars} chars da resposta: ${omittedBySize.join(', ')} — use path="<arquivo>" para ver um por vez]`,
    );
  }

  return out.join('\n').replace(/\n+$/, '\n');
}
