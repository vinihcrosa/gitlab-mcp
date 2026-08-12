# AGENTS.md — Guia de Orientação para Agentes de Código

Este documento existe para orientar qualquer agente de código (humano ou LLM) que precise trabalhar neste repositório. Ele descreve o que o produto faz, como o repositório está organizado, quais comandos existem de verdade, quais invariantes de domínio o código-fonte estabelece, e quais ações um agente **não** deve executar. Leia este arquivo inteiro antes de fazer qualquer alteração, pois várias regras aqui descritas são invariantes rígidos derivados diretamente do código, e violá-las quebra o servidor de formas silenciosas e difíceis de depurar.

## 1. O que este produto faz

O **gitlab-mcp** é um servidor MCP (Model Context Protocol) que roda sobre **stdio** e funciona como um proxy fino sobre a **REST API v4** de uma instância **GitLab CE self-hosted**. O escopo é deliberadamente pequeno (é um MVP com um objetivo só): **navegar merge requests e deixar review inline sem abrir o browser**. **Ler** o estado da CI entra nesse objetivo — a medição de uso real (157 de 632 chamadas `gh`) mostrou que o fluxo trava exatamente quando a pipeline quebra; ver `docs/adr/2026-08-12-pipelines-re-enter-scope-on-measured-usage.md`. **Escrever** em CI não entra: nada dispara, cancela ou re-roda pipeline, e nada lê variável ou secret. Fora de escopo também — issues, criação/merge de MR, aprovações, ou recursos Premium/Ultimate.

O servidor expõe exatamente **13 tools MCP**, registradas em ordem em `src/tools/index.ts`:

1. `whoami` — identidade do token (`src/tools/whoami.ts`).
2. `list_my_projects` — projetos onde o usuário é membro (`src/tools/projects.ts`).
3. `list_my_authored_mrs` — MRs criados pelo usuário (`src/tools/mrs.ts`).
4. `list_mrs_awaiting_my_review` — MRs abertos onde o usuário é reviewer (`src/tools/mrs.ts`).
5. `get_mr` — detalhe completo de um MR (`src/tools/mrs.ts`).
6. `get_mr_diff` — diff em texto com numeração explícita `old=`/`new=` (`src/tools/diff.ts`).
7. `list_mr_discussions` — threads de comentário de um MR (`src/tools/discussions.ts`).
8. `comment_on_mr` — comentário geral no MR (escrita, `src/tools/write.ts`).
9. `comment_on_mr_line` — thread de review ancorada em linha do diff (escrita, `src/tools/write.ts`).
10. `reply_to_mr_discussion` — resposta em thread existente (escrita, `src/tools/write.ts`).
11. `get_mr_pipeline` — pipeline mais recente do MR e seus jobs (leitura, `src/tools/pipelines.ts`).
12. `get_job_log` — log do job, limpo e cortado pela cauda (leitura, `src/tools/pipelines.ts`).
13. `list_pipelines` — pipelines do projeto, filtradas na API (leitura, `src/tools/pipelines.ts`).

As tools 8, 9 e 10 são **tools de escrita** e só funcionam quando `GITLAB_READ_ONLY=false` (literal exato). Esse ponto é repetido mais adiante na seção de segurança porque é um dos invariantes mais importantes do projeto.

## 2. Estrutura real do repositório

A estrutura abaixo reflete o que existe hoje no repositório. Não há outros diretórios de código além destes.

```
gitlab-mcp/
├── package.json          # scripts, deps, "type": "module", bin: dist/index.js
├── package-lock.json
├── tsconfig.json         # NodeNext, strict, ES2022, src -> dist
├── .env.example          # documentação das variáveis de ambiente
├── .gitignore
├── README.md
├── src/
│   ├── index.ts          # entrypoint: boot, config, transporte stdio
│   ├── config.ts         # carga e validação de env; read-only por default
│   ├── gitlab.ts         # único ponto de saída HTTP; retry de 429; erros traduzidos
│   ├── errors.ts         # GitLabError, ToolError, messageOf
│   ├── diff.ts           # parser de diff unificado — lógica pura, sem I/O
│   ├── trace.ts          # limpeza e corte pela cauda de trace — lógica pura, sem I/O
│   ├── pipelines.ts      # projeção/decisão/renderização de CI — lógica pura, sem I/O
│   ├── format.ts         # pick/truncate/untrusted/pageBlock — projeção de saída
│   ├── projects.ts       # resolução e cache de projetos (path <-> id)
│   └── tools/
│       ├── index.ts      # registerAll — ordem de registro das 13 tools
│       ├── register.ts   # wrapper tool() + assertWritable()
│       ├── whoami.ts     # tool 1
│       ├── projects.ts   # tool 2
│       ├── mrs.ts        # tools 3, 4, 5
│       ├── diff.ts       # tool 6
│       ├── discussions.ts# tool 7
│       ├── write.ts      # tools 8, 9, 10
│       └── pipelines.ts  # tools 11, 12, 13
├── test/
│   ├── diff.test.ts      # parser de diff
│   ├── trace.test.ts     # limpeza e corte de trace
│   ├── pipelines.test.ts # projeção, decisão e renderização de CI
│   └── register.test.ts  # superfície de tools registradas
└── dist/                 # saída compilada do tsc — nunca edite à mão
```

Observação importante que será repetida na seção de restrições: `dist/` é gerado por `npm run build` e não deve ser editado manualmente em hipótese alguma.

## 3. Comandos que existem hoje

Estes são os únicos scripts definidos em `package.json`. Não existem outros comandos de build, lint ou CI configurados neste repositório.

| Comando | O que faz |
|---|---|
| `npm run build` | `tsc && chmod +x dist/index.js` — compila `src/` para `dist/` e torna o entrypoint executável. |
| `npm start` | `node dist/index.js` — sobe o servidor MCP via stdio (requer build prévio e env configurado). |
| `npm run inspect` | `npx @modelcontextprotocol/inspector node dist/index.js` — abre o MCP Inspector contra o build. |
| `npm test` | `vitest run` — roda a suíte uma vez. |
| `npm run test:watch` | `vitest` — roda a suíte em modo watch. |

O runtime exigido é **Node >= 20** (campo `engines` do `package.json`). Os testes cobrem a lógica pura do projeto: `test/diff.test.ts` (parser de diff), `test/trace.test.ts` (limpeza e corte de trace de job), `test/pipelines.test.ts` (projeção, decisão e renderização de CI) e `test/register.test.ts` (superfície de tools registradas). O critério é o registrado em comentário no topo de `src/diff.ts`: lógica pura, onde saída errada parece plausível. Camada de I/O segue sem teste — não há fixture server, e isso está declarado em `docs/features/001-ci-pipelines/tests.md`.

## 4. Invariantes de domínio (derivados do código-fonte)

Estes invariantes vêm diretamente do código. Cada um deles tem consequência concreta se for violado.

- **stdout é sagrado.** stdout é o canal do protocolo MCP. Um único `console.log` corrompe a sessão inteira e o sintoma é um erro de parse JSON incompreensível do lado do client. Todo log vai para stderr, sempre via `log()` de `src/gitlab.ts` ou `console.error`. Sem exceção. (Aviso em bloco no topo de `src/index.ts`.)
- **Read-only por default.** Apenas o literal exato `'false'` em `GITLAB_READ_ONLY` habilita escrita — qualquer outro valor, inclusive ausência da variável, mantém o modo read-only (`src/config.ts`). As três tools de escrita chamam `assertWritable()` antes de tocar na rede (`src/tools/register.ts`, `src/tools/write.ts`).
- **`iid` ≠ `id` global.** Todas as tools de MR usam o `iid` — o número que aparece na URL (`/-/merge_requests/123`) — nunca o `id` global do GitLab. As descrições das tools repetem isso de propósito.
- **Config validada no boot, ou o processo morre.** `loadConfig()` acumula todos os erros de env, imprime em stderr e chama `process.exit(1)`. Nunca subir um server quebrado (`src/config.ts`).
- **URL normalizada.** `normalizeGitlabUrl()` remove barras finais e um sufixo `/api/v4` colado por engano. `GITLAB_URL` precisa começar com `http://` ou `https://`.
- **Todo HTTP sai por `src/gitlab.ts`** — hoje `gl()` para corpo JSON e `glText()` para corpo de texto (trace de job), ambos sobre o mesmo `request()`, que concentra timeout, retry de 429, CA privada e tradução de erro. O invariante é o módulo, não a função: `src/gitlab.ts` é o único ponto de saída HTTP do servidor. Toda tool passa por ali; nenhuma tool faz `fetch` por conta própria.
- **429 tem retry único.** Ao receber 429, o servidor respeita `Retry-After` (limitado a 60s; default 5s quando ausente), tenta exatamente mais uma vez e desiste (`src/gitlab.ts`).
- **Chave ausente ≠ chave `null`.** No payload de `position` enviado ao GitLab, chaves omitidas continuam omitidas — o GitLab rejeita `null` implícito (`src/tools/write.ts`, `src/gitlab.ts`).
- **`diff_refs` sempre frescos.** `comment_on_mr_line` rebusca o MR na hora de comentar em vez de aceitar shas como parâmetro: se alguém deu push desde a última leitura, os shas mudaram e a posição fica inválida (`src/tools/write.ts`).
- **Validação local antes do POST.** `comment_on_mr_line` valida `file_path`, `line` e `side` contra o diff parseado localmente antes de postar — erro de API que o modelo não sabe corrigir vira loop de retry. Os números `old=`/`new=` impressos por `get_mr_diff` são exatamente o que a tool espera.
- **Nenhuma tool devolve JSON cru do GitLab.** Toda saída passa por whitelist explícita (`pick()`, `PROJECT_FIELDS`, `listItem`) e truncamento (`truncate()`) em `src/format.ts`. Chaves ausentes na origem somem da saída.
- **Conteúdo de usuário é marcado como não confiável.** Descrições de MR e corpos de notas são envolvidos em `<untrusted source="gitlab:...">` via `untrusted()`, e a resposta ganha a `UNTRUSTED_NOTE` uma única vez quando contém algum bloco untrusted (`src/format.ts`).
- **Toda listagem pagina e diz se tem mais.** O bloco `pageBlock()` (page, per_page, total_pages, has_more, next_page) acompanha toda listagem.
- **Fallback para GitLab < 15.7.** Se `GET /diffs` devolver 404, o servidor lembra disso pelo resto do processo e passa a usar `GET /changes` com paginação local (`src/tools/diff.ts`).
- **Varredura de diff é limitada.** `loadAllDiffFiles` varre no máximo 3 páginas de 100 arquivos (`MAX_SCAN_PAGES`). A renderização trunca em 400 linhas por arquivo e 1500 no total, sempre em limite de linha — nunca no meio de uma (`src/diff.ts`).
- **Cache de identidade e de projetos.** `getMe()` é cacheado no processo; `resolveProject`/`rememberProject` mantêm um `Map` de path↔id para não gastar chamada extra por operação.

## 5. Restrições de ESM e dependências

- O pacote é **ESM puro**: `"type": "module"` em `package.json`, `module`/`moduleResolution` `NodeNext` no `tsconfig.json`. Consequência prática: **todo import relativo em `src/` precisa do sufixo `.js`** (ex.: `import { gl } from '../gitlab.js'`), mesmo apontando para arquivos `.ts`. Isso já é o padrão em todos os arquivos existentes — siga-o.
- **Node >= 20** é obrigatório (`engines`). O código usa `fetch` nativo e `AbortSignal.timeout`.
- Dependências de runtime são exatamente três: `@modelcontextprotocol/sdk`, `undici` e `zod`. `undici` é usado apenas para instalar um CA privado no dispatcher global do fetch nativo (`initHttp` em `src/gitlab.ts`) — as requisições em si usam o `fetch` nativo.
- Dependências de desenvolvimento: `typescript`, `vitest`, `@types/node`. Não há ESLint, Prettier, nem qualquer outra ferramenta configurada.
- Não adicione dependências novas sem necessidade demonstrável. O projeto é um proxy fino de propósito, e o tamanho reduzido do grafo de dependências é uma característica, não um acidente.
- TypeScript roda em modo `strict`. `rootDir` é `src`, `outDir` é `dist`, sem declaration nem sourcemap.

## 6. Validação e tratamento de erros

- **Inputs de tool** são declarados com schemas `zod` (`ZodRawShape`) passados ao SDK MCP via o wrapper `tool()` de `src/tools/register.ts`. Cada campo tem `.describe()` orientando o modelo consumidor.
- **Erros viram texto lido pelo modelo.** A regra registrada em `src/errors.ts`: a mensagem tem que dizer o que fazer em seguida. Stack trace não ajuda o modelo a se corrigir e não deve aparecer em saída de tool.
- Há duas classes de erro: `GitLabError` (falha vinda da API, já traduzida por status em `toGitLabError`, com o corpo cru preservado em `body`) e `ToolError` (falha detectada localmente: validação, read-only, input incoerente). O wrapper `tool()` captura qualquer exceção e devolve `{ isError: true }` com a mensagem de `messageOf()`.
- Erros HTTP são traduzidos por status: 401 (token inválido/expirado), 403 (escopo insuficiente — provavelmente `read_api` onde precisa `api`), 404 (não encontrado ou sem acesso), 400 (recusa do GitLab, com a mensagem original anexada), 429 (rate limit, após o retry único), 5xx (erro do GitLab). Timeout e falha de rede geram mensagens que citam `GITLAB_TIMEOUT_MS`, `GITLAB_URL`, VPN e `GITLAB_CA_CERT` como próximos passos.
- No 400 de `comment_on_mr_line`, a mensagem repassa a resposta crua do GitLab **e** o payload enviado — é o que permite o modelo se corrigir sozinho.
- Mantenha esse padrão em qualquer código novo: erro acionável, em português, dizendo qual tool ou variável usar em seguida. Este ponto ecoa o invariante da seção 4: nenhuma tool devolve JSON cru, nem em caso de erro.

## 7. Limites de segurança

- **Modo read-only é o default e é um recurso de segurança.** Só o literal `'false'` em `GITLAB_READ_ONLY` libera as três tools de escrita. Não altere esse default, não inverta a lógica, não afrouxe a comparação. (Sim, isto já foi dito na seção 4 — é importante o suficiente para repetir.)
- **Não existe opção de desabilitar verificação TLS — de propósito** (comentário explícito em `initHttp`, `src/gitlab.ts`). O caminho suportado para certificados privados é `GITLAB_CA_CERT` apontando para um PEM. Nunca adicione um flag de "ignorar certificado".
- **O token nunca aparece em logs nem em saída de tool.** Ele vai apenas no header `PRIVATE-TOKEN` das requisições. Não o inclua em mensagens de erro, logs de debug ou payloads de retorno.
- **Conteúdo escrito por usuários do GitLab é dado, não instrução.** Há duas primitivas de marcação, e a escolha é pela forma da saída:
  - `untrusted()` + `UNTRUSTED_NOTE` para conteúdo em bloco, que ocupa linhas próprias: descrição de MR, corpo de comentário, trace de job. Envelope de várias linhas.
  - `inlineUntrusted()` + `INLINE_UNTRUSTED_NOTE` para texto livre *no meio* de uma linha que o servidor escreveu: nome de job, stage, branch, `failure_reason`. Envelope não cabe aí; a função neutraliza ANSI, quebra de linha e o delimitador, e a nota rotula a resposta.
  - A ordem dentro de `inlineUntrusted` é o controle: ANSI sai **antes** do delimitador. Invertida, um ESC plantado no token derrota o escape e o strip de ANSI depois fabrica um delimitador vivo.
  - Todo campo novo de texto livre vindo do GitLab passa por uma das duas. Nenhum vai cru para a saída.
- Escopos de token documentados em `.env.example`: `read_api` cobre as tools 1–7, 11 e 13; `api` é obrigatório para as três tools de escrita. `get_job_log` (12) exige `api` **por precaução, não por medida** — não foi verificado se `read_api` alcança `/jobs/:id/trace`.
- Segredos ficam fora do repositório: use um `.env` local baseado em `.env.example`. Nunca faça commit de token, `.env` ou qualquer credencial.

## 8. Ações que um agente NÃO pode executar

- **Nunca escrever em stdout** em nenhum ponto do processo do servidor (nem `console.log`, nem `process.stdout.write`). stdout pertence ao protocolo MCP. Use `log()`/`console.error`. Este é o mesmo invariante da seção 4, repetido aqui porque é a forma mais fácil de quebrar o servidor sem perceber.
- **Nunca editar `dist/` à mão.** É saída de compilação; qualquer edição some no próximo `npm run build`.
- **Não adicionar flag para pular verificação TLS**, sob nenhum pretexto.
- **Não mudar o default de `GITLAB_READ_ONLY`** nem enfraquecer `assertWritable()`.
- **Não devolver JSON cru do GitLab** em nenhuma tool nova — sempre projetar com whitelist e truncar textos longos.
- **Não fazer chamadas HTTP fora de `src/gitlab.ts`** — use `gl()` para JSON ou `glText()` para texto; se precisar de outra forma de corpo, adicione uma entrada nova ali sobre o mesmo `request()`, em vez de chamar `fetch` na tool. Um único ponto de saída é o que torna erro, retry e timeout consistentes.
- **Não inventar scripts, ferramentas de lint ou pipelines** que não existem: os únicos comandos são os cinco listados na seção 3.
- **Não logar ou expor o token** em nenhuma circunstância.
- **Não fazer commit de `.env`** ou de qualquer credencial.

## 9. Regras de mensagem de commit

Toda mensagem de commit neste repositório deve seguir as regras abaixo, sem exceção:

- Use o formato Conventional Commits: `type(scope): description`.
- Use modo imperativo: "Add feature", não "Added feature".
- Mantenha a linha de assunto com menos de 50 caracteres.
- Tipos permitidos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`.
- Inclua o escopo quando for relevante (ex.: `api`, `ui`, `auth`).
- Para detalhes adicionais, use uma seção de corpo bem estruturada.
- Use bullet points (`*`) no corpo para dar clareza.

Exemplo:

```
feat(api): add retry with backoff on 429

* Respect Retry-After header, capped at 60s
* Fall back to 5s wait when header is absent
```

## 10. Checklist de conclusão

Antes de considerar qualquer tarefa concluída neste repositório, verifique cada item:

- [ ] `npm run build` passa sem erros de TypeScript (modo `strict`).
- [ ] `npm test` passa (`vitest run` — a suíte cobre `src/diff.ts`).
- [ ] Nenhum código novo escreve em stdout; todo log usa `log()`/`console.error` (stderr).
- [ ] Imports relativos novos terminam em `.js` (exigência do ESM `NodeNext`).
- [ ] Toda tool nova foi registrada em `src/tools/index.ts` via `registerAll`.
- [ ] Toda tool nova de escrita chama `assertWritable()` antes de tocar na rede.
- [ ] Saídas novas usam whitelist (`pick()` ou objeto explícito) — nada de JSON cru do GitLab.
- [ ] Texto livre vindo de usuários do GitLab está envolvido por `untrusted()` e a resposta usa `withUntrustedNote()`.
- [ ] Mensagens de erro novas dizem o que fazer em seguida, no padrão de `src/errors.ts` e `toGitLabError`.
- [ ] Nenhum segredo (token, `.env`) foi adicionado ao repositório.
- [ ] `dist/` não foi editado manualmente.
- [ ] Mensagens de commit seguem as regras da seção 9 (Conventional Commits, imperativo, assunto < 50 caracteres).
