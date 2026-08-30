---
title: MR title and branch names are untrusted, everywhere
date: 2026-08-30
area: security
summary: Free text written by whoever opened the MR is marked in every module that emits it, and the classification of each MR field is enforced by a test instead of by review.
issue: 11
---
## Context

The server had two answers for the same class of data. `src/pipelines.ts` wrapped
a pipeline's `ref` in `inlineUntrusted()` and appended `INLINE_UNTRUSTED_NOTE` —
a branch name is free text chosen by the MR author. `src/tools/mrs.ts` emitted
`title`, `source_branch` and `target_branch` raw, next to a `description` that
was carefully wrapped in an `<untrusted>` envelope. `source_branch` and a
pipeline `ref` are frequently the *same string*, written by the same person,
marked in one tool and not in the other.

The exposure through the MR tools is smaller than through the job trace: those
fields go out inside `JSON.stringify`, so a newline cannot forge a server-written
line. What remains is unlabelled attacker-authored text reaching the model — an
MR titled with an instruction, with nothing saying it is data. The project had
already decided this marking is worth its cost; the defect was that the decision
was applied per field, by hand, which is also why it was easy to reintroduce.

## Decision

**Free text authored by whoever opened the MR is marked in every module that
emits it.** Field-by-field judgement is not part of the rule; the only question
is which of the two primitives fits the *shape* of the output:

- Block content, occupying its own lines — MR description, note body, job trace:
  `untrusted()` envelope plus `UNTRUSTED_NOTE` via `withUntrustedNote()`.
- Inline content — a value inside a server-written line, or a JSON value: MR
  title, `source_branch`, `target_branch`, pipeline `ref`, job name, stage,
  `failure_reason`: `inlineUntrusted()` plus `INLINE_UNTRUSTED_NOTE` via
  `withInlineNote()`.

Two consequences follow, and both are the point:

`withInlineNote()` moved from `src/pipelines.ts` to `src/format.ts`. It is no
longer a CI helper — MR responses append the same note — and one note text keeps
the two modules from drifting apart again in wording.

The projection of an MR moved out of the tool file into `src/mrs.ts`, pure and
without I/O, next to `diff.ts`, `trace.ts` and `pipelines.ts`. Every key it
emits is declared in exactly one of two lists: `MR_FREE_TEXT_KEYS` (marked) or
`MR_LIST_SERVER_KEYS` / `MR_GET_SERVER_KEYS` (server-written, raw).
`test/mrs.test.ts` fails when a key appears in the output that is in neither
list, and separately feeds a hostile payload through every free-text key to
check the marking actually happened. Adding an MR field raw is now a red test,
not a missed review comment.

The inline cap for MR fields is 255 — GitLab's own limit for a title and for a
ref name — so no real branch or title is ever truncated, and `list_pipelines(ref=…)`
still receives the exact string the model read from `get_mr`.

## Alternatives considered

### Declare title and branches trusted, and drop `inlineUntrusted(p.ref)`

The issue offered this as the other consistent option, and it is cheaper: one
deletion instead of a module. It was rejected because the premise is false. A
branch name is chosen by the MR author with no validation beyond git's ref
grammar, which permits `</untrusted>` and most punctuation; a title is arbitrary
UTF-8 up to 255 chars. Dropping the marking would also contradict what the same
codebase does two fields away for `description`, and would have to be revisited
the first time any of these fields is rendered outside JSON — where a newline
does forge a line.

### Wrap the fields in place, without extracting `src/mrs.ts`

This fixes today's inconsistency and nothing else. The acceptance criterion asked
for a test that fails when a *new* field is added raw, and there is no way to
write that test against a projection that is inline in an async tool handler and
needs the network to run. Extraction is what makes the rule checkable.

### One giant `untrusted()` envelope around the whole JSON response

Cheapest to apply and impossible to get wrong, but it destroys the distinction
the response is carrying: `iid`, `web_url` and `diff_refs` are server-written and
the model must act on them. Marking everything untrusted marks nothing.
