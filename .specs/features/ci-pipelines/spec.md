# CI / Pipelines — Especificação

> Status: draft, aguardando aprovação. Fase seguinte: Design.
> Origem: medição de uso real em `~/.claude/reports/gh-usage-2026-08-11.md`.

## Problem Statement

O `gitlab-mcp` cobre navegação e review inline de MR, mas não toca em CI. A medição
dos transcripts do Claude Code (633 arquivos, 13.257 chamadas Bash) mostra **632
chamadas `gh`, das quais 283 caem em comando sem equivalente no servidor** — 45% do uso.

O maior bloco isolado é CI: `gh run *` (99) + `gh pr checks` (58) = **157 chamadas**.
É o segundo pilar do fluxo real, depois de ler MR, e hoje obriga a sair para o browser
exatamente no momento em que a pipeline quebra.

Esta spec **reverte uma decisão documentada**: o README e o `AGENTS.md` §1 listam
pipelines como fora de escopo do MVP. A reversão é deliberada, baseada em medição
posterior à decisão, e exige atualizar os dois documentos (ver `CI-09`).

## Goals

- [ ] Responder "a pipeline deste MR passou?" sem abrir o browser — 1 chamada
- [ ] Responder "por que o job quebrou?" com log legível e limitado — 1 chamada
- [ ] Cobrir 136 das 157 chamadas de CI medidas (87%)
- [ ] Nenhum invariante da §4 do `AGENTS.md` violado

## Out of Scope

| Feature | Motivo |
| --- | --- |
| `wait_for_pipeline` / equivalente de `gh run watch` (17 chamadas) | Tool MCP que bloqueia segura a sessão inteira, briga com o timeout do client e obriga o servidor a ter estado. Os três contrariam o desenho de proxy fino. O modelo chama `get_mr_pipeline` de novo. |
| Disparar, cancelar ou re-rodar pipeline (`gh run rerun` = 2, `gh workflow run` = 4) | Escrita. Volume baixo e consequência alta (queima runner, pode fazer deploy). Se entrar um dia, entra atrás de `assertWritable()`. |
| Download de artefatos (`gh run download` = 2) | Binário não cabe em resposta de tool. |
| Variáveis e secrets de CI (`gh secret *` = 9, `gh variable *` = 4) | Superfície de credencial. Fora por segurança, não por volume. |
| Logs de job que não falhou, por default | Ruído. Acessível sob demanda via `job_id` explícito. |

---

## User Stories

### P1: Ver o estado da CI de um MR ⭐ MVP

**User Story**: Como reviewer, quero ver o status da pipeline de um MR e a lista de
jobs numa chamada, para saber se o código está verde antes de gastar tempo lendo o diff.

**Why P1**: É o `gh pr checks` (58 chamadas). Sem isso, todo review começa com uma ida ao browser.

**Acceptance Criteria**:

1. WHEN `get_mr_pipeline(project, iid)` é chamada THEN o servidor SHALL devolver o
   pipeline mais recente do MR com `id`, `status`, `sha`, `source`, `web_url`,
   `created_at`, `updated_at`
2. WHEN o pipeline existe THEN o servidor SHALL listar seus jobs com `id`, `name`,
   `stage`, `status`, `duration`, `failure_reason`, `web_url`
3. WHEN algum job tem `status="failed"` THEN o servidor SHALL destacá-lo e informar o
   `job_id` a passar para `get_job_log`
4. WHEN o MR não tem pipeline nenhuma THEN o servidor SHALL responder que não há
   pipeline para este MR, sem erro — é estado válido (confirmado: `tms-assets-3.0!29`
   tem `pipeline_status: null`)
5. WHEN o pipeline ainda está rodando THEN o servidor SHALL devolver `status="running"`
   com os jobs já concluídos

**Independent Test**: `get_mr_pipeline("tms-3.0/TMS-server", 1)` → pipeline 4454,
status `success`, jobs `dotnet-lint` e `dotnet-test`.

---

### P1: Ler o log do job que quebrou ⭐ MVP

**User Story**: Como reviewer, quero o log do job que falhou já limpo e cortado,
para descobrir a causa sem baixar 500 KB de ruído.

**Why P1**: É o `gh run view` (58 chamadas) — o motivo de existir da feature. Sem log,
o servidor diz que quebrou e não diz por quê.

**Acceptance Criteria**:

1. WHEN `get_job_log(project, job_id)` é chamada THEN o servidor SHALL devolver o trace
   com **códigos ANSI removidos**, **marcadores `section_start:`/`section_end:` removidos**
   e **prefixo de timestamp/stream removido** de cada linha
2. WHEN o trace excede o teto de linhas THEN o servidor SHALL devolver a **cauda**, não a
   cabeça — a falha fica no fim — e SHALL declarar quantas linhas foram cortadas
3. WHEN o corte acontece THEN o servidor SHALL cortar em limite de linha, nunca no meio
   (mesma regra do `src/diff.ts`)
4. WHEN o conteúdo do log é devolvido THEN o servidor SHALL envolvê-lo em
   `<untrusted source="gitlab:job_trace">` — log de build contém saída de teste e `echo`
   controlados por quem abriu o MR, portanto é dado, nunca instrução
5. WHEN o job não produziu trace (não iniciou, ou foi apagado — campo `erased_at`)
   THEN o servidor SHALL dizer isso explicitamente em vez de devolver string vazia

**Independent Test**: job `15965` (`dotnet-test`, `failure_reason=job_execution_timeout`)
tem trace de 502.327 bytes. A resposta tem que caber no teto e terminar em
`ERROR: Job failed: execution took longer than 15m0s seconds`.

---

### P2: Listar pipelines de um projeto

**User Story**: Como dev, quero listar as pipelines recentes de um branch para ver se a
quebra é nova ou já vinha de antes.

**Why P2**: É o `gh run list` (20 chamadas). Útil, mas não bloqueia o review de um MR.

**Acceptance Criteria**:

1. WHEN `list_pipelines(project, ref?, status?)` é chamada THEN o servidor SHALL devolver
   as pipelines com `id`, `status`, `ref`, `sha`, `source`, `created_at`, `web_url`
2. WHEN `ref` ou `status` são passados THEN o servidor SHALL filtrar na API, não localmente
3. WHEN há mais de uma página THEN a resposta SHALL trazer o `pageBlock()` padrão

**Independent Test**: `list_pipelines("tms-3.0/TMS-server", {ref: "dev"})` devolve lista
paginada com `has_more`.

---

## Edge Cases

- WHEN o trace tem `\r` de barra de progresso (Docker pull, `dotnet restore`) THEN o
  servidor SHALL colapsar para a última versão da linha, senão o corte gasta o teto com repetição
- WHEN o token não tem escopo para ler trace THEN a mensagem SHALL dizer qual escopo falta
  (ver `CI-08` — precisa ser verificado, não presumido)
- WHEN o job foi arquivado e o GitLab devolve 403/404 no trace THEN o erro SHALL sugerir
  o `web_url` do job como alternativa
- WHEN o MR tem várias pipelines para o mesmo `sha` (re-run) THEN o servidor SHALL usar a
  mais recente e dizer quantas existem
- WHEN a pipeline foi disparada por `source="merge_request_event"` vs `push` THEN o campo
  `source` SHALL aparecer na saída — muda a interpretação do resultado

---

## Requirement Traceability

| ID | Story | Descrição | Fase | Status |
| --- | --- | --- | --- | --- |
| CI-01 | P1 pipeline | `get_mr_pipeline` devolve pipeline + jobs do MR | Design | Pending |
| CI-02 | P1 pipeline | MR sem pipeline é estado válido, não erro | Design | Pending |
| CI-03 | P1 log | `get_job_log` limpa ANSI, `section_*` e timestamp | Design | Pending |
| CI-04 | P1 log | Truncamento pela cauda, em limite de linha, declarado | Design | Pending |
| CI-05 | P1 log | Trace envolvido em `<untrusted source="gitlab:job_trace">` | Design | Pending |
| CI-06 | P2 lista | `list_pipelines` com filtro de `ref`/`status` e `pageBlock()` | - | Pending |
| CI-07 | transversal | Whitelist explícita de campos; nada de JSON cru do GitLab | Design | Pending |
| CI-08 | transversal | Verificar se `read_api` cobre `/jobs/:id/trace`; documentar o escopo real | Design | Pending |
| CI-09 | transversal | Atualizar README e `AGENTS.md` §1: pipelines saem de "fora de escopo"; 10 tools viram 13 | Design | Pending |
| CI-10 | transversal | As 3 tools são de leitura; nenhuma chama `assertWritable()`, nenhuma faz POST | Design | Pending |

**Cobertura:** 10 requisitos, 0 mapeados para tasks ⚠️ (fase Tasks ainda não rodou)

---

## Restrições herdadas do repositório

Não são negociáveis. Vêm do `AGENTS.md` §4 e §8.

- Todo HTTP passa por `gl()` em `src/gitlab.ts`. Nenhuma tool nova faz `fetch` própria.
- Nada escreve em stdout. Log só via `log()`/`console.error`.
- Imports relativos terminam em `.js` (ESM `NodeNext`).
- Toda tool nova é registrada em `src/tools/index.ts` via `registerAll`.
- Toda saída passa por whitelist (`pick()` ou objeto explícito) e `truncate()`.
- Erro diz o que fazer em seguida, em português, no padrão de `src/errors.ts`.
- Sem dependência nova. A limpeza de ANSI é regex, não pacote.

---

## Success Criteria

- [ ] `get_mr_pipeline` responde o estado da CI de um MR em 1 chamada
- [ ] O log do job `15965` (502 KB) volta legível e dentro do teto, terminando na linha do erro
- [ ] Cobertura medida sobe de 349/632 para ~485/632 no próximo relatório semanal
- [ ] `npm run build` e `npm test` passam
- [ ] O parser de limpeza de trace tem teste unitário — é lógica pura, mesma justificativa
      do `src/diff.ts` ser o único arquivo testado hoje
- [ ] README e `AGENTS.md` refletem 13 tools e a nova posição sobre pipelines

---

## Perguntas em aberto

1. **`CI-08`** — a probe foi feita com token de escopo `api`. Se `read_api` não cobrir
   `/jobs/:id/trace`, a tabela de escopos do README muda e `get_job_log` vira a única
   tool de leitura que exige `api`. Verificar antes do Design.
2. **Teto do log** — 400 linhas por arquivo / 1500 no total é o número do diff. Para trace
   de build, a cauda relevante costuma ser menor. Sugestão: 200 linhas de cauda por default,
   com `max_lines` opcional. A definir no Design.
