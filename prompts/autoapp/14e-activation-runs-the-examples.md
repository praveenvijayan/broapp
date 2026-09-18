# 14e — Activation runs the examples it was shown

## Goal

14d found, while writing its one-definition test, that activation and the
preview do not agree on any example that writes. `activate.ts` step 5 starts the
candidate on `data-next` with its gate **paused** and runs the acceptance
examples there. `data-next` is the migrated copy that the switch renames into
place, so it must not be written to; the pause is right. But a paused gate
refuses every write before the route sees it, so an example with a write step
(`items.add`, then a list that shows the row) passes `candidate.check` on the
preview and fails activation with `unavailable`.

Nothing has met this yet only because nothing a backlog built has been
activated. 13c's builders write exactly these examples, one per criterion, and
the host completes a task on them. The first person to press **Activate** on an
application the backlog built is told an example failed that they watched pass.

After this prompt activation runs the examples where the preview ran them: on a
copy that is thrown away, with writes allowed and external effects refused. The
copy that becomes live is still never written to before the switch.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 05 (activation, its phases and
  its crash tests), 12d (decision 6, one definition of "passed"), 14d in full.
- `packages/broapp-autoapp/src/launcher/activate.ts` in full; `journal.ts`
  (`Phase`); `recover.ts` in full, every branch that touches `dataNext`;
  `snapshot.ts` (`snapshotDirectory`: what it copies and how it treats an open
  SQLite database).
- `packages/broapp-autoapp/src/engineer/preview.ts` (`startPreview`: a fresh
  copy of the data, `mode: 'preview'`); `child/run-child.ts` around
  `executionMode`, the `paused` argument and the `invoke` case (`as: 'check'`);
  how a preview child brings its copy to the release's schema, since nothing
  migrates it first.
- `packages/broapp-autoapp/src/engineer/check.ts` as 14d left it:
  `runAcceptance`, `caughtFailure`, the `CHECKING_PAUSE_REASON` guard.
- `packages/broapp-autoapp/src/spec/layout.ts`: `dataNext`, `dataPrev`,
  `preview(releaseId)`.
- `tests/autoapp-activation.test.ts`: the crash-point tests and 14d's test 7.
- `docs/autoapp/design.md`: the paragraph 14d added on what a check proves.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. Where activation runs the examples | On a third directory, `data-check` (`layout.app(id).dataCheck`), made by `snapshotDirectory(app.dataNext, app.dataCheck)` after the migration and before anything else in step 5. A child is started on it with `mode: 'preview'` and **not** paused, the examples run through `runExamples` unchanged, the child is shut down, and the directory is removed — on a pass, on a failure, and on a throw (`finally`). `mode: 'preview'` and not `'live'`: an external effect must be refused here exactly as the preview refused it, or the two disagree again from the other side. |
| 2. The copy that becomes live | Unchanged. After the examples pass, the candidate is started on `data-next`, paused, as today, and asked for its health and nothing else. No example runs there. That start is what proves the release opens the migrated data; the examples prove what it does. |
| Order and cost | Migrate, copy to `data-check`, examples, remove, paused health on `data-next`, switch. One more copy of the data per activation; the preview already pays the same cost on every start. Record the copy's duration in the phase's journal details (`checkCopyMs`) so a slow one can be seen. No size limit and no skipping: an activation that did not run the examples is not one. |
| Journal | No new phase. `checked` covers the copy, the examples and the paused health. Its details gain `checkDir` while the copy exists. A new phase would change what `recover.ts` and every reader of the journal must know, for something that leaves nothing behind. |
| 3. Recovery | `recover.ts` removes `data-check` wherever it removes `data-next`, and also when it finds one with no activation in flight (a crash between the copy and the `finally`). A leftover `data-check` is never renamed, never read, never reported as data the person might want: it holds example rows. One crash point added for the tests, `checked-copy`, thrown after the examples and before the removal. |
| 4. What still differs, and is said | The preview's copy is of the **live** data, brought to the release's schema by the preview child however it does that today; activation's copy is of the data **after `supervisor.migrate`**. If those are two code paths, say so in the report with file and line, and whether a migration could pass one and fail the other. Do not unify them here. Examples also run in order on one copy in both places, so a later example sees an earlier one's rows; that is already true of the preview and stays true. One sentence each in `design.md`, replacing 14d's paragraph that says writes differ. |
| 5. 14d's pause guard stays | `CHECKING_PAUSE_REASON` in `refusalMismatch` can no longer be reached from activation. Keep it: it costs four lines and it is what stops this fault coming back unseen if somebody runs examples on a paused child again. Its test moves from "activation" to a direct call. Remove the unreachable first branch of `refusalMismatch` (`fails === undefined`), which `caughtFailure` already answers. |
| 6. The person is told what failed where | `giveUpBeforeSwitch`'s sentence for a failed example gains nothing; but when the examples pass and the paused health fails, the sentence says the examples passed and the release would not open the migrated data, so the two cannot be confused in the panel. |
| Not in scope | Running examples against a copy of data larger than the disk can hold twice; a progress line during the copy; changing what the preview copies; any change to `packages/broapp`; any change to `runAcceptance`'s judgement. A row in `docs/autoapp/backlog.md` for the first, with what would justify it. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-activation.test.ts tests/autoapp-verify.test.ts tests/autoapp-engineer.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, in `autoapp-activation.test.ts` beside the crash-point tests:

1. A release whose example adds a row and then matches the list with it:
   `candidate.check` passes on the preview **and** activation reaches `serving`.
   Write this test first and watch it fail on the code as it stands.
2. After that activation, the live data does not hold the example's row, and
   `data-check` does not exist.
3. An example that fails: activation gives up before the switch, the previous
   release is still serving, `data-check` and `data-next` are both gone.
4. A `fails` step on a write route that really refuses (14d's form): passes in
   both places. A `fails: {}` on a write that succeeds: fails in both places,
   with the same sentence.
5. An example that calls a route with an `external` effect: refused the same
   way, with the same message, in the preview's check and in activation's.
6. Crash at `checked-copy`: on the next start `recover.ts` removes `data-check`
   and `data-next`, the previous release serves, and the journal ends
   `failed-before-switch`.
7. A stray `data-check` with no activation in flight is removed at start and
   nothing else is touched.
8. The examples pass and the paused start on `data-next` reports a state other
   than `serving`: the sentence names the migrated data, not an example.
9. The journal's `checked` details carry `checkCopyMs`; no phase was added
   (`Phase` is the same list as before).
10. The extended one-definition test from 14d still holds, now including a
    write example.

The smoke: its activation step uses an application whose examples write, if
one of the embedded templates has such an example; if none does, say so and do
not change a template for it.

By hand, no model needed: take 14b's **edits** seed or any root where a backlog
task completed with write examples (14a's run-1 root had `0001` completed), copy
it, build and preview and check the candidate there, then activate it. Record:
the check's result, activation's phases with their times from the journal, the
copy's duration and the data's size, that the live data afterwards holds none of
the examples' rows, and that no `data-check` is left. Then do the same once on
the released v0.4.14 binary against another copy and record the sentence it
fails with, so the report shows the fault and the fix side by side.

## Acceptance criteria

- An example with a write step that passes `candidate.check` passes activation.
- The data that becomes live is never written to before the switch, and holds
  nothing an example wrote.
- An external effect is refused identically in both places.
- `data-check` never outlives an activation, however it ended, and a stray one
  is removed at start.
- No journal phase was added; recovery handles the new directory.
- `tests/ai-chat.test.ts` unchanged; no change to `packages/broapp`;
  `bun run check` green.

## Report

`prompts/autoapp/reports/14e-activation-runs-the-examples.md`: how the preview
brings its copy to the release's schema and whether that path differs from
`supervisor.migrate` (decision 4); what `snapshotDirectory` does with a SQLite
database that has a WAL, since `data-next` was just migrated and closed; the
by-hand activation on both binaries; the copy's cost on the largest data
directory on this machine; and anything else you find where the preview and
activation still judge differently.

## Commit

```
Run the examples at activation where the preview ran them

Activation checked its candidate paused on the copy that becomes live, so
every example that writes passed the preview and failed activation. The
examples now run on a throwaway copy of the migrated data, writes allowed
and external effects refused as in a preview; the copy that becomes live
is still only opened paused and asked for its health. Recovery removes the
throwaway copy wherever it is found.
```

End the commit with the co-author trailer your session's rules give you.
