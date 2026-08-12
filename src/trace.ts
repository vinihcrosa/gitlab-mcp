// Limpeza e truncamento de trace de job. Lógica pura, sem I/O — mesma
// justificativa do src/diff.ts: se a limpeza comer conteúdo real ou o corte
// pegar a metade errada, a resposta parece plausível e está errada.
//
// Nada aqui importa gitlab.ts, format.ts ou o SDK do MCP.

/** Teto default de linhas. Mesmo número por arquivo que o renderizador de diff. */
export const DEFAULT_TRACE_LINES = 400;

/** Teto máximo aceito de quem chama. */
export const MAX_TRACE_LINES = 5000;

/**
 * Teto de caracteres do trace cru, aplicado ANTES de qualquer split.
 *
 * Teto por linha sozinho não segura nada: um job que imprime um bundle
 * minificado ou um base64 produz UMA linha de megabytes, `tailLines` não
 * descarta nada, e o contexto do modelo come tudo. Cortar aqui também evita o
 * pico de memória de fazer replace + split + map sobre a string inteira.
 */
export const MAX_TRACE_CHARS = 512_000;

/** Teto por linha, para a linha única gigante que sobreviver ao corte acima. */
export const MAX_LINE_CHARS = 2_000;

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
// Prefixo de linha do GitLab: timestamp ISO-8601 e, opcionalmente, o marcador
// de stream que vem colado nele — `00O `, `01O `, `00O+` (dois dígitos de
// profundidade de seção, O/E para stdout/stderr, `+` para continuação).
//
// O marcador só é removido quando SEGUE um timestamp. Sozinho ele é ambíguo
// demais: `00O` pode ser conteúdo real de log, e comer conteúdo é pior falha
// que deixar prefixo visível.
//
// O separador é consumido UMA vez. Alternação, não dois grupos opcionais em
// sequência: o marcador já engole o espaço que o separa do timestamp, e um
// `[ \t]?` depois dele comeria a primeira coluna de indentação de toda linha
// indentada — stack trace, YAML, saída de teste aninhada.
const LEADING_PREFIX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:[ \t]+\d{2}[OE][+ ]?|[ \t])?/;

/**
 * Aplica o contrato de limpeza. A ordem é o contrato, não detalhe: marcador de
 * seção e ANSI saem antes do colapso de \r, senão o colapso deixaria o rabo do
 * marcador como conteúdo da linha.
 */
export function cleanTrace(raw: string): string[] {
  // 0. Teto de caracteres antes de tudo. Fica com o FIM, pela mesma razão que
  //    o corte por linha fica: build quebra no fim. A primeira linha do recorte
  //    quase certamente está partida ao meio, então some.
  let source = raw;
  if (source.length > MAX_TRACE_CHARS) {
    source = source.slice(-MAX_TRACE_CHARS);
    const firstBreak = source.indexOf('\n');
    source = firstBreak === -1 ? '' : source.slice(firstBreak + 1);
  }

  // 1. CRLF é fim de linha, não reescrita de linha.
  const normalised = source.replace(/\r\n/g, '\n');

  // 2. Quebra em linhas.
  const lines = normalised.split('\n').map((line) => {
    // 3. Marcadores de seção.
    let out = line.replace(SECTION, '');
    // 4. ANSI, nas duas formas.
    out = out.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
    // 5. Barra de progresso: só o estado final da linha sobrevive. Quando o
    //    trecho depois do último \r é vazio — linha que o runner terminou com
    //    CR solto, comum em trace de job ainda em execução — vale o último
    //    segmento não-vazio, senão a linha desaparece inteira.
    if (out.includes('\r')) {
      const segments = out.split('\r');
      out = segments[segments.length - 1] || segments.filter((s) => s !== '').pop() || '';
    }
    // 6. Timestamp e marcador de stream, só quando a linha começa com eles.
    out = out.replace(LEADING_PREFIX, '');
    // 7. Teto por linha, para o base64 ou bundle numa linha só.
    if (out.length > MAX_LINE_CHARS) {
      out = `${out.slice(0, MAX_LINE_CHARS)}…[linha truncada: +${out.length - MAX_LINE_CHARS} chars]`;
    }
    return out;
  });

  // 8. Linhas vazias do fim somem; as do meio são estrutura e ficam.
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

export interface TraceRender {
  /** Corpo limpo e cortado. É o que entra no envelope `<untrusted>`. */
  body: string;
  /** Aviso de corte, quando houve. Fica FORA do envelope. */
  notice?: string;
}

/**
 * cleanTrace + tailLines, com o aviso SEPARADO do corpo.
 *
 * O aviso é texto do servidor e diz o que fazer em seguida (chamar de novo com
 * max_lines maior). Dentro do envelope ele viraria conteúdo que a nota manda o
 * modelo ignorar — e, pior, ensinaria que aviso legítimo de servidor aparece
 * dentro de bloco não confiável, que é exatamente a forma que um aviso forjado
 * num log malicioso teria.
 */
export function renderTrace(raw: string, maxLines: number = DEFAULT_TRACE_LINES): TraceRender {
  const { lines, dropped } = tailLines(cleanTrace(raw), maxLines);
  const body = lines.join('\n');
  if (dropped === 0) return { body };
  return {
    body,
    notice: `[truncado: ${dropped} linha(s) anterior(es) omitida(s) — chame de novo com max_lines maior para ver mais]`,
  };
}
