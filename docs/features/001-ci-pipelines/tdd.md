# TDD — 001 CI / Pipelines

**Status:** draft, awaiting review
**Depends on:** `context.md`, `prd.md`, `decisions.md`, `questions.md` (round 1)

## Summary

Three read-only tools reach GitLab's pipeline, job and trace endpoints and
project the results as text. Two of the three are thin field projections over
JSON and carry no new logic. The third, the job log, is the whole engineering
problem: a trace is `text/plain`, arrives with terminal control noise, and is
routinely three orders of magnitude larger than a useful answer.

The main trade-off is where the text-body capability lives. `gl()` is the single
HTTP exit and it JSON-parses unconditionally (`src/gitlab.ts:168`), so a trace
cannot pass through it as written. Rather than let one tool make its own `fetch`
— which would end the invariant that makes error translation, timeout, retry and
private-CA handling uniform — this design splits `gl()`'s shared request core out
and adds a second exported entry point beside it. The invariant becomes "all HTTP
leaves through `src/gitlab.ts`", which is what it was actually protecting.
Recorded, with the three alternatives it beat, in
[ADR: A second transport entry point for text bodies](../../adr/2026-08-12-a-second-transport-entry-point-for-text-bodies.md).

This slice exists to learn whether a bounded tail of a build log is enough to
diagnose a failure without opening a browser. It is deliberately not adaptive: no
error-pattern search, no head-and-tail window. If a fixed tail turns out to be
the wrong shape, that is the finding.

## Layout

```
src/
  gitlab.ts          # modified: request core extracted, glText() added
  trace.ts           # new: pure cleaning + tail truncation
  pipelines.ts       # new: pure projection, availability decision, rendering
  tools/
    index.ts         # modified: registerPipelines wired in
    pipelines.ts     # new: schemas, fetch orchestration, registration
test/
  trace.test.ts      # new: unit tests for src/trace.ts
  pipelines.test.ts  # new: unit tests for src/pipelines.ts
  register.test.ts   # new: the registered tool surface, via a fake server
```

| File | Written by | Exists when |
|---|---|---|
| `src/gitlab.ts` | T1 | already exists; gains `glText` and an internal `request` |
| `src/trace.ts` | T2 | new module, no imports beyond node built-ins |
| `test/trace.test.ts` | T2 | alongside `src/trace.ts` |
| `src/pipelines.ts` | T3 | new pure module; no I/O |
| `test/pipelines.test.ts` | T3 | alongside `src/pipelines.ts` |
| `src/tools/pipelines.ts` | T4 | new module registering three tools |
| `src/tools/index.ts` | T4 | already exists; one import and one call added |
| `test/register.test.ts` | T4 | new; exercises `registerAll` against a recorder |
| `README.md`, `AGENTS.md` | T5 | already exist; scope, tool count and scope table updated |

**Why the split into `src/pipelines.ts` and `src/tools/pipelines.ts`.** The
repository already draws this line: `src/diff.ts` is pure and tested,
`src/tools/diff.ts` does I/O and is not. Writing the test contract against a
single combined module exposed the cost of ignoring it — the projection, the
availability decision and the rendering would all have been reachable only
through a network harness this repository does not have, leaving acceptance
groups C, D and E untestable. Splitting them moves those groups into unit tests
against literals.

## Components and boundaries

**`src/gitlab.ts` — transport.** Owns URL building, the private-token header,
timeout, the single 429 retry, and error translation. After this change it
exposes two entry points over one shared core: `gl<T>()` for JSON and `glText()`
for text bodies. Nothing else in the repository issues an HTTP request. Both
entry points share `request()`, so a change to retry or error translation cannot
apply to one and miss the other.

**`src/trace.ts` — pure trace logic.** Cleaning and tail truncation. No I/O, no
imports from `gitlab.ts`, no knowledge of MCP. It is the second module in the
repository that earns a unit test, on the same grounds as `src/diff.ts`: pure,
and wrong output looks plausible.

This could plausibly live inside `src/tools/pipelines.ts`. It does not, because
a function that is testable only by standing up a tool is a function nobody
tests — the exact reason `src/diff.ts` is separate from `src/tools/diff.ts`.

**`src/pipelines.ts` — pure pipeline logic.** Field projection, the decision of
whether a job can have a log at all, and every rendering function. No I/O. Takes
already-fetched objects and returns strings. This is where acceptance groups C, D
and E become checkable.

**`src/tools/pipelines.ts` — the three tools.** Argument schemas, fetch
orchestration, registration. Calls `gitlab.ts` for data and hands the results to
`src/pipelines.ts` and `src/trace.ts` to shape. Nothing depends on it except
`src/tools/index.ts`.

**Boundary rule:** `src/tools/pipelines.ts` may call everything below it.
`src/pipelines.ts` may call `trace.ts` and `format.ts`, never `gitlab.ts`.
`src/trace.ts` may call nothing. Each step down the chain is one more thing
testable with a literal instead of a network fixture.

## Interfaces

### Transport

```ts
// src/gitlab.ts — new internal core, both entry points share it.
async function request(path: string, opts: RequestOptions): Promise<{ res: Response; resource: string }>;

/** Unchanged signature and behaviour. Parses the body as JSON. */
export async function gl<T>(path: string, opts?: RequestOptions): Promise<GitLabResponse<T>>;

/**
 * Same request path, same error translation, same retry. Returns the body
 * verbatim as text. For endpoints that do not answer JSON — today, job traces.
 */
export async function glText(path: string, opts?: RequestOptions): Promise<GitLabResponse<string>>;
```

`RequestOptions`, `GitLabResponse<T>` and `Page` are unchanged. `glText` sends
`Accept: text/plain` where `gl` sends `Accept: application/json`; every other
header is identical.

### Trace

```ts
// src/trace.ts
export const DEFAULT_TRACE_LINES = 400;
export const MAX_TRACE_LINES = 5000;

export interface TraceTail {
  /** Lines kept, in original order. */
  lines: string[];
  /** How many earlier lines were dropped. 0 when nothing was. */
  dropped: number;
}

/** Applies the cleaning contract and returns the cleaned lines, no truncation. */
export function cleanTrace(raw: string): string[];

/** Keeps the last `maxLines` entries. Never splits a line. */
export function tailLines(lines: string[], maxLines: number): TraceTail;

/**
 * cleanTrace + tailLines, rendered as the tool returns it: the truncation
 * notice, when there is one, sits at the top — the kept content is the tail,
 * so the omission is above it.
 */
export interface TraceRender {
  body: string;
  /** Present only when lines were dropped. Rendered OUTSIDE the envelope. */
  notice?: string;
}

export function renderTrace(raw: string, maxLines?: number): TraceRender;

/** Ceilings a line count cannot enforce: one huge line, or a huge trace. */
export const MAX_TRACE_CHARS = 512_000;
export const MAX_LINE_CHARS = 2_000;
```

### Pure pipeline logic

```ts
// src/pipelines.ts
export interface PipelineView {
  id: number;
  status: string;
  sha: string;
  ref: string;
  source?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface JobView {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  failure_reason?: string;
  web_url: string;
}

/** Whitelisting projections. Unknown keys are dropped, missing keys stay absent. */
export function toPipelineView(raw: unknown): PipelineView;
export function toJobView(raw: unknown): JobView;

/** Highest id wins. Endpoint ordering is not contractual, so it is not trusted. */
export function newest(pipelines: RawPipeline[]): RawPipeline | undefined;

export type LogAvailability =
  | { kind: 'ready' }
  | { kind: 'never-started'; status: string }
  | { kind: 'erased'; erasedAt: string; webUrl: string };

/** Decides whether a trace request is worth making, from job metadata alone. */
export function logAvailability(job: RawJob): LogAvailability;

export function renderPipeline(p: PipelineView, jobs: JobView[], label: string, iid: number): string;
export function renderPipelineList(items: PipelineView[], page: Record<string, unknown>): string;

/**
 * Job header plus the already-cleaned trace body, wrapped as untrusted and
 * carrying the note. Wrapping lives here, not in the tool, so invariant 7 is
 * checkable without a network fixture.
 */
export function renderJobLog(job: JobView, trace: TraceRender): string;
```

### Tools

```ts
// src/tools/pipelines.ts
export function registerPipelines(server: McpServer): void;

/**
 * Exported so the argument bounds are checkable without a network fixture.
 * The 1–5000 bound on max_lines is asserted through this, not through zod's
 * own behaviour.
 */
export const jobLogSchema: ZodRawShape;

interface RawPipeline {
  id: number;
  status: string;
  sha: string;
  ref: string;
  source?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

interface RawJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  failure_reason?: string;
  web_url: string;
  started_at?: string | null;
  erased_at?: string | null;
}

/** Newest pipeline of a merge request, or undefined when it has none. */
export async function latestMrPipeline(projectId: number, iid: number, label: string): Promise<RawPipeline | undefined>;

/** Jobs of one pipeline, one page of 100, retried jobs excluded. */
export async function pipelineJobs(projectId: number, pipelineId: number, label: string): Promise<RawJob[]>;

/** Job metadata. Needed before the trace, to tell "never ran" from "erased". */
export async function fetchJob(projectId: number, jobId: number, label: string): Promise<RawJob>;
```

### Registration

```ts
// src/tools/index.ts
registerPipelines(server); // 11, 12, 13
```

### Endpoints

| Call | Endpoint | Body |
|---|---|---|
| `latestMrPipeline` | `GET /projects/:id/merge_requests/:iid/pipelines?per_page=20` | JSON |
| `pipelineJobs` | `GET /projects/:id/pipelines/:pipeline_id/jobs?per_page=100&include_retried=false` | JSON |
| `fetchJob` | `GET /projects/:id/jobs/:job_id` | JSON |
| job trace | `GET /projects/:id/jobs/:job_id/trace` | text |
| `list_pipelines` | `GET /projects/:id/pipelines?ref=&status=&page=&per_page=` | JSON |

No version fallback is implemented for any of these. The memoised-404 pattern in
`src/tools/diff.ts:10-56` exists because `/diffs` landed in GitLab 15.7; every
endpoint above predates GitLab 10. Copying that pattern here would add a branch
that no supported server reaches.

## Data

### Tool arguments

| Field | Tool | Required | Type | Rule |
|---|---|---|---|---|
| `project` | all three | yes | `string` | Full path or numeric id; resolved by `resolveProject` |
| `iid` | `get_mr_pipeline` | yes | `number` int ≥ 1 | Merge request iid, not the global id |
| `job_id` | `get_job_log` | yes | `number` int ≥ 1 | Global job id, as printed by `get_mr_pipeline` |
| `max_lines` | `get_job_log` | no | `number` int 1–5000 | Tail size. Default `DEFAULT_TRACE_LINES` = 400 |
| `ref` | `list_pipelines` | no | `string` | Branch or tag; passed to the API, not filtered locally |
| `status` | `list_pipelines` | no | `string` | Pipeline status; passed to the API |
| `page` | `list_pipelines` | no | `number` int ≥ 1 | Default 1 |
| `per_page` | `list_pipelines` | no | `number` int 1–100 | Default 20 |

### Projected fields

Whitelisted explicitly; no raw GitLab JSON reaches a response.

| Field | Type | Source | Purpose |
|---|---|---|---|
| `id` | `number` | pipeline, job | The handle a follow-up call needs |
| `status` | `string` | pipeline, job | The verdict, or `running` |
| `sha` | `string` | pipeline | Which commit this describes |
| `ref` | `string` | pipeline | Branch, needed by the listing |
| `source` | `string \| undefined` | pipeline | `push` and `merge_request_event` are different evidence |
| `web_url` | `string` | pipeline, job | The escape hatch when the tool cannot answer |
| `created_at` / `updated_at` | `string` | pipeline | Age of the result |
| `name` / `stage` | `string` | job | How a human names the job |
| `duration` | `number \| null` | job | `null` while running, and that is meaningful |
| `failure_reason` | `string \| undefined` | job | `job_execution_timeout` vs `script_failure` changes the next step |
| `started_at` | `string \| null` | job | Derives "never started"; not printed |
| `erased_at` | `string \| null` | job | Derives "log erased"; not printed |

`started_at` and `erased_at` are read and used to choose an error message, never
rendered. Formalising this table is what turned them from output fields into
inputs of a decision.

## Behaviour

### Cleaning contract — the order is part of the contract

Applied by `cleanTrace`, in this order. Changing the order changes the output.

1. Normalise `\r\n` to `\n`, so a Windows runner's line endings are not mistaken
   for progress-bar rewrites in step 4.
2. Split on `\n`.
3. Remove GitLab section markers: a `section_start:<digits>:<name>` or
   `section_end:<digits>:<name>` token and the control sequence that follows it.
4. Strip ANSI escape sequences — CSI (`ESC [ … final-byte`) and OSC
   (`ESC ] … BEL`) forms.
5. Collapse carriage returns within a line: keep only the text after the last
   `\r`. This is what stops a `docker pull` progress bar from consuming the
   entire tail budget.
6. Strip a leading ISO-8601 timestamp prefix, when the whole line starts with one,
   together with the stream marker GitLab appends to it — two digits of section
   depth, `O` or `E` for the stream, and an optional `+` for a continuation
   (`00O `, `01O `, `00O+`). The marker is stripped only when it follows a
   timestamp; alone it is indistinguishable from log content.
7. Drop trailing empty lines. Interior blank lines survive — they are structure.

Steps 3 and 4 run before 5 because a section marker carries its own `\r`, and
collapsing first would leave the marker's tail as the line's content.

### `get_mr_pipeline`

1. Resolve the project.
2. Fetch up to 20 pipelines for the merge request. Sort by `id` descending
   locally and take the first, rather than trusting the endpoint's ordering,
   which is not contractual.
3. If there is none, return the no-pipeline message and stop. One call, not two.
4. Fetch that pipeline's jobs.
5. Render the pipeline header, then jobs grouped by stage in the order the API
   returns them.
6. If any job's status is `failed`, append a block naming each failed job and the
   exact `get_job_log` call that reads it.

### `get_job_log`

1. Resolve the project, fetch the job metadata.
2. If `started_at` is null, return "never started" with the job's status. No
   trace call.
3. If `erased_at` is non-null, return "log erased" with the job's `web_url`. No
   trace call.
4. Otherwise fetch the trace as text, run `renderTrace`, wrap the body in
   `untrusted('job_trace', …)`, and append the untrusted note via
   `withUntrustedNote`.
5. The header carries name, stage, status and `failure_reason` so the caller does
   not need a second `get_mr_pipeline` to interpret the log.

### `list_pipelines`

1. Resolve the project.
2. Pass `ref`, `status`, `page` and `per_page` to the API untouched. No local
   filtering — a locally filtered page makes `has_more` a lie.
3. Render one line per pipeline plus the standard `pageBlock`.

## Failure and edge behaviour

Messages are Portuguese, following `src/errors.ts`: each says what to do next.

| Condition | Detection | Result |
|---|---|---|
| Merge request has no pipeline | empty list from the pipelines endpoint | `MR !<iid> de <label> não tem pipeline. Isso é estado válido: o projeto pode não ter CI, ou a branch não disparou nada.` Not an error. |
| Pipeline still running | `status` is `running`, `pending`, `created` or `preparing` | Normal response; finished jobs listed, unfinished shown with their status and `duration=null` |
| Job never started | `started_at` is null | `Job <id> (<name>) não produziu log: status <status>, nunca começou a executar.` |
| Job log erased | `erased_at` is non-null | `Job <id> (<name>) teve o log apagado em <erased_at>. Veja <web_url> se ainda houver algo lá.` |
| Trace empty although the job ran | trace body is empty after cleaning | `Job <id> (<name>) terminou com status <status> mas o trace veio vazio.` |
| Token lacks scope for the trace | `GitLabError` status 403 from the trace call | Existing 403 translation already names the required scope. `get_job_log` re-raises unchanged. |
| Trace archived or unreachable | `GitLabError` status 404 from the trace call | Caught and re-raised with the job `web_url` appended as the next step |
| `max_lines` out of range | zod schema bound 1–5000 | Rejected by the schema before any network call |
| Trace larger than the ceiling | cleaned line count exceeds `maxLines` | Last `maxLines` lines, preceded by `[truncado: N linhas anteriores omitidas — chame de novo com max_lines maior para ver mais]` |
| Pipeline has more than 100 jobs | jobs page is full | Jobs shown are the first 100; a line states that more exist and names the pipeline `web_url` |

## Invariants

1. Every HTTP request leaves through `src/gitlab.ts`. No module elsewhere calls `fetch`.
2. `gl()` and `glText()` share one request core, so retry, timeout, CA handling and error translation cannot diverge between them.
3. `src/trace.ts` imports nothing from `gitlab.ts`, `format.ts` or the MCP SDK. It is pure and testable with a string literal.
4. `src/pipelines.ts` performs no I/O and never imports `gitlab.ts`. Every function in it is total over its declared input type.
5. Truncation cuts only between lines. No response contains a partial line.
6. Any truncated response states how many lines were dropped.
7. Trace content is always wrapped in the untrusted marker before it reaches the caller — there is no path that returns a raw trace.
8. No tool in this feature calls `assertWritable()`, issues a non-GET request, or is disabled by read-only mode.
9. No response contains raw GitLab JSON; every field is whitelisted at the projection.
10. Nothing writes to stdout. Diagnostics go through `log()`.
11. A merge request without a pipeline is a successful response, never a thrown error.
12. A trace request is made only when `logAvailability` returns `ready`.

## Acceptance criteria

### A. Trace cleaning

1. ANSI colour sequences are absent from returned trace content.
2. `section_start` / `section_end` markers are absent from returned trace content.
3. A line rewritten by carriage returns appears once, in its final state.
4. A leading ISO-8601 timestamp is removed; a timestamp mid-line is not.
5. Interior blank lines survive; trailing blank lines do not.

### B. Truncation

6. A trace under the ceiling returns whole, with no truncation notice.
7. A trace over the ceiling returns exactly `maxLines` lines, and they are the last ones.
8. The truncation notice states the number of dropped lines and precedes the content.
9. No returned line is a fragment of a source line.
10. `max_lines` outside 1–5000 is rejected before any network call.

### C. Pipeline status

11. A merge request with a pipeline yields its id, status, sha, source, web url and timestamps.
12. Jobs are listed with id, name, stage, status, duration and failure reason.
13. A failed job is named, with the `get_job_log` call that reads it.
14. A merge request with no pipeline yields a plain statement and no error.
15. A running pipeline yields `running` plus the jobs that have finished.
16. Given several pipelines for one commit, the one with the highest id is described.

### D. Job log

17. A finished job's log returns cleaned, bounded content wrapped as untrusted.
18. A job that never started returns that fact, and makes no trace request.
19. A job whose log was erased returns that fact with its web url, and makes no trace request.
20. A permission failure on the trace surfaces the scope the token needs.

### E. Listing

21. Pipelines are listed with id, status, ref, sha, source, created time and web url.
22. `ref` and `status` reach the API as query parameters.
23. The response carries the standard pagination block.

### F. Non-regression

24. The ten existing tools keep their current behaviour; `gl()`'s signature and JSON parsing are unchanged.
25. `npm run build` and `npm test` pass, and the existing 15 diff tests still pass.
26. Read-only mode still disables exactly the three write tools, and none of the new three.

## Success criterion

A reviewer diagnoses a failing pipeline from inside the session, without opening
a browser, in the majority of cases over the first month of use. Measured the way
the feature was justified: the next transcript sweep should show CI-related shell
invocations falling, not merely joined by new tool calls.

**The honest failure mode:** the tail returns 400 lines that do not contain the
failure, and the reviewer opens the browser anyway — having paid the context for
nothing. If `max_lines` is routinely raised, or if browser trips do not fall, the
fixed-tail bet was wrong and the design owes an error-window strategy.

## Deferred, with triggers

| Deferred | Revisit when |
|---|---|
| Searching the trace for error markers and windowing around them | The fixed tail measurably misses failures — `max_lines` is routinely raised, or reviewers still open the browser |
| Paginating jobs within one pipeline | A real pipeline exceeds 100 jobs |
| A version fallback for pipeline endpoints | A supported GitLab returns 404 on one of them |
| Mutation testing over `src/trace.ts` | The case list stops catching regressions in review |

## Open, deliberately

- **Whether `read_api` can read a job trace is still unverified.** The probe needs
  a token this session does not hold. The design assumes it cannot and documents
  `api` for `get_job_log`; if the probe later shows otherwise, the change is one
  row in the README scope table and no code.
- **400 lines is inherited, not measured.** It matches the diff renderer for
  consistency. The first real traces read through this tool are the evidence that
  either confirms it or lowers it.
- **Timestamp stripping targets ISO-8601 only.** A runner that prefixes lines in
  another format keeps its prefixes. Widening the pattern risks eating real
  content, which is the worse failure.
