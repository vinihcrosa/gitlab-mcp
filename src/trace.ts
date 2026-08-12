// Limpeza e truncamento de trace de job. Lógica pura, sem I/O — mesma
// justificativa do src/diff.ts: se a limpeza comer conteúdo real ou o corte
// pegar a metade errada, a resposta parece plausível e está errada.
//
// Nada aqui importa gitlab.ts, format.ts ou o SDK do MCP.

/** Teto default de linhas. Mesmo número por arquivo que o renderizador de diff. */
export const DEFAULT_TRACE_LINES = 400;

/** Teto máximo aceito de quem chama. */
export const MAX_TRACE_LINES = 5000;

export interface TraceTail {
  /** Linhas mantidas, na ordem original. */
  lines: string[];
  /** Quantas linhas anteriores foram descartadas. 0 quando nada foi. */
  dropped: number;
}

// CSI: ESC [ ... byte final. Cobre cor, movimento de cursor e \x1b[0K.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... terminado em BEL ou ST. É o que muda título de terminal.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Marcador de seção do GitLab. O nome é sempre identificador, nunca texto livre.
const SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+/g;
// Timestamp ISO-8601 apenas no começo da linha, com o espaço que o separa.
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?[ \t]?/;

/**
 * Aplica o contrato de limpeza. A ordem é o contrato, não detalhe: marcador de
 * seção e ANSI saem antes do colapso de \r, senão o colapso deixaria o rabo do
 * marcador como conteúdo da linha.
 */
export function cleanTrace(raw: string): string[] {
  // 1. CRLF é fim de linha, não reescrita de linha.
  const normalised = raw.replace(/\r\n/g, '\n');

  // 2. Quebra em linhas.
  const lines = normalised.split('\n').map((line) => {
    // 3. Marcadores de seção.
    let out = line.replace(SECTION, '');
    // 4. ANSI, nas duas formas.
    out = out.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
    // 5. Barra de progresso: só o estado final da linha sobrevive.
    const lastCr = out.lastIndexOf('\r');
    if (lastCr !== -1) out = out.slice(lastCr + 1);
    // 6. Timestamp, só quando a linha inteira começa com um.
    return out.replace(LEADING_TIMESTAMP, '');
  });

  // 7. Linhas vazias do fim somem; as do meio são estrutura e ficam.
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

/** Mantém as últimas `maxLines` entradas. Nunca parte uma linha ao meio. */
export function tailLines(lines: string[], maxLines: number): TraceTail {
  const keep = Math.max(1, Math.floor(maxLines));
  if (lines.length <= keep) return { lines, dropped: 0 };
  return { lines: lines.slice(-keep), dropped: lines.length - keep };
}

/**
 * cleanTrace + tailLines já no formato que a tool devolve. O aviso de corte vai
 * em cima: o que sobrou é a cauda, então o que foi omitido está acima dela.
 */
export function renderTrace(raw: string, maxLines: number = DEFAULT_TRACE_LINES): string {
  const { lines, dropped } = tailLines(cleanTrace(raw), maxLines);
  const body = lines.join('\n');
  if (dropped === 0) return body;
  return `[truncado: ${dropped} linha(s) anterior(es) omitida(s) — chame de novo com max_lines maior para ver mais]\n${body}`;
}
