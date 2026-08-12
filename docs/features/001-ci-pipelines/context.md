# Context — CI / Pipelines

## What this is

Three read-only MCP tools that answer two questions about a merge request's CI
without leaving the session: *did it pass?* and *why did it break?*

The server today covers navigating a merge request and leaving inline review. It
stops at the moment the pipeline turns red, which is exactly the moment the
reviewer needs it most.

## Why now

Measured, not assumed. A sweep of Claude Code transcripts (633 files, 13,257 Bash
calls, recorded in `~/.claude/reports/gh-usage-2026-08-11.md`) found 632 `gh`
invocations, 283 of them with no equivalent in this server — 45% of the usage.

The largest single block is CI: `gh run *` (99) plus `gh pr checks` (58) = **157
calls**. That is the second pillar of the real workflow, behind reading the MR
itself.

This slice is not hypothetical for its own authors: the session that produced
this document spent an hour reading GitHub Actions logs through `gh` and a
browser because the tooling could not answer "why did the publish job fail?".

## What it reverses

`README.md:5` and `AGENTS.md` §1 both list pipelines as out of scope for the MVP.
That was a reasonable call at the time and the measurement postdates it. The
reversal is deliberate and costs an update to both documents.

## What it depends on

Facts established by reading the code, not assumed. Each one shapes the design.

| Fact | Source | Consequence |
|---|---|---|
| Every HTTP call goes through `gl()`, which sends `Accept: application/json` and `JSON.parse`s the body | `src/gitlab.ts:117,168` | A job trace is `text/plain`. Either `gl()` grows a text mode or the constraint "no tool makes its own `fetch`" bends. This is the one real architectural question in the slice. |
| Truncation today takes the **head** — `truncate()` by characters, `renderFiles()` by lines | `src/format.ts:15`, `src/diff.ts:245` | A build log fails at the end. Tail-first truncation is new pure logic, and pure logic is the repo's stated bar for a unit test. |
| `untrusted()` and `withUntrustedNote()` already exist | `src/format.ts:40,48` | Wrapping a trace as data rather than instructions is a call, not a feature. |
| `pageBlock()` already exists | `src/format.ts:63` | Paginated listing is a call, not a feature. |
| `assertWritable()` guards only the three write tools | `src/tools/register.ts` | All three new tools read. None touches the guard. This is an invariant to preserve, not work to do. |
| Token scopes are documented per tool: `read_api` covers tools 1–7, `api` is required for writes | `README.md:53-60` | The table has no row for a job trace endpoint. Whether `read_api` reaches it is genuinely unknown and cannot be looked up. |

## Inherited constraints

Non-negotiable, from `AGENTS.md` §4 and §8:

- Nothing writes to stdout. Logging goes through `log()` / `console.error`.
- Relative imports end in `.js` (ESM `NodeNext`).
- Every new tool registers through `registerAll` in `src/tools/index.ts`.
- Every output passes a whitelist (`pick()` or an explicit object) and `truncate()`.
- Errors say what to do next, in Portuguese, following `src/errors.ts`.
- No new dependency. ANSI stripping is a regex, not a package.

## What it is deliberately not

- **Not a way to wait on a pipeline.** A blocking tool holds the whole session,
  fights the client timeout, and forces the server to keep state. The model calls
  the status tool again instead.
- **Not a way to start, cancel, or re-run anything.** That is a write, with high
  consequence — it burns runners and can deploy.
- **Not artifact download.** Binaries do not fit in a tool response.
- **Not CI variables or secrets.** Excluded for credential surface, not volume.
