---
title: Job log truncates from the tail, not the head
date: 2026-08-12
area: output
summary: Job traces truncate from the tail because a build fails at the end, inverting the head-first rule the diff renderer uses.
feature: 001-ci-pipelines
---
## Context

Every truncation in the server today keeps the head and drops the rest:
`truncate()` in `src/format.ts:15` cuts by characters, `renderFiles()` in
`src/diff.ts:245` cuts by lines. That is correct for a diff, where the first
hunks are as interesting as the last, and reading order is the file's order.

A job trace is not that shape. A failing build emits its setup, its dependency
resolution, its test output, and then — in the last handful of lines — the
assertion that failed and the runner's exit message. The observed case is 502,327
bytes of trace whose decisive content is the final line,
`ERROR: Job failed: execution took longer than 15m0s seconds`.

Head-first truncation on that input returns the dependency install and discards
the answer. The constraint is that one repository now needs two truncation
directions, and the existing helper cannot express the second.

## Decision

`get_job_log` returns the **last** N lines of the cleaned trace, not the first.
It cuts on a line boundary, never mid-line, and states how many lines it dropped.
The default is 400 lines, the same number `renderFiles()` uses per file, with an
optional caller override.

The head-first behaviour of `truncate()` and `renderFiles()` is unchanged. The
tail-first logic is new, pure, and unit-tested, on the same grounds `src/diff.ts`
is the only tested module today.

## Alternatives considered

### Keep head-first and reuse `truncate()`

- **What it was:** call the existing helper, accept the first 400 lines.
- **In favour:** no new code, no new test, one truncation rule in the repository.
- **Against:** on the motivating input it returns `dotnet restore` output and drops the failure entirely.
- **Why it lost:** it makes the tool return a correct-looking answer that omits the only thing asked for. A silent wrong answer is worse than no tool.

### Head and tail, with an elision marker in the middle

- **What it was:** first 100 lines and last 300, joined by a `[… N lines omitted …]` marker.
- **In favour:** keeps the job's setup context — image, runner, versions — which sometimes explains the failure.
- **Against:** two bounds to tune instead of one, and the head half is spent on content that is identical across every run of the same job.
- **Why it lost:** the head is predictable and the tail is not. Paying context for the predictable half buys little, and the caller can raise the limit when the setup is genuinely in question.

### Search for the error and window around it

- **What it was:** scan for `ERROR`, `FAILED`, `Traceback` and return the surrounding lines.
- **In favour:** the highest signal per line of any option.
- **Against:** the marker set is per-toolchain and open-ended; a runner whose failure phrasing is not on the list returns nothing, and returning nothing looks the same as passing.
- **Why it lost:** it fails silently on the inputs it does not recognise, and the set of inputs is every CI toolchain anyone runs.

## Consequences

### Good

- The failure is in the response for any job whose runner reports it last, which is the overwhelming majority.
- Cutting on a line boundary means the output is always parseable; no half-line ever reaches the model.
- The dropped-line count is stated, so a caller that needs more knows more exists.

### Bad

- The repository now has two truncation directions, and a reader has to know which applies where. `truncate()` is no longer the answer to "how does this project truncate".
- A job that fails early and then runs a long cleanup phase gets a tail full of cleanup, with the failure cut off above it.

### Risks

- 400 lines was chosen for consistency with the diff renderer, not measured against real traces. Mitigation: the caller override exists from the first release, so a wrong default is a parameter away rather than a code change. If traces routinely need the override, the default is wrong and should be lowered.
