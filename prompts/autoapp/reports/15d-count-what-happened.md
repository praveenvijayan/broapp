# 15d — The evaluation counts what happened

## What was built

- **`packages/broapp`, three files.** `src/ai/host/run.ts`: `TurnTally` keeps
  `stepsEnded`, `stepInput` and `stepOutput`, added in `onStepEnd` as each model step ends;
  `partialUsage()` returns their sum marked `partial: true`, or nothing when no step completed.
  A finished turn is unchanged: `tally.usage` is the SDK's `totalUsage`, then one `usage`, then
  `done`. A provider `error` part emits `usage` with the subtotal and `partial: true` before the
  `error` event. A stop, an `abort` part, or a turn that ends any other way without `finish` puts
  the subtotal in `tally.usage` (set in `end()` as a last resort), so the run record carries it.
  `src/ai/shared/contract.ts` (`chatEvent`) and `src/ai/shared/types.ts` (`ChatEvent`) gain
  `partial?: boolean`. See deviation 1: these two are the event type the prompt allows, and
  `types.check.ts` holds them equal.
- **`knowledge/evaluate.ts`.** `triedEdit` is what `editedBy` was. `editedBy` is now: a
  `source.edit` or `source.change` that `succeeded`, or a cycle whose output has a non-empty
  `applied.changed`. The row gains `callsToFirstEditTried`. `meanTokens` becomes
  `{ mean, of }` over runs whose every turn is complete, the two-turn `meanTokens` the same, and
  `knownTokens` is the mean of every run's subtotal. `tokenMean` and `tokensCell` are the
  aggregation and the cell (`85,024 (2/3)`, `— (0/3)`). The table gains the columns
  "calls to first edit tried" and "known tokens (floor)", and one preamble sentence.
  `TwoTurnColumns` gains `tokensComplete`. `stopAfter` stays `editedBy`.
- **`knowledge/harness.ts`.** `tokens` is `{ input, output, complete }`. `complete` is true only
  when a `usage` event without `partial` arrived. With no `usage` event at all, which is what a
  stopped turn gets because its sink is closed, the subtotal is read from the `usage` event the
  tab logged for that run id, and `complete` is false.
- `knowledge/log.ts`: the `usage` allow-list keeps `partial`.
- Docs: `learning.md` (one paragraph: the change, and which published numbers it touches);
  `backlog.md`, seven rows (the six the prompt names, and replay's tokens).
- Tests: `tests/ai-history.test.ts` +4 (the prompt's 4, 5, the error case, and failing at step
  one); `tests/autoapp-evaluate.test.ts` +4 (1; 6 and 7 as pure tests; 2, 3 and 6 end to end
  through the harness in the evaluation child's new `refused-edit` mode).

## What a cycle returns, and which counts as applied

Read from `tools['candidate.cycle']`:

| case | what the harness sees | `editedBy` | `triedEdit` |
|---|---|---|---|
| refused before patching (three cycles ended the same way) | throws `conflict` → `{ error }` | no | yes |
| the patch's own question declined | the gate refuses → `{ error, denied: true }` | no | yes |
| a hunk matched nothing (all-or-nothing, so none applied) | `applyEdits` throws → `{ error }` | no | yes |
| patched, then the build failed | `{ applied: { changed: [...] }, build: { ok: false, … }, … }` | **yes** | yes |
| patched, build or preview declined | `{ applied: { changed: [...] }, build: { declined } }` or `preview: { declined }` | yes | yes |
| patched, built, checked | `{ applied: { changed: [...] }, build: { ok: true }, check }` | yes | yes |
| no hunks, no files (verify) | `{ applied: { changed: [] }, … }` | no | no |
| hunks applied, then a `create` refused because the file exists | throws `rejected` after the hunks landed → `{ error }` | **no** | yes |

The last row is the one gap. The hunks are committed before the file check. The output says
only the error, so the harness cannot see that the workspace moved. It is not an edit by this
rule, which errs toward not stopping turn one. Recorded, not changed: the cycle's order is not
this prompt's.

`refusedEdits` does not exist in `evaluate.ts`. 14c's commit `16bf62f` changed which refusals
the **executor**'s verdict calls edits (`source.edit`/`source.change` only). Nothing in the
evaluation counted refused edits, so there was nothing to keep.

## What the SDK reports per step, and whether the sum matched

Checked in the installed `ai@7.0.93` `dist/index.d.ts`. `onStepEnd` receives a `StepResult`,
whose `usage: LanguageModelUsage` is "the token usage of the generated text": that step's
alone. The `finish-step` stream part carries the same per-step `usage`. The `finish` part
carries `totalUsage`, documented as aggregated across all steps. `run.ts` adds the per-step
figures from `onStepEnd`. That callback runs in the SDK's own pipeline, so it keeps up even
when the event loop is behind a slow sink.

**The sum matched** for the fake provider: three steps of 11 in and 7 out each, and a total of
33 and 21 (test 4). It was not checked against a real provider, since this chain makes no
live-model run. A finished turn still reports `totalUsage`, so a provider whose steps disagree
with its total changes nothing a finished turn shows.

## What reaches the sink after an abort

Nothing. The in-process sink (`Ai.turn`) refuses `emit` once its signal is aborted, and a bridge
stream is closed by then. So a stopped turn's subtotal is in the run record only. `onRunEnd`
gets `detail.usage = { …, partial: true }`, the tab logs it as a `usage` event with `partial`,
and the harness reads it from there. After a provider **error** the sink is still open, and the
turn emits `usage` (the subtotal, `partial: true`) and then `error`. A turn stopped or failed
before any step completed emits nothing and records no usage, as before.

## Published numbers whose reading this changes

The reports are not edited. The `learning.md` paragraph says this; in full:

- **12d, both evaluation tables, "mean tokens".** Every timed-out run was averaged in as 0. A
  cell with some timeouts understates its finished runs by that share. A cell whose runs all
  timed out reads 0 although they spent tokens. In the single run: `baseline` `notes-archive`
  and `notes-tags`, `orientation` `notes-tags`, `orientation+facts` `notes-archive` and
  `notes-tags`. In the three runs: `orientation` and `orientation+facts` `notes-archive`,
  `learned` `notes-tags`.
- **12d's summary sentence, "tokens per finished run fall, on notes-archive from a million to
  eighty thousand", cannot be read as written.** `baseline` notes-archive (1,011,153) averages
  two finished runs with one zero; `learned` (79,886) averages one finished run with two zeros.
  Neither is a per-finished-run figure, and they are not comparable.
- **12d, "calls to first edit"** counted the first attempt, refused or not. "Calls to the first
  edit on notes-archive fall from 17.7 to 11.7" is about first attempts. Under 15d that column
  is now "tried", and "calls to first edit" means landed.
- **12j, the two-turn table.** Turn one stopped at its first attempted edit, which may have been
  refused. So "turn-one calls" and every turn-two column measure a second turn after a first that
  may have changed nothing, and the report cannot say which rows that applies to. Its token
  figures carry the same timeout zeros.
- **14b** wrote "unknown" by hand where the code said 0. That was right, and the code now agrees.
- **Replay** (12d's replay table and any later one): a timed-out run now records the completed
  steps' subtotal where it recorded 0, still printed as if it were a total. That is the backlog
  row, not changed here.

## Deviations, and decisions I made

1. **Two files in `packages/broapp` beyond `run.ts`: `src/ai/shared/contract.ts` and
   `src/ai/shared/types.ts`.** The prompt allows "its event type, if `partial` needs
   declaring", and it does. `run.ts`'s `ChatEvent` is derived from the contract's `chatEvent`
   schema. The host parses every stream event with that schema before it writes it, and `s.object`
   drops an undeclared key. Undeclared, `partial` would reach a browser stripped, and a subtotal
   would read there as a turn's total. `types.check.ts` fails the typecheck unless the contract
   and the hand-written `ChatEvent` in `types.ts` agree, so the one field is declared in both,
   and nothing else in either file changed. **The owner should confirm this reading.** The goal
   for this chain named only `run.ts` for 15d. The prompt names the event type too, and I took
   that as naming these two halves of it.
2. **Test 5's abort case checks the run record, not an event.** After an abort no sink can take
   an event (see above), so the subtotal with `partial` is asserted on `onRunEnd`'s
   `detail.usage`. The same subtotal as an **event** is asserted for a provider failure during
   step three, where the sink is open.
3. **The harness reads a stopped turn's subtotal from the tab's `usage` event.** The fixed
   decision gives the harness the shape and the rule for `complete`, not where a closed sink's
   subtotal comes from. The run record is the one place the prompt puts it.
4. **Two columns keep their meaning by moving to `triedEdit`.** Turn two's "reads before first
   edit", and the "applied in turn one" set behind repeated actions, both used `editedBy`. So
   that "no other column changes meaning", both now call `triedEdit`, which is exactly the old
   predicate.
5. **Existing tests changed in shape, not strength.** The existing "a cycle counts as an edit when it
   carried hunks or files" asserted the old meaning. The same assertions now hold `triedEdit`,
   and new ones hold `editedBy`. The three `twoTurnColumns` tests pass and expect
   `tokensComplete`.
6. **Mutation checks.** With `run.ts` reverted, the two partial-usage tests fail and the
   byte-for-byte test passes. With `editedBy` given its old meaning back, test 1 and the harness
   test fail. Both were restored.
7. **Test 4's expected string was captured from the code before this change**, on the same
   script, and pasted in.
8. **No live-model run.** The prompt offers one `notes-tags` cell on a local model; per this
   chain's rules it was not done. It is deferred to the measurement that follows this series.
9. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Commands run

```
bun run typecheck                                                       exit 0
bun test tests/ai-history.test.ts -t 15d (run.ts reverted)              2 pass, 2 fail
bun test ./tests/autoapp-evaluate.test.ts -t 15d (old editedBy)         2 pass, 2 fail
bun test tests/autoapp-evaluate.test.ts tests/autoapp-engineer.test.ts \
  tests/ai-history.test.ts tests/ai-chat.test.ts                        106 pass, 0 fail
bun test tests                                                          989 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                    dist/broapp-autoapp 77.8 MB, exit 0
bun run scripts/autoapp-smoke.ts                                        every step passed
bun run check                                                           exit 0, 989 pass, 0 fail
git diff --stat tests/ai-chat.test.ts                                   (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| The two-turn evaluation cannot end its first turn before the workspace has changed | pass (test 1; harness test: stopped after call 3, not 2, and turn two reads a new revision). The one case the output cannot show, hunks landed and then a refused `create`, errs toward not stopping |
| No table reports zero tokens for a turn that spent some, and no mean includes a turn whose total is not known | pass (tests 6, 7; harness test: a stopped turn has a positive subtotal and is out of the mean) |
| A finished turn's events are unchanged | pass (test 4, byte for byte; `ai-chat` unchanged and green) |
| The only file changed in `packages/broapp` is `run.ts` and its event type | pass as the prompt words it: `run.ts`, and `partial` declared in the event type's two halves (deviation 1). `ai-chat` unchanged; `bun run check` green |
