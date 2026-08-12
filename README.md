# @vinihcrosa/gitlab-mcp

MCP server (stdio) que funciona como proxy fino sobre a **REST API v4** de uma instância **GitLab CE self-hosted**.

MVP com um objetivo só: **navegar merge requests e deixar review inline sem abrir o browser.** Tudo que não serve a isso está fora de escopo (nada de issues, pipelines, criar/mergear MR, aprovações, recursos Premium/Ultimate).

## Como funciona

- 10 tools: 7 de leitura, 3 de escrita.
- Toda resposta passa por **whitelist explícita de campos** — a API do GitLab devolve objetos com 40+ campos e nenhum deles chega cru no contexto do modelo.
- Toda listagem tem `per_page` com default 20 (máximo 100) e informa se há mais páginas.
- **Read-only por default.** As tools de escrita só funcionam com `GITLAB_READ_ONLY=false`.
- O diff sai **parseado, com os números de linha de cada lado impressos** (`old=` / `new=`), porque é isso que torna o comentário em linha confiável.

## Instalação

Não precisa instalar nada: o client MCP executa o pacote via `npx` e o npm cuida do download.

```bash
npx -y @vinihcrosa/gitlab-mcp
```

Rodar esse comando na mão só serve para conferir que sobe — ele fica esperando o protocolo em stdin. A configuração de verdade está em [Configuração no client](#configuração-no-client).

Requer Node >= 20 (usa `fetch` nativo e `AbortSignal.timeout`).

### A partir do código-fonte

Para desenvolver ou rodar um fork:

```bash
git clone https://github.com/vinihcrosa/gitlab-mcp.git
cd gitlab-mcp
npm install     # o script `prepare` já compila
```

O client passa a apontar para `dist/index.js` com caminho absoluto, em vez de `npx`.

## Configuração

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `GITLAB_URL` | sim | — | Base da instância, ex.: `https://gitlab.empresa.com`. Barra final e sufixo `/api/v4` são removidos automaticamente. |
| `GITLAB_TOKEN` | sim | — | Personal Access Token. |
| `GITLAB_READ_ONLY` | não | `true` | Só o literal `false` habilita as tools de escrita. |
| `GITLAB_CA_CERT` | não | — | Caminho para CA privada / cert self-signed em PEM. |
| `GITLAB_TIMEOUT_MS` | não | `20000` | Timeout por request, em ms. |

Falta `GITLAB_URL` ou `GITLAB_TOKEN` → o server escreve o erro em stderr e sai com código 1. Não sobe quebrado.

Veja `.env.example`.

### Escopos do token — leia antes de gerar

| Tools | Escopo mínimo |
|---|---|
| 1–7 (`whoami`, `list_my_projects`, `list_my_authored_mrs`, `list_mrs_awaiting_my_review`, `get_mr`, `get_mr_diff`, `list_mr_discussions`) | `read_api` |
| 8–10 (`comment_on_mr`, `comment_on_mr_line`, `reply_to_mr_discussion`) | **`api`** |

`read_api` **não** escreve. Se você gerar o token com `read_api` e tentar comentar, o GitLab devolve **403** — o server traduz isso para uma mensagem dizendo exatamente que provavelmente é esse o caso, mas o conserto é regerar o token com escopo `api`.

## Configuração no client

MCP stdio não é daemon: você não sobe o servidor, você registra um comando. O client executa esse comando, conversa por stdin/stdout e mata o processo ao fim da sessão.

### Claude Code

Instale global e aponte para o arquivo, com caminhos absolutos:

```bash
npm i -g @vinihcrosa/gitlab-mcp

claude mcp add gitlab -s user \
  -e GITLAB_URL=https://gitlab.empresa.com \
  -e GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx \
  -e GITLAB_READ_ONLY=true \
  -- "$(which node)" "$(npm root -g)/@vinihcrosa/gitlab-mcp/dist/index.js"
```

`-s user` vale em todos os projetos. Use `-s project` só se aceitar que o arquivo `.mcp.json` gerado é commitável — e aí **não** coloque o token nele.

**Por que não `npx` aqui.** Duas armadilhas, as duas silenciosas — o sintoma é sempre `Connection closed`:

1. O bloco `env` **substitui** o ambiente do processo em vez de estender. Sem `PATH`, o `npx` não acha o `node` e morre com `env: node: No such file or directory`. Se insistir no `npx`, passe `-e PATH=/opt/homebrew/bin:/usr/bin:/bin` junto.
2. O client roda o servidor com `cwd` no diretório do projeto. Se esse projeto for **este repositório**, o `npx` resolve o nome para o pacote local em vez do publicado e falha com `command not found`. Só afeta quem desenvolve o próprio pacote, mas custa meia hora para descobrir.

Caminho absoluto para o `node` e para o `dist/index.js` não depende de `PATH` nem de `cwd`, e ainda corta a resolução do `npx` a cada spawn.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/@vinihcrosa/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_URL": "https://gitlab.empresa.com",
        "GITLAB_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx",
        "GITLAB_READ_ONLY": "true"
      }
    }
  }
}
```

Descubra os dois caminhos da sua máquina com `which node` e `npm root -g` — variam entre Homebrew, nvm e Linux. As mesmas duas armadilhas da seção do Claude Code valem aqui.

Rodando a partir do código-fonte, aponte `args` para o `dist/index.js` do seu clone.

Para habilitar review inline, troque para `"GITLAB_READ_ONLY": "false"` (e use um token com escopo `api`).

Com CA privada:

```json
"env": {
  "GITLAB_URL": "https://gitlab.empresa.com",
  "GITLAB_TOKEN": "glpat-...",
  "GITLAB_CA_CERT": "/etc/ssl/certs/empresa-ca.pem"
}
```

Não existe opção de desabilitar verificação TLS. De propósito.

## Testar antes de plugar no client

```bash
npm run build
GITLAB_URL=https://gitlab.empresa.com \
GITLAB_TOKEN=glpat-xxx \
npx @modelcontextprotocol/inspector node dist/index.js
```

O Inspector abre no browser, lista as 10 tools e deixa você chamar cada uma com os argumentos na mão. Se algo falhar aqui, falha no client também — e aqui você vê a mensagem de erro inteira.

Logs do server saem em **stderr** (aba de logs do Inspector). stdout é exclusivo do protocolo MCP.

## Checklist de validação manual

Nesta ordem. Cada passo alimenta o seguinte.

1. **`whoami`** — devolve seu `username`? Se der `Token inválido ou expirado.`, pare aqui.
2. **`list_my_projects`** — anote o `path_with_namespace` de um projeto com MR aberto.
3. **`list_mrs_awaiting_my_review`** — deve listar MRs onde você é *reviewer*. Se vier vazio e você sabe que tem MR esperando: confira que você está como reviewer e não como assignee (são campos diferentes no GitLab).
4. **`get_mr`** com `project` + `iid` (o número da URL, `/-/merge_requests/123`) — confira que `diff_refs` não é `null`.
5. **`get_mr_diff`** com o mesmo `project` + `iid` — deve sair o diff com `old=` / `new=` em cada linha e os `diff_refs` no rodapé. Anote uma linha `add` e uma linha `ctx`.

   A partir daqui precisa de `GITLAB_READ_ONLY=false` e token com escopo `api`.

6. **`comment_on_mr`** — comentário geral. Abra o `web_url` retornado e confirme que apareceu.
7. **`comment_on_mr_line`** numa linha **`add`**: `side="new"`, `line` = o número `new=` daquela linha.
8. **`comment_on_mr_line`** numa linha **`ctx`**: `side="context"`, `line` = o `new=`, `context_old_line` = o `old=` **da mesma linha**. Os dois são obrigatórios — é o erro mais comum.
9. **`list_mr_discussions`** — as duas threads criadas devem aparecer com `position` e `discussion_id`.
10. **`reply_to_mr_discussion`** com um dos `discussion_id` do passo 9.

Se o passo 7 ou 8 falhar, a mensagem de erro diz quais linhas *de fato* existem naquele lado do diff. Não é preciso adivinhar.

## As 10 tools

| # | Tool | Escrita | Resumo |
|---|---|---|---|
| 1 | `whoami` | | Identidade do token. Cacheada no processo. |
| 2 | `list_my_projects` | | Projetos onde você é membro, por atividade recente. |
| 3 | `list_my_authored_mrs` | | MRs que você criou, em todos os projetos. |
| 4 | `list_mrs_awaiting_my_review` | | MRs abertos onde você é **reviewer**. |
| 5 | `get_mr` | | Detalhe do MR, incluindo `diff_refs`. |
| 6 | `get_mr_diff` | | Diff parseado com numeração de linha explícita. |
| 7 | `list_mr_discussions` | | Threads de comentário, com `discussion_id` e posição. |
| 8 | `comment_on_mr` | sim | Comentário geral no MR. |
| 9 | `comment_on_mr_line` | sim | Thread ancorada numa linha do diff. |
| 10 | `reply_to_mr_discussion` | sim | Resposta numa thread existente. |

### Notas de implementação que importam

- **`iid`, não `id`.** Todas as tools de MR usam o `iid` — o número que aparece na URL. O `id` global existe e a API aceita em outros contextos; usar o errado pega o MR de outro projeto ou dá 404.
- **Resolução de projeto.** O path (`grupo/subgrupo/projeto`) é URL-encoded (`%2F`) e resolvido para id numérico, com cache em memória.
- **`comment_on_mr_line` busca `diff_refs` fresco** com um GET do MR imediatamente antes do POST, e nunca aceita os shas como parâmetro: se alguém deu push, os shas velhos invalidam a posição.
- **Validação local antes do POST.** A tool confere que o arquivo está no MR e que a linha existe no lado pedido. Se não existir, falha localmente listando as linhas válidas, em vez de mandar pro GitLab e devolver um 400 opaco. Se mesmo assim vier 400, a mensagem do GitLab volta **na íntegra** junto com o payload enviado.
- **Linha de contexto exige os dois números.** `side="context"` sem `context_old_line` é rejeitado localmente, com o valor correto na mensagem.
- **Prompt injection.** `description` de MR e `body` de comentário são conteúdo escrito por qualquer pessoa com acesso ao GitLab. Vêm envelopados em `<untrusted source="gitlab:...">` e a resposta carrega uma nota dizendo que aquilo é dado, não instrução. Não é blindagem; é o mínimo defensável.
- **Comentário multi-linha está fora de escopo.** Só linha única.

## Testes

```bash
npm test
```

Cobrem só o parser de diff unificado (`src/diff.ts`) — a única lógica pura não-trivial, e a que quebra `comment_on_mr_line` quando erra: hunk misto, múltiplos hunks, arquivo novo/deletado/renomeado, `\ No newline at end of file`, truncamento em 400 linhas e arquivo binário.

Sem testes de integração e sem mock de HTTP — não vale o tempo no MVP.

## Estrutura

```
src/
├── index.ts       # entrypoint stdio. NUNCA escreve em stdout.
├── config.ts      # env, validação no boot, normalização da URL
├── gitlab.ts      # único ponto de saída HTTP: token, timeout, CA, paginação, 429, erros
├── errors.ts      # GitLabError / ToolError
├── projects.ts    # resolveProject + cache path <-> id
├── diff.ts        # parser de diff unificado (puro, testado)
├── format.ts      # whitelist, truncamento, blocos <untrusted>
└── tools/         # as 10 tools, agrupadas por domínio
```
