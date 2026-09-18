# 13d — Fix-ups to the backlog run, from the review of 13c

## Goal

Three faults the review of 13c found in `intent/executor.ts`, and one change the
by-hand run asked for. Nothing new is built.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13a, 13b, 13c.
- `packages/broapp-autoapp/src/intent/executor.ts` in full: `verdictOf`,
  `runTask`. `intent/store.ts`: `recordResult`, `runOrder`, `get`.
- `tests/autoapp-intent-run.test.ts`: how a builder's turn is scripted.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. Earlier tasks' examples must still be there | Today the verdict asks that every check passed and that this task's examples exist. A builder that deletes or renames an earlier task's failing example passes. `verdictOf` gains `required: readonly string[]` — the example ids (`<slug>-c<n>`) of every task of this application already `completed`, from the store — and adds one reason per missing id: "The example 0004-author-column-c2, from a finished task, is gone." The builder's message gains one sentence: "Do not remove or rename an acceptance example that is already there." |
| 2. "The workspace did not change" is judged against the task, not the attempt | `runTask` passes the attempt's own `revBefore` to the verdict. A second attempt that only has to build and check what the first attempt edited is told the workspace did not change, and fails. Pass `task.revBefore ?? revBefore`, the revision before the task's first turn, as `changedLines` already does. |
| 3. Progress earns another attempt | In 13c's by-hand run the second attempt went from none to five of six criteria and was stopped by the clock; the main model's advice was `retry`, and a person had to press Run. Rule: after an attempt that does not complete, if it passed strictly more criteria than the best earlier attempt of this run, it does not count against `TASK_MAX_ATTEMPTS`. Bounded by `TASK_MAX_TURNS = 4` turns per task per run, exported, overridable in the executor's options. The history note says "another attempt: it got further (5 of 6)". |
| 4. A turn that does nothing is ended sooner | The first attempt spent twenty minutes on twelve reads and no edit. New `TASK_IDLE_TIMEOUT_MS = 8 * 60_000`: a turn with no `tool-call` event for that long is aborted, and the verdict's ending sentence is "The turn made no tool call for 8 minutes." A forwarded question waiting for the person pauses the idle clock. The twenty-minute limit stays. This is the executor's own rule; the backlog row about a no-progress limit on an ordinary engineer turn stays deferred, and gains a sentence pointing here for the first measurement. |
| Not in scope | Anything else. No change to the gate, the panel's layout, the tools or the instructions beyond the one sentence in the builder's message. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent-run.test.ts
bun test tests
bun run check
```

New tests in `tests/autoapp-intent-run.test.ts`:

1. `verdictOf` with a `required` id absent from the checks is not completed and
   names it; present and passing, it is.
2. Task two's builder removes task one's example from `autoapp.json` and passes
   its own: task two is not completed, and the reason names the missing example.
3. Attempt one edits and ends without a build; attempt two builds and checks
   with no further edit: completed.
4. Attempts passing 0, then 2, then 3 of 3 criteria: the third attempt happens
   without a person, and the task completes; attempts passing 1, 1: the run
   stops after two; four turns is the ceiling however much each improves.
5. A scripted turn that waits past a short idle limit without a tool call is
   aborted with the idle sentence; one waiting on a forwarded question is not.

## Acceptance criteria

- A task cannot complete by removing a finished task's example.
- A second attempt that only builds what the first edited can complete.
- An attempt that got further than any before it is followed by another without
  a person, up to four turns.
- A turn silent for eight minutes ends with a sentence saying so.
- `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/13d-intent-fixups.md`. Then, by hand, press **Run** on
intent 1 of `reading-list` (it is `stopped` with `0001-author-field`
interrupted) and add the per-task table for the rest of the run to the report.

## Commit

```
Hold a backlog run to its earlier examples, and let progress earn a turn

A task no longer completes if a finished task's example has gone; the
workspace is judged against the task's first turn, not the attempt's; an
attempt that passed more criteria than any before it is followed by another
without a person, up to four turns; a turn with no tool call for eight
minutes is ended and says so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
