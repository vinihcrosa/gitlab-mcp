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
  // `>=`, não `>`. Em produção o corte acontece no transporte, que devolve uma
  // string de tamanho EXATAMENTE MAX_TRACE_CHARS começando no meio de uma
  // linha. Com `>` a comparação era 512000 > 512000 = false, o descarte da
  // primeira linha era pulado, e o fragmento chegava ao modelo como linha real
  // — e como a PRIMEIRA que ele lê, quando a cauda tem menos linhas que o teto.
  if (source.length >= MAX_TRACE_CHARS) {
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
  const tail = tailLines(cleaned.lines, maxLines);
  const charsDropped = cleaned.charsDropped + droppedBeforeRead;

  // Teto do corpo devolvido. Corta pela frente em limite de linha; o índice é
  // calculado de uma vez, em vez de um slice por linha descartada.
  let cutForSize = 0;
  let size = tail.lines.reduce((n, l) => n + l.length + 1, 0);
  while (cutForSize < tail.lines.length - 1 && size > MAX_BODY_CHARS) {
    size -= tail.lines[cutForSize]!.length + 1;
    cutForSize++;
  }
  const kept = cutForSize === 0 ? tail.lines : tail.lines.slice(cutForSize);
  const body = kept.join('\n');

  if (tail.dropped === 0 && cutForSize === 0 && charsDropped === 0) return { body };

  // Corte por CONTAGEM e corte por TAMANHO recebem conselhos diferentes.
  // Somados, uma truncagem por tamanho ganhava o conselho de aumentar
  // max_lines — que devolve corpo byte-a-byte idêntico, porque as linhas extras
  // entram e o laço de tamanho as corta de volta. Retry sem progresso.
  const parts: string[] = [];
  if (tail.dropped > 0) parts.push(`${tail.dropped} linha(s) anterior(es) omitida(s) pelo limite de linhas`);
  if (cutForSize > 0) parts.push(`${cutForSize} linha(s) cortada(s) pelo limite de tamanho da resposta`);
  if (charsDropped > 0) parts.push(`${humanSize(charsDropped)} cortados do começo antes disso`);

  // Só oferece max_lines quando aumentar max_lines muda alguma coisa.
  const advice =
    tail.dropped > 0 && cutForSize === 0
      ? ' — chame de novo com max_lines maior para ver mais'
      : ' — o limite de tamanho da resposta já foi atingido; aumentar max_lines não muda o corpo. Veja o job no browser se o que você procura ficou acima.';

  return { body, notice: `[truncado: ${parts.join(', ')}${advice}]` };
}

/** Unidade que não reporta "~0 KB" para 300 chars nem "~99500 KB" para 100 MB. */
function humanSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  if (chars < 1_000_000) return `~${Math.round(chars / 1000)} KB`;
  return `~${(chars / 1_000_000).toFixed(1)} MB`;
}
