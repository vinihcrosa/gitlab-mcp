---
title: A second transport entry point for text bodies
date: 2026-08-12
area: transport
summary: gl() gains a text sibling sharing one request core, because a job trace is text/plain and letting a tool call fetch would end the single-HTTP-exit invariant.
feature: 001-ci-pipelines
---
## Context

`gl()` in `src/gitlab.ts` is the only place in the server that issues an HTTP
request. Everything the repository relies on for consistent behaviour lives
inside it: the private-token header, the configured timeout, the single 429 retry
that honours `Retry-After`, the private-CA dispatcher, and the translation of
every status into a Portuguese message that says what to do next.

It is also unconditionally JSON. It sends `Accept: application/json`
(`src/gitlab.ts:117`) and ends with `JSON.parse(text)` (`src/gitlab.ts:168`).

A GitLab job trace is `text/plain`. It is not JSON, it is not JSON-encoded, and
it can be half a megabyte. `JSON.parse` on it throws before any of the feature's
logic runs. Meanwhile `AGENTS.md` §4 states that no tool makes its own `fetch`.

The constraint that forced a decision: the feature's central capability cannot
pass through the only sanctioned door, and the rule forbidding other doors is one
of the invariants the codebase is built on.

## Decision

Extract `gl()`'s shared request logic into an internal `request()` — URL
building, headers, timeout, 429 retry, error translation — and export two entry
points over it. `gl<T>()` keeps its exact signature and JSON behaviour.
`glText()` sends `Accept: text/plain` and returns the body verbatim as a string.

The invariant is restated as what it was protecting all along: **all HTTP leaves
through `src/gitlab.ts`**, not "all HTTP goes through one function".

## Alternatives considered

### Let `get_job_log` call `fetch` directly

- **What it was:** the trace is one endpoint; call it, read the text, done.
- **In favour:** no change to a file every one of the ten existing tools depends on. The smallest possible diff, and zero regression surface.
- **Against:** it would be the only request in the server without the timeout, without the 429 retry, without the private-CA dispatcher, and without translated errors. A self-hosted GitLab behind a private CA — the deployment this server exists for — would fail there and nowhere else, with a raw TLS error.
- **Why it lost:** the invariant is not bureaucracy; it is the reason every failure in this server produces an actionable message. The one endpoint most likely to be slow and large is the worst possible place to opt out of timeouts and retries.

### Add a `raw: true` flag to `gl()`

- **What it was:** one function, one extra option, a conditional parse at the end.
- **In favour:** one exported name to learn, no new surface.
- **Against:** the return type becomes `T | string` depending on a boolean argument, which every existing call site now has to be read against. `gl<Pipeline>(path, { raw: true })` is a type that lies, and TypeScript cannot catch it.
- **Why it lost:** it buys a smaller API by making the type of the result depend on a runtime flag. The compiler stops helping at exactly the call site where a mistake is most expensive.

### Parse the trace as JSON and fall back on failure

- **What it was:** try `JSON.parse`, catch, return the raw text.
- **In favour:** literally no signature change anywhere.
- **Against:** a trace that happens to begin with a JSON-looking token would parse into something meaningless, silently. Build logs contain arbitrary program output, so this is not hypothetical.
- **Why it lost:** it makes correctness depend on the content of an attacker-influenced string. `Accept` and the endpoint are both known in advance; guessing is unnecessary.

## Consequences

### Good

- The trace request inherits timeout, retry, CA handling and error translation for free — including the 403 message that already names the scope a token is missing.
- `gl()`'s signature and behaviour are untouched, so all ten existing tools carry no regression risk.
- A future non-JSON endpoint — an artifact listing, a raw file — has a door already built.

### Bad

- `src/gitlab.ts` grows a second exported entry point, and a reader now has to know which to use. The file was previously understandable as "one function does everything".
- The extraction touches the single most load-bearing function in the repository to serve one caller.

### Risks

- The refactor changes `gl()`'s internals while every existing tool depends on it, and the repository has no integration tests to catch a regression — only the diff parser is tested. Mitigation: `gl()`'s signature, return type and JSON behaviour are unchanged by construction, the extraction is mechanical, and the non-regression criteria in the design name it explicitly. The honest statement is that this is verified by review and by the build, not by a test.
