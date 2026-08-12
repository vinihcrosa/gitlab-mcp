# Questions — CI / Pipelines

Each question led with a leaning and the reasoning behind it, so there was
something concrete to disagree with. Effects are scored after the answer.

## Round 1

### Q1 — Tier

Which phases should this slice run? Leaning `full`: three tools, ten
requirements, and a new pure parser that the repository's own standard says
needs a unit test. When two tiers are defensible the larger one wins, and the
safety valve only ever fires for under-sizing.

Cost of `full`: one more phase and a `tasks.md` to maintain. Cost of `design`:
if implementation spans sessions there is no graph to resume from.

**Answer:** `full`.
**Effect:** accepted

### Q2 — Does the project pipeline listing belong in this slice?

The two P1 stories cover 116 of the 157 measured CI calls. The listing adds 20,
reaching the 87% coverage the source draft set as its goal. Leaning: include it.
It is a thin projection with no parser behind it, and the pagination block it
needs already exists.

Cost of including: one more tool to document and test, 13 instead of 12. Cost of
deferring: coverage target drops to 74%, and "is this breakage new or was it
already there?" stays unanswered.

**Answer:** include it.
**Effect:** accepted

### Q3 — Default line ceiling for a job log

Leaning: 200 tail lines with an optional override. A build trace's relevant tail
is short — the assertion and the runner's exit line — and 200 covers it for less
context than the diff renderer's 400.

Cost of 200: a second magic number, different from the 400/1500 the diff uses.
Cost of 400: roughly double the context per call on content with less signal per
line than a diff.

**Answer:** 400, matching the diff renderer.
**Effect:** changed

One number across the repository is easier to defend than two, and "same as the
diff" is a rule a reader can hold. The override absorbs the cases where 400 is
wrong in either direction. This reversed the leaning and is recorded in
[ADR: Job log truncates from the tail, not the head](../../adr/2026-08-12-job-log-truncates-from-the-tail-not-the-head.md).

### Q4 — If the read-only token scope cannot read a job trace

The probe behind this has not been run — it needs a token this session does not
have. Leaning: require the stronger scope for the log tool and document it, so
the tool exists unconditionally and the scope table gains one honest row.

Cost: a read-only token loses one of thirteen tools, and the scope table stops
being "reads need the weak scope, writes need the strong one".

**Answer:** require the stronger scope and document it.
**Effect:** accepted

---

## Round scoring

| Question | Effect |
|---|---|
| Q1 Tier | accepted |
| Q2 Listing in slice | accepted |
| Q3 Log ceiling | changed |
| Q4 Scope fallback | accepted |

One of four changed the design. Both stop signals were checked at the close: no
remaining fork whose answer would change the design, and no concern raised twice.
No second round.
