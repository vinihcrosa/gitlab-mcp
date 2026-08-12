# PRD — CI / Pipelines

> **Naming exception.** This template excludes tool names and field names from a
> PRD. This feature is a projection of a CI API into tool output, so the tool
> surface and the field list *are* the product, and both appear below. Transport,
> parsing strategy, and status codes still do not.

## Problem

A reviewer reads a merge request in-session and hits a wall the moment CI turns
red: the server can show the diff and take the comment, but cannot say whether
the branch is green or why it broke. The workflow leaves for a browser at exactly
the point where it was most useful, and comes back with the answer copy-pasted.

Measurement puts a number on it: of 632 recorded CI-adjacent shell invocations,
283 have no equivalent here, and the largest block — 157 calls — is pipeline
status and job logs. This is not a missing feature at the edge of the product; it
is a hole in the middle of the one workflow the product claims.

## Goals

- A reviewer can see whether a merge request's pipeline passed, and which jobs
  failed, in one call without leaving the session.
- A reviewer can read the failing job's log, cleaned of terminal control noise and
  bounded in size, in one further call.
- A developer can see a branch's recent pipelines and tell whether a breakage is
  new or pre-existing.
- The server stops being unable to answer "why is this red?", which today forces
  a browser round trip and a paste.
- Nothing in the server can start, stop, or re-run CI work, and nothing can read
  CI credentials — those remain impossible, not merely unimplemented.

## Non-Goals

Decided against on the merits.

| Not doing | Why |
|---|---|
| Blocking until a pipeline finishes | Holds the single stdio session, cannot agree a bound with the client's own timeout, and would be the first state the server keeps. See the ADR. |
| Triggering, cancelling, or re-running pipelines | A write with high consequence — it consumes runners and can deploy. Low measured volume, high blast radius. |
| Downloading job artifacts | Binary content does not fit in a tool response. |
| Reading or writing CI variables and secrets | Credential surface. Excluded for what it exposes, not for how often it is used. |
| Returning the log of a job that succeeded, by default | Noise. Reachable on demand by naming the job explicitly. |

## Users

**The reviewer** is the primary user, and reads before writing. They need the
verdict first — green or red — and only then the detail. A response that makes
them read a log to discover the pipeline passed has failed them.

**The author of the merge request** needs the failing log specifically, and needs
it to contain the failure rather than the setup. They arrive already knowing it
is red.

**The agent driving the session** is a first-class consumer, not a bystander. It
pays for every line returned out of a finite context budget, cannot scroll, and
cannot ask a follow-up cheaply. Bounded output and a stated truncation are for
its benefit. It also cannot distinguish a job log's contents from its own
instructions unless the response marks the boundary.

**The operator** configures a token once and wants the scope table to be true. A
tool that fails on a permission error the documentation did not predict costs
them a debugging session.

## Requirements

### Pipeline status for a merge request

| ID | Requirement |
|---|---|
| PIPE-01 | The pipeline status response SHALL identify the merge request's most recent pipeline by id, state, commit, trigger source, web address, creation time, and last update time. |
| PIPE-02 | The pipeline status response SHALL list that pipeline's jobs, each with id, name, stage, state, duration, failure reason, and web address. |
| PIPE-03 | IF any job is in a failed state THEN the response SHALL name that job and state the job id needed to retrieve its log. |
| PIPE-04 | IF the merge request has no pipeline THEN the response SHALL state that no pipeline exists and SHALL NOT be an error, because a merge request without CI is a valid state. |
| PIPE-05 | WHILE a pipeline is still executing, the response SHALL report it as running and SHALL include the jobs that have already finished. |
| PIPE-06 | WHERE more than one pipeline exists for the same commit, the response SHALL describe the most recent one. |

### Job log

| ID | Requirement |
|---|---|
| LOG-01 | The job log response SHALL remove terminal colour codes, collapsible-section markers, and per-line timestamp and stream prefixes from the trace before returning it. |
| LOG-02 | IF the cleaned trace exceeds the line ceiling THEN the response SHALL return the final lines up to that ceiling and SHALL state how many earlier lines were dropped. |
| LOG-03 | Truncation SHALL cut between lines and never within one. |
| LOG-04 | The line ceiling SHALL default to 400 and SHALL be overridable per call. |
| LOG-05 | Trace content SHALL be returned inside the server's untrusted-content marker, because a build log contains test output and echoed strings controlled by whoever opened the merge request, and is therefore data rather than instruction. |
| LOG-06 | IF the job produced no trace, because it never started or its log was erased, THEN the response SHALL state which of those happened and SHALL NOT return an empty body. |
| LOG-07 | WHERE a line was rewritten in place by carriage returns, as a progress bar does, only its final state SHALL be kept. |
| LOG-08 | IF the trace cannot be read because the token lacks permission THEN the error SHALL name the scope required, and IF it cannot be read because the log was archived THEN the error SHALL offer the job's web address instead. |

### Pipeline listing

| ID | Requirement |
|---|---|
| LIST-01 | The listing response SHALL describe each pipeline by id, state, branch, commit, trigger source, creation time, and web address. |
| LIST-02 | WHERE a branch or state filter is supplied, filtering SHALL happen at the source rather than over a fetched page, so that paging remains meaningful. |
| LIST-03 | A listing response SHALL carry the server's standard pagination block stating whether more results exist. |

### Documentation

| ID | Requirement |
|---|---|
| DOC-01 | The README and the agent guide SHALL state that reading CI is in scope and that writing to CI is not, replacing the current claim that pipelines are wholly out of scope. |
| DOC-02 | The README's tool inventory and every stated tool count SHALL reflect thirteen tools. |
| DOC-03 | The token scope table SHALL state the scope each new tool requires, including any tool that needs a stronger scope than the other reads. |

## Business rules

- **A merge request with no pipeline is a valid state, not a failure.** Confirmed
  against a real merge request whose pipeline status is null.
- **The most recent pipeline is the answer.** Re-running a commit produces several
  pipelines; only the latest describes the current state of the branch.
- **A running pipeline is a reportable result.** Partial information is returned;
  absence of a final verdict is never an error and never a wait.
- **The line ceiling is 400 by default.** It matches the diff renderer's per-file
  ceiling so the repository has one number, and it is overridable per call.
- **Truncation keeps the tail.** A build fails at its end; the inverse rule from
  the diff renderer would return the setup and discard the failure.
- **Every truncation declares itself.** A response that silently omits content is
  indistinguishable from a complete one, which is the failure mode that matters.
- **Trace content is data.** It is attacker-influenced by construction: anyone who
  can open a merge request can put arbitrary text into a build log.
- **All three tools read.** None passes through the write guard, none issues a
  write, and the read-only mode does not disable any of them.

## Assumptions and open questions

| Assumption | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| The read-only token scope may not reach a job trace | The log tool requires the stronger scope, and the scope table says so | The probe needs a token this session does not hold. Requiring the stronger scope makes the tool exist unconditionally; the alternative removes the feature's entire reason for existing behind a token upgrade | n — probe pending, see Q4 |
| 400 tail lines is enough for a typical failing job | 400, overridable per call | Chosen for consistency with the diff renderer rather than measured against real traces. The override makes a wrong default a parameter away | n — revisit if the override is routinely needed |
| Timestamp and section markers in a trace follow one documented format | Strip the documented format; leave unrecognised prefixes intact | Stripping aggressively risks eating real log content, which is worse than leaving a prefix visible | y |
| Callers want the failing job's log, not every job's | Return a named job's log only | Returning every job's trace would blow any ceiling and bury the failure | y |
| Jobs fit in one page for a single pipeline | No pagination on the job list inside a pipeline response | A pipeline with more jobs than one page is far outside observed shape; the listing tool paginates because a project's pipeline history genuinely grows without bound | y |

**Open questions:** none — all resolved or logged above.

## Architecture Decision Records

- [Pipelines re-enter scope, on measured usage](../../adr/2026-08-12-pipelines-re-enter-scope-on-measured-usage.md) — the documented boundary and the measured workflow disagreed, and the workflow won.
- [Job log truncates from the tail, not the head](../../adr/2026-08-12-job-log-truncates-from-the-tail-not-the-head.md) — a build fails at the end, so the existing head-first rule returns the wrong half.
- [No blocking wait-for-pipeline tool](../../adr/2026-08-12-no-blocking-wait-for-pipeline-tool.md) — no bound is both useful and safe when pipeline duration and client timeout are set by other parties.

## Success criteria

- A reviewer answers "did this merge request's CI pass?" in one call, and "why
  did it fail?" in one more, without opening a browser.
- The 502 KB trace of the known timed-out job comes back inside the ceiling, ends
  on the runner's failure line, and states how many lines it dropped.
- A merge request with no pipeline returns a plain statement of that, and no
  error.
- Measured coverage of CI-adjacent shell usage rises from 349/632 to roughly
  485/632 in the next report.
- The truncation and cleaning logic has unit tests, on the same grounds that make
  the diff parser the only tested module today: it is pure, and wrong output
  looks plausible.
- The README, the agent guide, and the scope table describe thirteen tools and
  the position that CI is readable and not writable.

**The honest failure mode:** the log tool returns 400 lines that do not contain
the failure — because the runner reports it early, or because the tail is
cleanup — and the reviewer opens the browser anyway, having paid context for
nothing. If that becomes the common case, tail-first truncation was the wrong
rule and the feature made the workflow worse rather than better.
