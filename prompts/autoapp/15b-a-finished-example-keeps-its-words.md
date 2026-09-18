# 15b — A finished task's example keeps what it says

## Goal

13d made sure a task cannot complete by *removing* a finished task's example:
`finishedExamples` in `intent/executor.ts` (line ~630) collects the ids
`<slug>-<criterion>` of every completed task, and `verdictOf` refuses a verdict
when one of them is gone. It collects ids and nothing else. A later builder that
keeps the id `0001-add-items-c2` and replaces its steps with one that lists an
empty table has removed the example in every way that matters, and the verdict
reads: present, passed, completed.

Nothing has been seen doing this on purpose. It does not need to be on purpose:
a builder whose change breaks an older example is told "The example
0001-add-items-c2 failed" and is one edit to `autoapp.json` away from making
that sentence go away.

After this prompt a completed task's examples are held by what they say, not
only by what they are called.

Run this after 15a is merged.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13c, 13d (the removal rule and
  why it exists), 14c, 14d.
- `packages/broapp-autoapp/src/intent/executor.ts`: `verdictOf` (line ~247) and
  its doc comment, `finishedExamples`, the call at line ~928, `exampleIdFor`,
  what `status.checks` holds (ids, titles, passed — not steps).
- `packages/broapp-autoapp/src/intent/store.ts`: `TaskRecord`, `TaskResult`,
  `recordResult`, the `criteria` rows, `MIGRATIONS` and how one is appended.
- `packages/broapp-autoapp/src/knowledge/evidence.ts` line ~111: the existing
  "first 32 hex characters of the `sha256` of a value's canonical JSON". Use
  it; do not write a second.
- Where the executor can read the acceptance examples of the workspace as built:
  the specification the verified build was made from, not a fresh read of a
  file that may have moved since.
- `packages/broapp-autoapp/src/intent/plan.ts`: `renderPlan`, and the backlog
  document's task section, where a failure's reasons are shown.

## Step 0 — before any change

From every by-hand root that still exists under `tests/.autoapp-run` (13c, 13d,
14a, 14b, 14c), and from git history of the `reading-list` run if it is kept:
for each completed task, did any *later* task change the steps of one of its
examples? For each case found, say whether the change was honest (the output
gained a field and an `expect` had to follow) or a weakening. This number
decides nothing in the table below, but it says how often the rule will stop a
task that did nothing wrong, and the report must carry it. If no root survives,
say so.

## Fixed decisions

| Decision | Value |
|---|---|
| What is kept | When a task completes, for each of its criteria, the hash of the canonical JSON of that example's `steps` as they stood in the specification the verified build was made from. `title` is not part of it: rewording a title weakens nothing. Stored on the criterion's row by a new entry appended to `MIGRATIONS` (`example_hash TEXT`, null allowed); `TaskResult` gains the map; written in the same `recordResult` that writes `revAfter`. |
| What the verdict is given | `required` stops being `string[]` and becomes `{ id, hash: string \| null }[]`; `verdictOf` gains the current examples' hashes by id. It stays pure: the executor reads and hashes, the verdict compares. |
| The rule | For each required example: gone → today's sentence, unchanged. Present with a different hash → `The example <id>, from a finished task, was changed.` Present with the same hash → nothing, and its pass or fail is judged as today. A required example with a null hash (a task completed before this prompt) is held by id only, as today. |
| Order of reasons | The changed sentence comes with the gone sentence, before the per-criterion lines, so the advice question and the next attempt's "The last attempt ended with:" both carry it. |
| The builder is told | `builderMessage` already says "Do not remove or rename an acceptance example that is already there." It becomes "Do not remove, rename or change…". Then one sentence: "If your change makes an older example fail, the change is wrong or the plan is: say which with intent.ask." No other new text. |
| An honest change | Is not something a builder decides. A task whose plan truly requires an older example to change fails with the sentence above, and the person revises. A way for a person to accept a changed example from the panel is **not in scope**: a row in `docs/autoapp/backlog.md`, with Step 0's count as its justification or its absence. |
| The task's own examples | Are not held until it completes: a retry may rewrite them freely. |
| A removed or replaced task | A task replaced with `intent.task` and `replaces`, or removed by the person, stops contributing required examples exactly as it does today. Confirm and test; do not change. |
| Not in scope | Judging whether a *new* example means what its criterion says (no LLM judge: it would agree with the builder); holding examples that belong to no task (the template's, the person's own); the panel control above; activation's checks. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts tests/autoapp-task-context.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside 13d's removal tests in `tests/autoapp-intent-run.test.ts`:

1. `verdictOf`: a required example present with the same hash and passing —
   completed. The same id with another hash — not completed, the sentence, and
   it is not completed even when every check passed.
2. Gone and changed together: both sentences, gone first.
3. A null hash is held by id only.
4. The hash ignores `title` and key order, and changes when a step's `input`,
   `expect`, `match`, `fails` or `view` changes, and when a step is added.
5. Through the executor with a scripted builder: task one completes and its
   hashes are stored; task two keeps task one's ids, weakens one example's
   steps, builds and passes every check — task two is not completed and the
   backlog document names the example.
6. The same, with task two leaving the example alone: completed.
7. A retry of an uncompleted task may rewrite its own examples.
8. The migration: a store written before it opens, and its completed tasks read
   back with null hashes.

## Acceptance criteria

- A completed task's example cannot be changed by a later task without that
  task failing, with a sentence that names the example.
- Removal is refused exactly as before.
- Tasks completed before this prompt behave exactly as before.
- `verdictOf` is still pure and still the one rule.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/15b-a-finished-example-keeps-its-words.md`: Step 0's
cases, each marked honest or weakening; where the executor reads the examples
from and why that is the specification that was built; what a task that must
honestly change an older example now goes through, step by step, and whether
that is tolerable until the backlog row is done.

## Commit

```
Hold a finished task's example by what it says

The verdict refused a task that removed a finished task's example, and
knew that example only by its id: a later builder could keep the id,
replace its steps and complete. Each criterion now keeps the hash of its
example's steps from the build that completed it, and a task that changes
one is not completed and says which.
```

End the commit with the co-author trailer your session's rules give you.
