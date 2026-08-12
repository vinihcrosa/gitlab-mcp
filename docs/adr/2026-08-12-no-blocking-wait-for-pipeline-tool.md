---
title: No blocking wait-for-pipeline tool
date: 2026-08-12
area: scope
summary: The server exposes no blocking pipeline wait because it would hold the session, fight the client timeout, and force the server to keep state.
feature: 001-ci-pipelines
---
## Context

17 of the 157 measured CI calls are `gh run watch` — block until the pipeline
finishes, then report. It is the natural thing to want after pushing, and it is
the one CI capability with real measured demand that this slice refuses.

Three properties of the server make it a poor fit. The transport is stdio, one
request at a time: a tool that blocks for the length of a pipeline holds the
session against every other call. The client enforces its own timeout, which is
shorter than a slow pipeline and not something the server can negotiate. And
`gl()` is a thin, stateless pass-through — a wait loop would be the first thing
in the server to hold state across calls.

## Decision

No tool blocks on pipeline completion. `get_mr_pipeline` returns the current
state — including `running`, with the jobs that have finished so far — and
returns immediately. A caller that wants to know the outcome calls it again.

## Alternatives considered

### `wait_for_pipeline` with a bounded timeout

- **What it was:** poll internally, return when the pipeline settles or the bound elapses, whichever comes first.
- **In favour:** covers the measured 17 calls directly; the caller writes one call instead of a loop.
- **Against:** the bound is either shorter than real pipelines, making it useless, or longer than the client timeout, making it fail as a timeout error rather than a result. Meanwhile the session is held.
- **Why it lost:** there is no bound that is both useful and safe, because the two constraints — pipeline duration and client timeout — are set by other parties and overlap badly.

### Return immediately with a resumable handle the caller polls

- **What it was:** start a watch, return a token, expose a second tool to check it.
- **In favour:** no blocking, and the polling is explicit rather than hidden in a loop.
- **Against:** the token is state, with a lifetime, an eviction policy, and behaviour across restarts to define. It is the first stateful thing in a process that currently has none.
- **Why it lost:** it buys nothing over calling `get_mr_pipeline` again — the same information, obtained the same way — while adding the state the design exists to avoid.

### Let the model loop on `get_mr_pipeline` itself

- **What it was:** what happens by default with no wait tool at all — the model calls again when it wants to know.
- **In favour:** no new surface, no state, no bound to pick. The pacing decision sits with the agent, which knows what else it could be doing.
- **Against:** the model may poll too eagerly and spend calls, or forget to poll at all.
- **Why it won:** the failure modes are visible and correctable in the moment, which is not true of a bound chosen once in a config file.

## Consequences

### Good

- The server stays stateless. Nothing survives a call, so nothing has to be invalidated, evicted, or reconciled after a restart.
- No tool can hold the session hostage. Every call returns in one round trip or fails with a translated error.
- `running` is a first-class result rather than an intermediate state to be hidden, so a caller always learns what is known so far.

### Bad

- The 17 measured `gh run watch` calls are not covered, and the workflow they represent — push, then wait — stays partly outside the server.
- A caller that wants the outcome writes the polling itself, and pays a call each time.

### Risks

- Eager polling turns one `gh run watch` into many `get_mr_pipeline` calls and costs more context than it saves. Mitigation: the tool describes the pipeline's `status` plainly, including `running`, so the model can see that nothing changed rather than inferring it. If polling proves wasteful in practice, the fix is guidance in the tool description, not state in the server.
