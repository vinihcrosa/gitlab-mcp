---
title: Pipelines re-enter scope, on measured usage
date: 2026-08-12
area: scope
summary: Pipelines return to scope because measured usage put CI at 157 of 632 gh calls, the largest block with no server equivalent.
feature: 001-ci-pipelines
---
## Context

`README.md:5` and `AGENTS.md` §1 both state that pipelines are out of scope. The
MVP was deliberately narrow — navigate merge requests, leave inline review — and
every capability outside that line was refused on purpose.

A sweep of 633 Claude Code transcripts (13,257 Bash calls) then measured what
actually happens in the workflow the server exists to serve. 632 of those calls
were `gh`, and 283 of them had no equivalent here. The largest single block was
CI: `gh run *` (99) and `gh pr checks` (58), 157 calls together.

The constraint that forced the decision: the documented boundary and the measured
behaviour disagree, and both cannot stand. Either the boundary moves or the
server keeps sending its users to a browser at the moment a pipeline breaks —
which is inside the workflow the MVP claims, not outside it.

## Decision

Reading CI state is in scope. The server gains three read-only tools — pipeline
status for a merge request, a cleaned job log, and a project pipeline listing —
taking it from 10 tools to 13. `README.md` and `AGENTS.md` §1 are updated to
state the new position rather than left to contradict the code.

Writing to CI stays out of scope: nothing triggers, cancels, or re-runs a
pipeline, and nothing reads CI variables or secrets.

## Alternatives considered

### Hold the line and keep pipelines out

- **What it was:** leave the MVP boundary where it is; users keep `gh` and a browser for CI.
- **In favour:** the boundary is the reason the server stayed small and finished. No new surface, no new scope table row, no doc churn.
- **Against:** 45% of measured `gh` usage falls outside the server, and CI is the largest block of it. The boundary is being enforced against the workflow rather than in service of it.
- **Why it lost:** the MVP goal is "review a merge request without opening the browser". A red pipeline is part of reviewing a merge request. The boundary was excluding something it had already claimed.

### Take only the job log

- **What it was:** one tool, `get_job_log`, and nothing else. The user finds the job id however they already do.
- **In favour:** smallest possible slice; the log is the part with no workaround short of the browser.
- **Against:** with no status tool, the caller cannot discover a job id without leaving the session, so the log tool is unreachable from inside the workflow.
- **Why it lost:** it optimises for a small diff rather than for a complete path. The two P1 tools are not independent — one produces the input the other consumes.

### Move CI into a separate MCP server

- **What it was:** a second server, scoped to CI, composed alongside this one.
- **In favour:** the MVP boundary stays literally intact; CI evolves on its own release cadence.
- **Against:** a second token, a second config block in every client, a second process per session — and it would re-implement `gl()`, the error translation, and the scope handling that already exist here.
- **Why it lost:** the cost is entirely in duplication and setup friction, paid by every user, to preserve a sentence in a README.

## Consequences

### Good

- "Did this MR pass, and why not?" is answerable in two calls without leaving the session.
- Measured coverage rises from 349/632 to roughly 485/632 of `gh` usage.
- CI reads reuse `gl()`, the error translation, and the untrusted-content wrapper that already exist.

### Bad

- Two documents that stated a clean, memorable boundary now state a qualified one: pipelines are readable, not writable. Qualified boundaries are harder to hold.
- The tool count grows 30%. Every tool is context the model carries in every session, whether or not CI comes up.

### Risks

- The next measured gap argues for its own reversal on the same reasoning, and the MVP boundary erodes one well-evidenced feature at a time. Mitigation: the write side of CI is refused here explicitly and on stated grounds — consequence, not volume — so the precedent set is "reads that serve MR review", not "whatever the measurement ranks highest".
