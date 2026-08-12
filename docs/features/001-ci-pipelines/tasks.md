# Tasks — 001 CI / Pipelines

**Derived from:** `tdd.md`, `tests.md`
**Status:** draft, awaiting execution

Task numbering matches the "Written by" column of `tdd.md` §Layout. T1, T2 and
T3 have no dependencies and can run in parallel; T4 joins them.

| # | Title | Domain | Complexity | Depends on | Cases |
|---|---|---|---|---|---|
| T1 | Transport: text bodies | source | critical | — | — |
| T2 | Trace cleaning and tail truncation | source | medium | — | UT-01…UT-21 |
| T3 | Projection, availability and rendering | source | medium | — | UT-22…UT-41 |
| T4 | The three tools and their registration | source | medium | T1, T2, T3 | UT-42…UT-45 |
| T5 | README and AGENTS.md | docs | low | T4 | — |

---

## T1 — Transport: text bodies

- [x] T1 — Transport: text bodies

### Overview

Split `gl()`'s request logic into a shared core and add `glText()` beside it, so
a `text/plain` job trace can be fetched without any module outside
`src/gitlab.ts` calling `fetch`. This is one slice because it is one file and one
contract, and it is separate from T4 because it modifies the single choke point
all ten existing tools already depend on — the only change in this feature that
can break behaviour that shipped.

### Requirements

1. MUST keep `gl<T>()`'s exported signature, return type and JSON parsing exactly as they are today.
2. MUST route both entry points through one shared internal request function, so timeout, the single 429 retry, private-CA handling and error translation cannot diverge between them.
3. `glText()` MUST send `Accept: text/plain` and return the body verbatim, with no parsing.
4. `glText()` MUST return the same `GitLabResponse` shape, carrying the page headers `gl()` already reads.
5. MUST NOT add a `raw` flag or any other option that makes the return type depend on an argument value — the ADR rejected that for a reason.
6. MUST NOT change `RequestOptions`, `GitLabResponse` or `Page`.

### Subtasks

- [x] Extract URL building, headers, timeout and the 429 retry into the shared core
- [x] Re-express `gl<T>()` over the core, unchanged in behaviour
- [x] Add `glText()` over the same core with the text `Accept` header
- [x] Confirm error translation still runs before either entry point returns

### Files

Modify `src/gitlab.ts`.

### Tests

None. This is deliberate: the repository has no fixture server, so every path
here reaches the network. Adding a harness for the transport layer is a separate
slice, named as such in `tests.md` §What is deliberately not covered. The gate
reports this at severity info, and that is expected.

What stands in its place: `gl()`'s signature and behaviour are unchanged by
construction, `npx tsc --noEmit` fails on any type break at the ten existing call
sites, and the existing suite still runs.

### Success criteria

`npm run build` and `npx tsc --noEmit` clean. `npm test` still reports 15 passing
diff cases. A reading of the diff confirms `gl()`'s body is the same logic, moved
— not rewritten.

### Completion notes

**Evidence.**

```
$ npx tsc --noEmit
exit 0
$ npm run build
> tsc && chmod +x dist/index.js
$ npm test
 ✓ test/diff.test.ts (15 tests) 4ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

**Shape delivered.** `request(path, opts, accept)` holds url building, headers,
timeout, the 429 retry and error translation, and returns a `Response` already
known to be ok. `gl<T>()` reads it as JSON, `glText()` reads it as text. The only
difference between the two paths is the `Accept` header, expressed as a two-value
`Accept` type rather than a boolean, so neither entry point can be called with a
meaningless combination.

**Conflict resolved.** The author's stated preference is English for repository
artifacts, but `src/gitlab.ts` is entirely Portuguese and `AGENTS.md` §6 requires
error messages in Portuguese — which this file is mostly made of. Mixing
languages inside one module is worse than either choice, so the new comments
follow the file. The preference stands for artifacts written from scratch; it
does not justify a half-translated module.

**Outside the declared files.** Nothing.

**Defects caught.** None. `tsc --noEmit` was the intended guard for the ten
existing call sites and it passed on the first run, which is the expected outcome
for a mechanical extraction — it confirms the guard ran, not that it was
unnecessary.

**Follow-ups.** None.

---

## T2 — Trace cleaning and tail truncation

- [x] T2 — Trace cleaning and tail truncation

### Overview

The pure module behind `get_job_log`: turn a raw trace into cleaned lines, then
keep the tail. It is one slice because cleaning and truncation are meaningless
apart — the line count that truncation bounds only exists after cleaning has
collapsed the progress bars. Independent of everything else in the feature.

### Requirements

1. MUST apply the cleaning steps in the order `tdd.md` §Behaviour states; the order is the contract, not an implementation detail.
2. MUST strip ANSI in both CSI and OSC forms.
3. MUST collapse a carriage-return-rewritten line to its final state only after section markers and ANSI have been removed.
4. MUST treat CRLF as a line ending, never as a rewrite.
5. MUST keep interior blank lines and drop trailing ones.
6. MUST strip a leading ISO-8601 timestamp only when the line starts with one.
7. Truncation MUST keep the last `maxLines` entries and MUST NOT split a line.
8. A truncated render MUST place the notice, naming the dropped count, above the content.
9. MUST NOT import from `gitlab.ts`, `format.ts` or the MCP SDK — invariant 3.
10. MUST NOT add a dependency; ANSI stripping is a regex.

### Subtasks

- [x] Line-ending normalisation and splitting
- [x] Section-marker removal
- [x] ANSI stripping, CSI and OSC
- [x] Carriage-return collapsing
- [x] Leading-timestamp stripping
- [x] Trailing-blank trimming
- [x] `tailLines` with its dropped count
- [x] `renderTrace` composing the two, with the notice placement
- [x] The 21 cases

### Files

Create `src/trace.ts`, `test/trace.test.ts`.

### Tests

UT-01…UT-21.

The three that matter most: **UT-06** pins CRLF as a line ending rather than a
rewrite, which is the one ordering mistake that silently deletes most of a
Windows runner's log. **UT-19** asserts every returned line is byte-identical to
a cleaned source line, which is the case that fails if truncation ever slices
mid-line. **UT-21** is the motivating input — a 502 KB trace whose last line is
the runner's failure — and it is the case that proves the feature does the thing
it exists for.

### Success criteria

All 21 cases pass. `npx tsc --noEmit` clean. `src/trace.ts` has no import from
`gitlab.ts`, `format.ts` or the SDK, checkable by reading its import block.

### Completion notes

**Evidence.**

```
$ npm test
 ✓ test/diff.test.ts (15 tests) 4ms
 ✓ test/trace.test.ts (21 tests) 18ms
 Test Files  2 passed (2)
      Tests  36 passed (36)
$ npx tsc --noEmit
exit 0
```

Invariant 3 holds by inspection: `src/trace.ts` has no import statement at all.

**Ordering confirmed by the cases, not by argument.** UT-03 and UT-04 are what
prove steps 3 and 4 must precede step 5. A GitLab section marker is
`section_start:<ts>:<name>\r\x1b[0K<content>` — collapsing carriage returns first
would keep everything after that `\r`, leaving `\x1b[0K<content>` and then, after
ANSI stripping, the right answer by accident. UT-04 is where the accident stops
working: a line holding only a marker collapses to the escape sequence rather
than to nothing.

**Conflict resolved.** None. `tests.md` and `tdd.md` agreed on every case.

**Outside the declared files.** Nothing.

**Defects caught.** None during implementation. UT-19 was written as a
set-membership assertion over the cleaned source rather than an index comparison,
so it fails on a mid-line cut regardless of where the cut lands — an index
comparison would have passed on an off-by-one that still split a line.

**Follow-ups.** `MAX_TRACE_LINES` is exported and unused until T4 wires it into
the argument schema. That is the intended sequence, not a loose end.

---

## T3 — Projection, availability and rendering

- [ ] T3 — Projection, availability and rendering

### Overview

The pure module behind all three tools: whitelist the fields, decide from job
metadata whether a trace is worth fetching, and render every response. One slice
because the renderers and the projections they consume are one contract — the
render functions are the only consumers of the view types. Independent of T1 and
T2.

### Requirements

1. Projections MUST emit only the whitelisted keys; a key absent from the source MUST stay absent from the view rather than appear with an undefined value.
2. `newest` MUST select by highest id and MUST NOT rely on the input's order.
3. `logAvailability` MUST return `never-started` when the job has no start time, even if the log was also erased — the precedence is fixed.
4. `renderPipeline` MUST name every failed job together with the exact call that reads its log.
5. `renderPipeline` MUST NOT suggest a log call when no job failed.
6. `renderJobLog` MUST wrap the body in the untrusted marker and attach the note exactly once — invariant 7.
7. `renderJobLog` MUST report an empty trace as such rather than emitting an empty untrusted block.
8. `renderPipelineList` MUST render an empty list as a statement, never as an error.
9. MUST NOT perform I/O or import `gitlab.ts` — invariant 4.
10. MUST NOT emit raw GitLab JSON in any rendered output — invariant 9.

### Subtasks

- [ ] `PipelineView` / `JobView` types and their projections
- [ ] `newest` selection by id
- [ ] `logAvailability` with its pinned precedence
- [ ] `renderPipeline`, including the failed-job block
- [ ] `renderPipelineList` with the page block and the empty case
- [ ] `renderJobLog` with untrusted wrapping and the empty-trace case
- [ ] The 20 cases

### Files

Create `src/pipelines.ts`, `test/pipelines.test.ts`.

### Tests

UT-22…UT-41.

The three that matter most: **UT-31** pins the precedence when a job both never
started and was erased — the one ordering the design had to choose and the one a
later reader would otherwise flip. **UT-39** is invariant 7 made checkable: it is
the only case standing between a build log and the model treating it as
instructions. **UT-23** asserts an absent key stays absent rather than becoming
present-and-undefined, which is the difference between a whitelist and a copy.

### Success criteria

All 20 cases pass. `npx tsc --noEmit` clean. `src/pipelines.ts` imports nothing
from `gitlab.ts`.

---

## T4 — The three tools and their registration

- [ ] T4 — The three tools and their registration

### Overview

The I/O layer: argument schemas, fetch orchestration, and wiring the three tools
into `registerAll`. One slice because the three tools share their fetch helpers
and their registration; splitting them would leave two of the three unreachable
until the third landed.

### Requirements

1. MUST fetch through `gl()` and `glText()` only; MUST NOT call `fetch` — invariant 1.
2. `get_mr_pipeline` MUST make no jobs request when the merge request has no pipeline.
3. `get_job_log` MUST make no trace request unless `logAvailability` returns `ready` — invariant 12.
4. `list_pipelines` MUST pass `ref` and `status` to the API as query parameters and MUST NOT filter locally.
5. MUST export the `get_job_log` argument schema so its bounds are checkable without a network fixture.
6. `max_lines` MUST be bounded 1–5000 with a default of 400.
7. Tool descriptions MUST follow the guidance-paragraph style of `src/tools/diff.ts:100-106`: when to use, when not to, and how to recover from truncated output.
8. MUST NOT call `assertWritable()`, issue a non-GET request, or be disabled by read-only mode — invariant 8.
9. MUST NOT implement a version fallback for these endpoints; the prune cut it and the reason is in `decisions.md`.

### Subtasks

- [ ] Fetch helpers: `latestMrPipeline`, `pipelineJobs`, `fetchJob`
- [ ] `get_mr_pipeline`, including the no-pipeline path
- [ ] `get_job_log`, including the never-started and erased paths
- [ ] `list_pipelines` with API-side filtering and the page block
- [ ] The 404-on-trace path, re-raised with the job web url
- [ ] Registration in `registerAll`
- [ ] The 4 registration cases

### Files

Create `src/tools/pipelines.ts`, `test/register.test.ts`. Modify
`src/tools/index.ts`.

### Tests

UT-42…UT-45.

The one that matters most is **UT-42**: it asserts the surface is exactly 13
tools, which catches both halves of a wiring mistake — a new tool that failed to
register, and an existing one dropped while editing `registerAll`. The orchestration
itself — that a no-pipeline response skips the jobs call, that a non-`ready`
availability skips the trace call — is not covered, because asserting it needs
the fixture server this project does not have. Those are invariants 12 and the
design's call sequence, checked in review.

### Success criteria

All 4 cases pass, and the full suite reports 15 + 21 + 20 + 4 = 60 passing cases.
`npm run build` clean. A manual call against a real merge request returns a
pipeline, and a manual call against a known failed job returns its log ending on
the failure line.

---

## T5 — README and AGENTS.md

- [ ] T5 — README and AGENTS.md

### Overview

Make the documentation stop contradicting the code. Both files currently state
that pipelines are out of scope and that the server has ten tools; after T4 both
claims are false. One slice because it is one domain and one reviewer.

### Requirements

1. MUST replace the "pipelines are out of scope" claim in `README.md:5` and `AGENTS.md` §1 with the position the ADR records: CI is readable, not writable.
2. MUST update every stated tool count to thirteen, including `README.md:9`, `:136`, `:160` and `:206`.
3. MUST add the three tools to the README's tool inventory.
4. MUST state, in the token scope table, the scope each new tool requires.
5. MUST NOT claim `read_api` suffices for the job log until the probe has actually been run — the assumption is recorded as unconfirmed in `prd.md`.

### Subtasks

- [ ] Scope statement in both files
- [ ] Tool counts, all four sites
- [ ] Tool inventory rows for the three new tools
- [ ] Token scope table row
- [ ] Cross-check that no other count or scope claim was missed

### Files

Modify `README.md`, `AGENTS.md`.

### Tests

None, deliberately. The deliverable is prose, and a test that greps a README for
a phrase locks the wording without checking that it is true. The gate reports
this at severity info, which is expected for a documentation slice.

What stands in its place: requirement 5 above is the one that can actually be
wrong, and it is checked by reading `prd.md`'s assumptions table.

### Success criteria

`grep -n "10 tools\|dez tools" README.md AGENTS.md` returns nothing. The scope
sentence in both files names CI as readable and not writable. The scope table has
a row for each new tool.
