import { describe, expect, it } from 'vitest';
import {
  addedLines,
  contextPairs,
  deletedLines,
  parseDiffFile,
  parseHunks,
  renderFiles,
  type RawDiffFile,
} from '../src/diff.js';

/** Monta a string de diff com os prefixos explícitos, sem depender de indentação do arquivo. */
const d = (...lines: string[]): string => lines.join('\n') + '\n';

describe('1. hunk simples com add, del e ctx misturados', () => {
  const raw: RawDiffFile = {
    old_path: 'src/auth/session.ts',
    new_path: 'src/auth/session.ts',
    diff: d(
      '@@ -10,7 +10,9 @@',
      ' export function createSession(user: User) {',
      '   const id = randomUUID();',
      '-  const ttl = 3600;',
      '+  const ttl = config.sessionTtl;',
      "+  logger.debug({ id, ttl }, 'session created');",
      '   return { id, ttl };',
    ),
  };

  it('numera os dois lados corretamente', () => {
    const file = parseDiffFile(raw);
    expect(file.status).toBe('modified');
    expect(file.hunks).toHaveLength(1);

    const lines = file.hunks[0]!.lines;
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 10, 10],
      ['ctx', 11, 11],
      ['del', 12, undefined],
      ['add', undefined, 12],
      ['add', undefined, 13],
      ['ctx', 13, 14],
    ]);
  });

  it('expõe as listas usadas na validação de comment_on_mr_line', () => {
    const file = parseDiffFile(raw);
    expect(addedLines(file)).toEqual([12, 13]);
    expect(deletedLines(file)).toEqual([12]);
    expect(contextPairs(file)).toEqual([
      { oldLine: 10, newLine: 10 },
      { oldLine: 11, newLine: 11 },
      { oldLine: 13, newLine: 14 },
    ]);
  });

  it('renderiza com os números visíveis em cada linha', () => {
    const out = renderFiles([parseDiffFile(raw)]);
    expect(out).toContain('=== src/auth/session.ts (modified) ===');
    expect(out).toContain('@@ -10,7 +10,9 @@');
    expect(out).toContain('  ctx  old=10 new=10 | export function createSession(user: User) {');
    expect(out).toContain('  del  old=12        |   const ttl = 3600;');
    expect(out).toContain('  add         new=12 |   const ttl = config.sessionTtl;');
    expect(out).toContain('  ctx  old=13 new=14 |   return { id, ttl };');
  });
});

describe('2. múltiplos hunks no mesmo arquivo', () => {
  const file = parseDiffFile({
    old_path: 'a.ts',
    new_path: 'a.ts',
    diff: d(
      '@@ -1,3 +1,3 @@',
      ' um',
      '-dois',
      '+DOIS',
      ' tres',
      '@@ -100,4 +100,5 @@ class Foo {',
      ' cem',
      '+cem-e-meio',
      ' cento-e-um',
      '-cento-e-dois',
    ),
  });

  it('reinicia os contadores em cada @@', () => {
    expect(file.hunks).toHaveLength(2);

    expect(file.hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['ctx', 3, 3],
    ]);

    expect(file.hunks[1]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 100, 100],
      ['add', undefined, 101],
      ['ctx', 101, 102],
      ['del', 102, undefined],
    ]);
  });

  it('preserva o texto do cabeçalho do hunk', () => {
    expect(file.hunks[1]!.header).toBe('@@ -100,4 +100,5 @@ class Foo {');
  });
});

describe('3. arquivo novo', () => {
  const file = parseDiffFile({
    old_path: 'src/novo.ts',
    new_path: 'src/novo.ts',
    new_file: true,
    diff: d('@@ -0,0 +1,3 @@', '+linha 1', '+linha 2', '+linha 3'),
  });

  it('marca new file e nunca tem old_line', () => {
    expect(file.status).toBe('new');
    expect(file.label).toBe('src/novo.ts (new file)');

    const lines = file.hunks[0]!.lines;
    expect(lines.every((l) => l.kind === 'add')).toBe(true);
    expect(lines.every((l) => l.oldLine === undefined)).toBe(true);
    expect(addedLines(file)).toEqual([1, 2, 3]);
    expect(deletedLines(file)).toEqual([]);
  });

  it('não imprime coluna old= quando não há nenhuma', () => {
    const out = renderFiles([file]);
    expect(out).toContain('  add   new=1 | linha 1');
    expect(out).not.toContain('old=');
  });
});

describe('4. arquivo deletado', () => {
  const file = parseDiffFile({
    old_path: 'src/velho.ts',
    new_path: 'src/velho.ts',
    deleted_file: true,
    diff: d('@@ -1,2 +0,0 @@', '-adeus', '-mundo'),
  });

  it('marca deleted e nunca tem new_line', () => {
    expect(file.status).toBe('deleted');
    expect(file.label).toBe('src/velho.ts (deleted)');
    expect(file.path).toBe('src/velho.ts');

    const lines = file.hunks[0]!.lines;
    expect(lines.every((l) => l.kind === 'del')).toBe(true);
    expect(lines.every((l) => l.newLine === undefined)).toBe(true);
    expect(deletedLines(file)).toEqual([1, 2]);
    expect(addedLines(file)).toEqual([]);
  });
});

describe('5. arquivo renomeado', () => {
  const file = parseDiffFile({
    old_path: 'src/antigo.ts',
    new_path: 'src/novo.ts',
    renamed_file: true,
    diff: d('@@ -1,2 +1,2 @@', ' mantida', '-mudou', '+mudou!'),
  });

  it('mostra origem e destino no cabeçalho', () => {
    expect(file.status).toBe('renamed');
    expect(file.oldPath).toBe('src/antigo.ts');
    expect(file.newPath).toBe('src/novo.ts');
    expect(file.label).toBe('src/novo.ts (renamed (src/antigo.ts → src/novo.ts))');
    expect(renderFiles([file])).toContain('=== src/novo.ts (renamed (src/antigo.ts → src/novo.ts)) ===');
  });

  it('ainda parseia o diff do conteúdo', () => {
    expect(addedLines(file)).toEqual([2]);
    expect(deletedLines(file)).toEqual([2]);
  });
});

describe('6. "\\ No newline at end of file"', () => {
  const hunks = parseHunks(
    d(
      '@@ -1,3 +1,3 @@',
      ' alfa',
      '-beta',
      '\\ No newline at end of file',
      '+beta!',
      '\\ No newline at end of file',
      ' gama',
    ),
  );

  it('é ignorado e não desloca a numeração', () => {
    expect(hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['ctx', 1, 1, 'alfa'],
      ['del', 2, undefined, 'beta'],
      ['add', undefined, 2, 'beta!'],
      ['ctx', 3, 3, 'gama'],
    ]);
  });
});

describe('7. truncamento por arquivo', () => {
  const total = 500;
  const file = parseDiffFile({
    old_path: 'big.txt',
    new_path: 'big.txt',
    new_file: true,
    diff: d(
      `@@ -0,0 +1,${total} @@`,
      ...Array.from({ length: total }, (_, i) => `+conteudo da linha ${i + 1}`),
    ),
  });

  const out = renderFiles([file], { maxLinesPerFile: 400, maxTotalLines: 1500 });
  const lines = out.split('\n');

  it('emite o marcador com a contagem restante', () => {
    // 1 cabeçalho @@ + 500 linhas = 501 renderizáveis; orçamento 400 => sobram 101.
    expect(out).toContain('[truncado: 101 linhas restantes neste arquivo — use path="big.txt" para ver isolado]');
  });

  it('respeita o orçamento de linhas', () => {
    const body = lines.filter((l) => l.startsWith('  add') || l.startsWith('@@'));
    expect(body).toHaveLength(400);
  });

  it('não corta no meio de uma linha', () => {
    const last = lines.filter((l) => l.startsWith('  add')).at(-1)!;
    expect(last.endsWith('| conteudo da linha 399')).toBe(true);
    expect(out).not.toContain('conteudo da linha 400');
  });
});

describe('extra: arquivo binário', () => {
  it('omite o diff e sinaliza no cabeçalho', () => {
    const file = parseDiffFile({
      old_path: 'logo.png',
      new_path: 'logo.png',
      diff: 'Binary files a/logo.png and b/logo.png differ\n',
    });
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
    expect(renderFiles([file])).toContain('=== logo.png (binary, diff omitido) ===');
  });
});
