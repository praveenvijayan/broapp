# 15d — The evaluation counts what happened

## Goal

Every decision about the knowledge path, the task context and the builder has
been argued from `knowledge evaluate` and the by-hand tables. Two of its numbers
are wrong in a way that favours whichever condition fails fastest.

**An edit that was refused counts as an edit.** `editedBy` in
`knowledge/evaluate.ts` (line ~407) is documented "Whether a call applied an
edit" and returns `true` for any `source.edit` or `source.change`, and for any
cycle whose *input* has hunks or files. The two-turn evaluation passes it as
`stopAfter` (line ~717), and `harness.ts` fires `stopAfter` on the tool's
result whatever the result was. So "turn one ends after the first edit" ends
turn one after the first *refused* edit, with nothing changed, and
`callsToFirstEdit` reports the call that failed. `succeeded()` already exists
twenty lines below and is not used here.

**A turn that was cut short used no tokens.** `packages/broapp/src/ai/host/run.ts`
emits `usage` once, from the stream's `finish` part (line ~826). A turn ended by
the time limit, the idle limit, `stopAfter` or an error never reaches it.
`tokensOf` in `harness.ts` sums what it is given and starts from zero, and
`meanTokens` averages that zero in. 12d's table has a learned `notes-tags` cell
with three timeouts and a mean of 0 tokens; 14b's says "unknown" by hand where
the code says 0.

After this prompt the first edit is the first edit that landed, and a turn's
tokens are a known subtotal with a flag that says whether it is the whole.

Run this after 14d is merged. Independent of 15a–15c.

## Read first

- `prompts/autoapp/00-common-rules.md` (section 3, verifying third-party APIs);
  reports 12d (the table and its caveats), 12j, 14b ("Unknown tokens"), 14c
  (what it did to refused-edit counting, commit `16bf62f`).
- `packages/broapp-autoapp/src/knowledge/evaluate.ts`: `editedBy`, `succeeded`,
  `hunksOf`, `buildOf`, the two-turn block (line ~700), `firstWhere`, every use
  of `editedBy`, the row type (line ~224), the aggregation (line ~860),
  `evaluationTable`.
- `packages/broapp-autoapp/src/knowledge/harness.ts`: `turn`, `stopAfter`,
  `tokensOf`, the `TurnResult` type.
- What `candidate.cycle` returns when its hunks landed and the build failed,
  when a hunk matched nothing, when the person declined, and when the cycle was
  refused as stalled. Read the tool; do not guess from the type.
- `packages/broapp/src/ai/host/run.ts`: `runTurn`, the `fullStream` loop,
  `tally`, where `tally.usage` is read (line ~685), what is emitted after an
  abort and after an error. This prompt names this file: it may change.
- The installed `ai` package's types for the `finish-step` stream part and the
  `onStepFinish`/step-end callback already in use: which carries that step's
  `usage`, and whether it is per step or cumulative. Verify against the
  installed version, not memory.
- `packages/broapp-autoapp/src/knowledge/replay.ts` and any other reader of
  `usage` events or `tokens`.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. `editedBy` means applied | `editedBy(call)` is true only when the call's output shows something landed: `source.edit`/`source.change` that `succeeded`; a cycle whose output reports its patch applied, **including** one whose build then failed — the workspace changed, which is what the two-turn design stops on. A cycle refused before patching, declined, or whose every hunk matched nothing is not an edit. |
| The attempt is still counted | A new `triedEdit(call)` is what `editedBy` was. The row gains `callsToFirstEditTried` beside `callsToFirstEdit`, and `refusedEdits` stays whatever 14c made it. The table shows both first-edit columns. No other column changes meaning. |
| `stopAfter` | Stays `editedBy`, which is now right. The harness is unchanged: it was the predicate that was wrong. |
| 2. Usage per step | `run.ts` adds each completed step's usage to `tally` as the step ends. A turn that reaches `finish` emits exactly what it emits today — one `usage` event with the total, then `done` — so every existing consumer and `tests/ai-chat.test.ts` are untouched. Assert in a test that the summed steps equal `totalUsage`; if the SDK's numbers disagree, keep `totalUsage` for a finished turn and say so. |
| A turn that does not finish | Aborted or failed: one `usage` event with the subtotal of completed steps and `partial: true`, emitted where the turn's end is settled, if the sink can still take it; and `tally.usage` carries the same with the flag, so the run record has it even when the sink cannot. The step that was in flight is not estimated. No completed step → no event, as today. |
| The harness | `tokens` becomes `{ input, output, complete: boolean }`. `complete` is true only when a non-partial `usage` event arrived. |
| The table | `meanTokens` becomes `{ mean, of }` over complete turns only, shown like the existing `{mean, of}` columns: `85,024 (2/3)`. A cell with none shows `— (0/3)`, never `0`. The two-turn `meanTokens` the same. Add `knownTokens`: the mean subtotal over all runs, labelled as a floor. |
| Old results | Reports are history: do not edit 12d's or 14b's tables. One paragraph in `docs/autoapp/learning.md` saying which published numbers this affects and how. |
| Not in scope | Exposing `--tasks`/`--conditions` in the CLI, checkpointing, condition-order counterbalancing, an executor-level evaluation, relabelling `workingCode`/`workflowCompleted`, narrowing the `notes-archive` request. One row each in `docs/autoapp/backlog.md`. No change to what a provider is asked. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-evaluate.test.ts tests/autoapp-engineer.test.ts tests/ai-history.test.ts tests/ai-chat.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests:

1. `editedBy`: a refused `source.edit` (output with `error`), a denied one, a
   cycle refused before patching and a cycle whose hunks all missed are each
   false and each `triedEdit`; a successful edit and a cycle that patched and
   then failed its build are true.
2. Through the harness with a scripted model: refused edit, then a good edit —
   `stopAfter` ends the turn after the second, and the workspace revision has
   moved when it does.
3. `callsToFirstEdit` and `callsToFirstEditTried` differ for that turn.
4. `run.ts`, scripted provider, three steps then finish: events are identical
   to today's, byte for byte, and the step sum equals the total.
5. The same, aborted during step three: one `usage` with steps one and two and
   `partial: true`; aborted during step one: none.
6. The harness marks that turn `complete: false`; the aggregation leaves it out
   of `mean`, counts it in `of`'s denominator, and the table prints `(2/3)`.
7. A cell with no complete run prints `— (0/3)`.

No live-model run is required. If a local model is to hand and the machine is
otherwise idle, one `notes-tags` cell under baseline with a two-minute limit, to
show a partial subtotal from a real provider; say in the report if it was not
done.

## Acceptance criteria

- The two-turn evaluation cannot end its first turn before the workspace has
  changed.
- No table reports zero tokens for a turn that spent some, and no mean includes
  a turn whose total is not known.
- A finished turn's events are unchanged.
- The only file changed in `packages/broapp` is `src/ai/host/run.ts` (and its
  event type, if `partial` needs declaring); `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/15d-count-what-happened.md`: what a cycle returns in
each case and which count as applied; what the SDK reports per step and whether
the sum matched; what reaches the sink after an abort; every published number
this changes the reading of, by report and table, without editing them.

## Commit

```
Count an edit when it lands and tokens only when they are known

editedBy was true for a refused edit, and the two-turn evaluation stopped
its first turn on it, sometimes before anything had changed. Usage was
reported once, at a turn's finish, so a turn that was cut short counted as
zero tokens and was averaged in. An edit is now one that landed, each
step's usage is kept as it ends, and a mean is over the turns whose total
is known, with the count beside it.
```

End the commit with the co-author trailer your session's rules give you.
