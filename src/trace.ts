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
 * descarta nada, e o contexto do modelo come tudo.
 *
 * O pico de memória é atacado uma camada abaixo, não aqui: `glText` recebe este
 * mesmo número em `maxTextChars` e lê o corpo em streaming, então a resposta
 * inteira nunca vira string. Aqui o corte é só a segunda linha de defesa, para
 * quem chamar cleanTrace com uma string que já veio grande.
 */
export const MAX_TRACE_CHARS = 512_000;

/** Teto por linha, para a linha única gigante que sobreviver ao corte acima. */
export const MAX_LINE_CHARS = 2_000;

/**
 * Teto do corpo DEVOLVIDO, aplicado depois do corte por linha.
 *
 * O teto de entrada não limita a saída: 400 linhas de 3 KB passam pelos dois
 * cortes anteriores e ainda são ~345 KB de contexto. Este é o número que
 * corresponde ao `truncate()` dos outros campos do repositório.
 */
export const MAX_BODY_CHARS = 60_000;

export interface TraceTail {
  /** Linhas mantidas, na ordem original. */
  lines: string[];
  /** Quantas linhas anteriores foram descartadas. 0 quando nada foi. */
  dropped: number;
}

// CSI: ESC [ ... byte final. Cobre cor, movimento de cursor e \x1b[0K.
// Exportados porque o cabeçalho montado em volta do trace precisa da mesma
// higiene que o corpo: sem isto, um nome de job com \x1b[2K\x1b[1G apaga a
// linha e sobrescreve o prefixo que o servidor escreveu.
export const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... terminado em BEL ou ST. É o que muda título de terminal.
export const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
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
export interface CleanedTrace {
  lines: string[];
  /** Caracteres descartados pelo teto de entrada. 0 quando não houve corte. */
  charsDropped: number;
}

export function cleanTraceWithCut(raw: string): CleanedTrace {
  // 0. Teto de caracteres antes de tudo. Fica com o FIM, pela mesma razão que
  //    o corte por linha fica: build quebra no fim.
  let source = raw;
  let charsDropped = 0;
  if (source.length > MAX_TRACE_CHARS) {
    charsDropped = source.length - MAX_TRACE_CHARS;
    source = source.slice(-MAX_TRACE_CHARS);
    const firstBreak = source.indexOf('\n');
    // Só descarta a primeira linha (provavelmente partida) quando existe outra
    // depois dela. Sem newline nenhum o recorte inteiro É a linha: zerar aqui
    // apagava o trace todo e fazia get_job_log dizer que o log veio vazio —
    // justamente para a entrada que motivou este teto. O teto por linha abaixo
    // cuida do tamanho.
    if (firstBreak !== -1) {
      charsDropped += firstBreak + 1;
      source = source.slice(firstBreak + 1);
    }
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
  return { lines: lines.slice(0, end), charsDropped };
}

/** Só as linhas. Mantido porque quase todo caso de teste só quer isso. */
export function cleanTrace(raw: string): string[] {
  return cleanTraceWithCut(raw).lines;
}

/** Mantém as últimas `maxLines` entradas. Nunca parte uma linha ao meio. */
export function tailLines(lines: string[], maxLines: number): TraceTail {
  // NaN/Infinity não chegam pela superfície MCP (o schema zod limita), mas um
  // teto NaN produziria `[truncado: NaN linha(s)]`, que é pior que um default.
  const keep = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : DEFAULT_TRACE_LINES;
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
export function renderTrace(
  raw: string,
  maxLines: number = DEFAULT_TRACE_LINES,
  /** Caracteres já descartados antes daqui, pelo teto de leitura do transporte. */
  droppedBeforeRead = 0,
): TraceRender {
  const cleaned = cleanTraceWithCut(raw);
  const { lines } = cleaned;
  const charsDropped = cleaned.charsDropped + droppedBeforeRead;
  const tail = tailLines(lines, maxLines);
  let kept = tail.lines;
  let linesDropped = tail.dropped;

  // Teto do corpo devolvido. Corta pela frente, uma linha por vez, para nunca
  // partir linha — mesma regra do corte por contagem.
  let size = kept.reduce((n, l) => n + l.length + 1, 0);
  let cutForSize = 0;
  while (kept.length > 1 && size > MAX_BODY_CHARS) {
    size -= kept[0]!.length + 1;
    kept = kept.slice(1);
    cutForSize++;
  }
  linesDropped += cutForSize;

  const body = kept.join('\n');
  if (linesDropped === 0 && charsDropped === 0) return { body };

  // O aviso conta as DUAS formas de corte. Contar só o corte por linha era
  // mentira por omissão: quem não vê o erro conclui que ele não está no log.
  const parts: string[] = [];
  if (linesDropped > 0) parts.push(`${linesDropped} linha(s) anterior(es) omitida(s)`);
  if (charsDropped > 0) parts.push(`mais ~${Math.round(charsDropped / 1000)} KB cortados do começo por tamanho`);
  return {
    body,
    notice: `[truncado: ${parts.join(', ')} — chame de novo com max_lines maior para ver mais, ou veja o job no browser se o corte por tamanho tirou o que você procura]`,
  };
}
