import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACE_LINES,
  MAX_LINE_CHARS,
  MAX_TRACE_CHARS,
  cleanTrace,
  renderTrace,
  tailLines,
} from '../src/trace.js';

const ESC = '\x1b';
const BEL = '\x07';

/** Numeração de 1 a n como linhas, para os casos de corte. */
const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));

describe('1. cleanTrace — sequências ANSI', () => {
  it('UT-01 remove CSI de cor', () => {
    expect(cleanTrace(`${ESC}[32mok${ESC}[0m`)).toEqual(['ok']);
  });

  it('UT-02 remove OSC junto com o BEL que a termina', () => {
    expect(cleanTrace(`${ESC}]0;building${BEL}done`)).toEqual(['done']);
  });

  it('UT-12 remove o rabo de controle mesmo sem o marcador de seção', () => {
    expect(cleanTrace(`${ESC}[0Kplain`)).toEqual(['plain']);
  });
});

describe('2. cleanTrace — marcadores de seção', () => {
  it('UT-03 tira o marcador e mantém o conteúdo que vem depois', () => {
    expect(cleanTrace(`section_start:1699999999:build\r${ESC}[0Kcompiling`)).toEqual(['compiling']);
  });

  it('UT-04 linha que só tem marcador não deixa nada', () => {
    expect(cleanTrace(`section_end:1699999999:build\r${ESC}[0K`)).toEqual([]);
  });
});

describe('3. cleanTrace — retorno de carro', () => {
  it('UT-05 mantém só o estado final de uma linha reescrita', () => {
    expect(cleanTrace('a\rb\rc')).toEqual(['c']);
  });

  it('UT-06 CRLF é fim de linha, não reescrita', () => {
    expect(cleanTrace('one\r\ntwo\r\n')).toEqual(['one', 'two']);
  });
});

describe('4. cleanTrace — timestamp', () => {
  it('UT-07 remove ISO-8601 no começo da linha', () => {
    expect(cleanTrace('2026-08-12T03:37:08.0175781Z npm error')).toEqual(['npm error']);
  });

  it('UT-08 timestamp no meio da linha sobrevive', () => {
    const line = 'failed at 2026-08-12T03:37:08Z during step';
    expect(cleanTrace(line)).toEqual([line]);
  });

  // Byte real, colhido de /projects/944/jobs/15965/trace. Os 41 casos
  // sintéticos não pegavam: foram escritos a partir do requisito que já tinha
  // perdido a palavra "stream" na tradução do spec.md original.
  it('UT-46 marcador de stream colado no timestamp sai junto', () => {
    expect(cleanTrace(`2026-08-10T18:52:31.340190Z 00O ${ESC}[31;1mERROR: Job failed${ESC}[0;m`)).toEqual([
      'ERROR: Job failed',
    ]);
    expect(cleanTrace('2026-08-10T18:52:30.272008Z 00O+WARNING: timeout')).toEqual(['WARNING: timeout']);
    expect(cleanTrace('2026-08-10T18:52:30.272008Z 01O Time Elapsed 00:12:41.06')).toEqual([
      'Time Elapsed 00:12:41.06',
    ]);
  });

  it('UT-47 marcador de stream sem timestamp na frente é conteúdo, e fica', () => {
    expect(cleanTrace('00O nao e prefixo aqui')).toEqual(['00O nao e prefixo aqui']);
  });
});

describe('5. cleanTrace — linhas em branco', () => {
  it('UT-09 branco no meio é estrutura e fica', () => {
    expect(cleanTrace('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('UT-10 brancos do fim somem', () => {
    expect(cleanTrace('a\n\n\n')).toEqual(['a']);
  });

  it('UT-11 string vazia vira lista vazia', () => {
    expect(cleanTrace('')).toEqual([]);
  });
});

describe('6. tailLines — corte', () => {
  it('UT-13 devolve as últimas linhas e conta as descartadas', () => {
    expect(tailLines(numbered(10), 3)).toEqual({ lines: ['8', '9', '10'], dropped: 7 });
  });

  it('UT-14 abaixo do teto devolve tudo, sem descarte', () => {
    expect(tailLines(numbered(5), 400)).toEqual({ lines: ['1', '2', '3', '4', '5'], dropped: 0 });
  });

  it('UT-15 lista vazia não quebra', () => {
    expect(tailLines([], 400)).toEqual({ lines: [], dropped: 0 });
  });

  it('UT-16 exatamente no teto não descarta nada', () => {
    expect(tailLines(numbered(10), 10).dropped).toBe(0);
  });
});

describe('7. renderTrace — aviso e integridade', () => {
  const raw = numbered(500).join('\n');

  it('UT-17 acima do teto: aviso separado com a contagem, e exatamente maxLines linhas no corpo', () => {
    const { body, notice } = renderTrace(raw, 400);
    expect(notice).toContain('100');
    expect(notice).toMatch(/^\[truncado:/);
    const lines = body.split('\n');
    expect(lines).toHaveLength(400);
    expect(lines[0]).toBe('101');
    expect(lines[lines.length - 1]).toBe('500');
  });

  it('UT-18 abaixo do teto não emite aviso', () => {
    const { body, notice } = renderTrace(numbered(12).join('\n'), 400);
    expect(notice).toBeUndefined();
    expect(body.split('\n')).toHaveLength(12);
  });

  it('UT-19 toda linha devolvida é idêntica a uma linha limpa de origem — nenhum fragmento', () => {
    const source = new Set(cleanTrace(raw));
    for (const line of renderTrace(raw, 400).body.split('\n')) expect(source.has(line)).toBe(true);
  });

  it('UT-20 sem maxLines usa o default de 400', () => {
    expect(DEFAULT_TRACE_LINES).toBe(400);
    expect(renderTrace(raw)).toEqual(renderTrace(raw, 400));
  });

  it('UT-50 o aviso fica FORA do corpo — nada de instrução de servidor dentro do envelope', () => {
    const { body, notice } = renderTrace(raw, 400);
    expect(notice).toBeDefined();
    expect(body).not.toContain('truncado');
    expect(body).not.toContain('max_lines');
  });
});

describe('8. renderTrace — o trace que motivou a feature', () => {
  const FAILURE = 'ERROR: Job failed: execution took longer than 15m0s seconds';

  it('UT-21 trace de ~500 KB termina na linha do erro do runner', () => {
    const filler = Array.from(
      { length: 20000 },
      (_, i) => `${ESC}[32m[${i}]${ESC}[0m restoring package ${i} of 20000`,
    );
    const raw = [...filler, FAILURE].join('\n');
    expect(raw.length).toBeGreaterThan(500_000);

    const { body, notice } = renderTrace(raw, 400);
    const lines = body.split('\n');
    expect(lines[lines.length - 1]).toBe(FAILURE);
    expect(notice).toMatch(/^\[truncado:/);
  });
});

describe('9. tetos de caractere — o que teto de linha não segura', () => {
  it('UT-51 uma única linha gigante é cortada por caractere', () => {
    const huge = 'x'.repeat(50_000);
    const [line] = cleanTrace(huge);
    expect(line!.length).toBeLessThan(MAX_LINE_CHARS + 100);
    expect(line).toContain('linha truncada');
  });

  it('UT-52 trace acima do teto de caracteres perde o começo, não o fim', () => {
    const raw = `${'a'.repeat(MAX_TRACE_CHARS)}\nMARCADOR FINAL`;
    const cleaned = cleanTrace(raw);
    expect(cleaned[cleaned.length - 1]).toBe('MARCADOR FINAL');
    expect(cleaned.join('\n').length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
  });

  it('UT-53 a primeira linha do recorte, provavelmente partida ao meio, é descartada', () => {
    const raw = `${'z'.repeat(MAX_TRACE_CHARS + 500)}\nfim`;
    expect(cleanTrace(raw)).toEqual(['fim']);
  });
});

describe('10. linha terminada em retorno de carro solto', () => {
  it('UT-54 não some — vale o último segmento não-vazio', () => {
    expect(cleanTrace('important error message\r')).toEqual(['important error message']);
  });

  it('UT-55 vários \\r com o último vazio ainda devolve o texto', () => {
    expect(cleanTrace('a\rb\r')).toEqual(['b']);
  });
});

describe('11. indentação preservada', () => {
  it('UT-56 marcador de stream não come coluna de indentação', () => {
    expect(cleanTrace('2026-08-10T18:52:30.272008Z 00O   at Foo.Bar()')).toEqual(['  at Foo.Bar()']);
  });
});
