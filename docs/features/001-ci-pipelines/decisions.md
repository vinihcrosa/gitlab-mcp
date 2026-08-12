---
slug: 001-ci-pipelines
tier: full
created: 2026-08-12
---

# Decisions — CI / Pipelines

## Settled

| Decision | Where it lives |
|---|---|
| Pipelines return to scope; the server goes from 10 tools to 13 | [ADR](../../adr/2026-08-12-pipelines-re-enter-scope-on-measured-usage.md) |
| A job log truncates from the tail, on a line boundary, declaring what it dropped | [ADR](../../adr/2026-08-12-job-log-truncates-from-the-tail-not-the-head.md) |
| Nothing blocks waiting for a pipeline to finish | [ADR](../../adr/2026-08-12-no-blocking-wait-for-pipeline-tool.md) |
| Tier is `full`: requirements, design, test contract, task graph | Q1 |
| The project pipeline listing ships in this slice, not a later one | Q2 |
| Default log ceiling is 400 lines, matching the diff renderer, with a caller override | Q3 |
| If the read-only scope cannot read a trace, the log tool requires the stronger scope and the table says so | Q4 |

## Cut, and why

Removed for weight during the prune, not decided against. Anything the author
ruled out on the merits is in the PRD's Non-Goals instead.

| Cut | Why |
|---|---|
| "Whitelist the output fields; never return raw GitLab JSON" as a feature requirement | It is a repository invariant from `AGENTS.md` §4, already binding on all 10 existing tools. Restating it as a requirement of this slice creates a row no test can fail independently, and implies the rule is negotiable per feature. Recorded in `context.md` as inherited instead. |
| "None of the three tools calls the write guard" as a feature requirement | Same reason. The guard exists on three named write tools; a read tool not calling it is the default state of the codebase, not an obligation this feature discharges. |
| Reporting how many pipelines exist for a re-run commit | The decision that matters is *which* pipeline is used — the most recent. The count is a number a reader cannot act on, costing a field on every response to satisfy curiosity in a rare case. The rule to pick the latest survives; the tally does not. |

## Kept under pressure

Considered for cutting and deliberately retained.

| Kept | Why |
|---|---|
| The project pipeline listing | It is the difference between 74% and 87% of measured coverage, and it is the only one of the three that answers "was this already broken before my change?". Cheap: no parser, and the pagination block exists. |
| Collapsing carriage-return progress bars in a trace | It looks like polish and is not. A Docker pull or a package restore rewrites one line thousands of times; without collapsing, the 400-line tail budget is spent on repeated frames of the same line and the failure is pushed out of the window. It is load-bearing for the truncation rule. |
| The `source` field on pipeline output | One field, and it changes how the result is read — a pipeline from a merge-request event and one from a push are not the same evidence about the branch. |
