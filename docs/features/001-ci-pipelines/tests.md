# Test contract — 001 CI / Pipelines

**Derived from:** `tdd.md` §Behaviour, §Failure and edge behaviour, §Invariants, §Acceptance criteria
**Status:** draft, awaiting review

**Levels.** `UT-` unit, in `test/`, run by `vitest run`. This project has no
integration tier and this feature does not add one — there is no fixture server,
and standing one up to assert what the unit cases already pin would be ceremony.
What that leaves uncovered is named at the end, honestly, rather than papered
over with a tier nobody runs.

The design pushes projection, decision and rendering into pure modules precisely
so this contract can be written against literals. Every case below runs offline.

---

## A. `cleanTrace` — the cleaning contract

`test/trace.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-01 | `"\x1b[32mok\x1b[0m"` | `["ok"]` — CSI colour sequences gone |
| UT-02 | `"\x1b]0;building\x07done"` | `["done"]` — OSC sequence and its BEL terminator gone |
| UT-03 | `"section_start:1699999999:build\r\x1b[0Kcompiling"` | `["compiling"]` — marker and its control tail gone, content kept |
| UT-04 | `"section_end:1699999999:build\r\x1b[0K"` alone | `[]` — nothing but a marker leaves nothing |
| UT-05 | `"a\rb\rc"` | `["c"]` — only the final state of a rewritten line |
| UT-06 | `"one\r\ntwo\r\n"` | `["one", "two"]` — CRLF is a line ending, not a rewrite |
| UT-07 | `"2026-08-12T03:37:08.0175781Z npm error"` | `["npm error"]` — leading ISO-8601 prefix stripped |
| UT-08 | `"failed at 2026-08-12T03:37:08Z during step"` | unchanged — a timestamp not at line start survives |
| UT-09 | `"a\n\nb"` | `["a", "", "b"]` — interior blank lines are structure |
| UT-10 | `"a\n\n\n"` | `["a"]` — trailing blank lines dropped |
| UT-11 | `""` | `[]` |
| UT-12 | `"\x1b[0Kplain"` where the section marker is absent but its control tail is present | `["plain"]` — stripping is per-mechanism, not dependent on the marker |

## B. `tailLines` and `renderTrace` — truncation

`test/trace.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-13 | `tailLines(["1"…"10"], 3)` | `lines` is `["8","9","10"]`, `dropped` is `7` |
| UT-14 | `tailLines(["1"…"5"], 400)` | all five lines, `dropped` is `0` |
| UT-15 | `tailLines([], 400)` | `lines` empty, `dropped` is `0` |
| UT-16 | `tailLines(["1"…"10"], 10)` | all ten, `dropped` is `0` — the boundary is inclusive |
| UT-17 | `renderTrace` over 500 cleaned lines, `maxLines` 400 | first output line names 100 dropped lines; exactly 400 content lines follow |
| UT-18 | `renderTrace` over 12 lines, `maxLines` 400 | no line begins with the truncation marker |
| UT-19 | `renderTrace` over 500 lines, `maxLines` 400 | every content line is byte-identical to a line of the cleaned input — no fragments |
| UT-20 | `renderTrace(raw)` with `maxLines` omitted | behaves as `maxLines` 400 |
| UT-21 | `renderTrace` over a 502 KB trace ending in `ERROR: Job failed: execution took longer than 15m0s seconds` | last content line is that error line |

## C. Projection and selection

`test/pipelines.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-22 | `toPipelineView` on an object carrying the eight whitelisted keys plus `user` and `detailed_status` | exactly the eight keys present; `user` and `detailed_status` absent |
| UT-23 | `toPipelineView` on an object with no `source` | `'source' in view` is `false` — absent, not present-and-undefined |
| UT-24 | `toJobView` on a running job with `duration: null` | `duration` is `null` and the key is present |
| UT-25 | `toJobView` on a successful job with no `failure_reason` | `'failure_reason' in view` is `false` |
| UT-26 | `newest([{id:10},{id:42},{id:7}])` | the object with `id` 42 — input order is not trusted |
| UT-27 | `newest([])` | `undefined` |

## D. `logAvailability` — whether a trace request is worth making

`test/pipelines.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-28 | job with `started_at: null`, `status: "manual"` | `{kind:"never-started", status:"manual"}` |
| UT-29 | job with `started_at` set and `erased_at: "2026-08-01T10:00:00Z"` | `{kind:"erased", erasedAt:"2026-08-01T10:00:00Z", webUrl:<job url>}` |
| UT-30 | job with `started_at` set and `erased_at: null` | `{kind:"ready"}` |
| UT-31 | job with `started_at: null` **and** `erased_at` set | `{kind:"never-started"}` — precedence is pinned, never-started wins |

## E. Rendering

`test/pipelines.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-32 | `renderPipeline` with one job `status: "failed"`, name `dotnet-test`, id 15965 | output names `dotnet-test` and contains a `get_job_log` call carrying `job_id=15965` and the project label |
| UT-33 | `renderPipeline` where every job is `success` | output contains no `get_job_log` suggestion |
| UT-34 | `renderPipeline` with pipeline `status: "running"` and one finished plus one running job | output reports `running`, lists the finished job with its duration, and the running job without inventing one |
| UT-35 | `renderPipeline` with two failed jobs | both are named, each with its own job id |
| UT-36 | `renderPipeline` on any input | output contains no `{` `}` pair carrying a raw source key such as `detailed_status` — invariant 9 |
| UT-37 | `renderPipelineList` with three pipelines and a page block where `has_more` is true | three lines rendered, and the page block states the next page |
| UT-38 | `renderPipelineList` with an empty list | states that no pipeline matched; does not throw |
| UT-39 | `renderJobLog(job, "boom")` | body appears inside `<untrusted source="gitlab:job_trace">`, and the untrusted note appears exactly once |
| UT-40 | `renderJobLog` for a job with `failure_reason: "job_execution_timeout"` | header carries name, stage, status and that failure reason |
| UT-41 | `renderJobLog(job, "")` for a job that ran and finished | states that the trace came back empty, rather than emitting an empty untrusted block |

## F. Registration — the tool surface

`test/register.test.ts`

A fake server object recording `registerTool` calls. No network, no config: every
call site funnels through `src/tools/register.ts:25`, and `isReadOnly()` is
reached only from `assertWritable()` at call time, never during registration.

| ID | Input / condition | Expected |
|---|---|---|
| UT-42 | `registerAll` against a recorder | exactly 13 names recorded, no duplicates |
| UT-43 | the recorded names | contain the ten pre-existing names and the three new ones — `get_mr_pipeline`, `get_job_log`, `list_pipelines` |
| UT-44 | `registerAll` while read-only mode is active | still 13 — read-only gates at call time through `assertWritable`, never at registration |
| UT-45 | the exported `get_job_log` argument schema parsing `{project:"g/p", job_id:1, max_lines:6000}` | rejected; `max_lines: 400` accepted; `max_lines` omitted accepted |

## Coverage matrix

| Criterion | Cases |
|---|---|
| 1 ANSI absent | UT-01, UT-02, UT-12 |
| 2 section markers absent | UT-03, UT-04 |
| 3 carriage-return line appears once | UT-05, UT-06 |
| 4 leading timestamp stripped, mid-line kept | UT-07, UT-08 |
| 5 interior blanks kept, trailing dropped | UT-09, UT-10 |
| 6 under ceiling returns whole | UT-14, UT-18 |
| 7 over ceiling returns the last N | UT-13, UT-17, UT-21 |
| 8 notice states the count and precedes content | UT-17 |
| 9 no fragment lines | UT-19 |
| 10 `max_lines` out of range rejected | UT-45 |
| 11 pipeline fields projected | UT-22, UT-23 |
| 12 job fields projected | UT-24, UT-25 |
| 13 failed job named with its log call | UT-32, UT-35 |
| 14 no pipeline is not an error | UT-27, UT-38 |
| 15 running pipeline lists finished jobs | UT-34 |
| 16 highest id wins for one commit | UT-26 |
| 17 log cleaned, bounded, wrapped untrusted | UT-39, UT-40, UT-41 |
| 18 never-started reported, no trace call | UT-28, UT-31 |
| 19 erased reported with web url, no trace call | UT-29 |
| 20 permission failure names the scope | none — see exclusions |
| 21 listing fields projected | UT-37 |
| 22 `ref` and `status` reach the API | none — see exclusions |
| 23 pagination block present | UT-37 |
| 24 existing tools unchanged | UT-42, UT-43 — a dropped registration is caught |
| 25 build and existing suite pass | the existing 15 diff cases, unchanged |
| 26 read-only still gates exactly three tools | UT-44 — registration side only |

45 cases. **The thinnest row is criterion 15** — one case for a running
pipeline, which is the state a reviewer hits most often in practice and the one
with the most shapes (nothing started, some finished, one running, one manual).
It is the first place to add a case when this feature grows.

Criterion 26 is the second thinnest and the more honest worry: UT-44 proves
read-only does not change *registration*, which is not the same as proving it
still gates the three write tools at call time. That half remains uncovered, for
the reason in the exclusions below.

## What is deliberately not covered

Named with the reason and what stands in its place, because an honest exclusion
is worth more than a case that asserts nothing.

| Not covered | Why | What stands in its place |
|---|---|---|
| Criterion 20, the 403 scope message | It is `gl()`'s existing translation, unchanged by this feature. Asserting it here would lock behaviour this feature does not own. | Non-regression: `gl()`'s error path is untouched by construction. |
| Criterion 22, filters reaching the API | Asserting a query string requires intercepting the request, which needs the fixture server this project does not have. | The tool passes the arguments through to `gl()`'s `query` with no local filtering; review checks the call site. |
| Criterion 26, read-only gating at call time | Proving `assertWritable` still throws for the three write tools means invoking their handlers, which reach the network on the line after the guard. That needs the fixture server this project does not have. | UT-44 covers the registration half. The guard itself is untouched by this feature. |
| The ten existing tools' behaviour | There are no tests over them today; building that harness is a separate slice, not a rider on this one. | UT-42 and UT-43 catch a *dropped* tool. `gl()`'s signature and JSON behaviour are unchanged by construction, and the build fails on a type break. |
| That `logAvailability` non-`ready` actually skips the network call | The decision is unit-tested; the *skipping* is control flow in the tool layer. | Invariant 12, checked in review. |
| Any assertion over tool description text | Grepping a description for a phrase locks the wording without checking behaviour. | Whether the descriptions work is answered by use. |

## Shaped for what comes later

An adversarial pass — mutating `src/trace.ts` and `src/pipelines.ts` and
confirming these cases kill the mutants — is deferred, not abandoned. Every case
above names an exact expected value rather than "returns something", so a
mutation that flips a boundary, drops a strip step, or reverses the tail into a
head breaks at least one case. UT-13, UT-16, UT-19 and UT-31 exist specifically
to be boundary kills.
