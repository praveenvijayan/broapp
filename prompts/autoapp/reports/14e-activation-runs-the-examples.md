# 14e — Activation runs the examples it was shown

## What was built

- `spec/layout.ts`: `AppLayout.dataCheck` = `apps/<appId>/data-check`.
- `launcher/activate.ts` step 5: `runExamplesOnCopy` removes any stale `data-check`, copies
  `data-next` there with `snapshotDirectory` (timed), starts a child in `mode: 'preview'`, not
  paused, runs `runAcceptance` unchanged, then shuts the child down and removes the copy in a
  `finally`. The `finally` is skipped only for the `checked-copy` crash point, thrown after the
  examples and before the removal. Then the candidate starts on `data-next`, paused, and only
  its health is asked for. No example runs there.
- `launcher/journal.ts`: no new phase. `checked` now records `checkDir` while the copy exists
  and clears it afterwards (a `null` here is written, not ignored), plus `checkCopyMs`. The two
  columns are added with `ALTER TABLE` to a journal an earlier launcher made.
- `launcher/recover.ts`: `data-check` is removed in every branch that removes `data-next`.
  After the loop over unfinished activations, `removeStrayCheckCopies` removes any
  `data-check` under `apps/` (valid ids only) and logs one line for each.
- `engineer/check.ts`: `refusalMismatch` takes `fails` and loses its unreachable
  `fails === undefined` branch. The pause guard stays, with a comment saying why.
- Docs: `design.md` loop step 6 and "What a check proves" (14d's paragraph replaced, one
  sentence for each difference); a new `backlog.md` row for data too large to copy twice.
- Tests: 8 new in `autoapp-activation.test.ts` (prompt 1–9), 14d's one-definition test
  extended with a write step (10), and the pause guard as a direct call in `autoapp-verify.test.ts`.

Test 1 was written first and failed on the old code with exactly the prompt's fault:
`checked: an acceptance example failed: add-then-list: the application is being checked`.

## Decision 4: two ways a copy reaches the release's schema

- **Preview:** `startPreview` (`engineer/preview.ts:48`) copies the **live** data. Nothing
  migrates it first: the preview child calls the application's `start`
  (`child/run-child.ts:260`), and the starter, Notes and the fixture each call `openStore` there,
  which migrates on open.
- **Activation:** `supervisor.migrate` (`launcher/activate.ts:274`) runs a `--migrate` child that
  calls the application's `migrate` (`run-child.ts:133`) on `data-next`. `data-check` is copied
  from that result. Its preview child's `start` then finds nothing left to migrate (the by-hand
  run logged one "migrated 0 → 3", not two).
- **So there are two code paths, and both belong to the application.** In all three shipped
  applications both paths run the same `openStore`, so they agree. A release whose `migrate`
  differs from what `start` does could pass one and fail the other. An example: a `migrate`
  that does nothing while `start` migrates lazily, or the reverse. Not unified, as decided.

## `snapshotDirectory` and a WAL

The migrate child leaves `notes.sqlite`, `-wal` and `-shm` in `data-next` (probed).
`snapshotDirectory` skips the two sidecars and runs `VACUUM INTO` on a read-only connection,
which reads through the WAL. So the copy is one self-contained database at schema 3. The
examples passing on it is the evidence, along with the missing second migration line.

## By hand

Seed: 14d's `edits/on 1` root (task `0002-record-done-at` completed with 11 examples, four of
them writing: `notes.create` then `notes.update` on ids 1–3). Each run used a fresh copy of it.
The application had never been activated there, so there was no live data: first activation,
migration 0 → 3. The script is `tests/.autoapp-run/byhand-14e.ts` (gitignored). It builds,
checks on a preview exactly as `candidate.check` does, then activates.

| binary | check | activation | live data after |
|---|---|---|---|
| this tree, in-process `activate` | 11 of 11 | **done** in 206 ms | 0 notes, schema 3, 122,880 B |
| this tree, compiled `activate` CLI | 11 of 11 | **done**, exit 0, 232 ms | 0 notes, schema 3 |
| v0.4.14, compiled CLI | 11 of 11 | **exit 1**: `failed at checked: an acceptance example failed: 0002-record-done-at-c1: the application is being checked (previous-serving)` | 0 notes, schema 2 |

Phases for the in-process run (ms since the previous journal write): requested 1, drained 2,
snapshotted 0, migrated 0, checked 46 (`checkDir` set), 1 (`checkCopyMs: 1`), 57 (examples run,
`checkDir: null`), switched 48, serving 4, done 46. The final journal row has
`check_dir: null, check_copy_ms: 1`. There was no `data-check` or `data-next` afterwards.

**Deviation:** v0.4.14 was **built from the `v0.4.14` tag** in a scratch worktree (`d94cf69`,
77.7 MB), not the downloaded release asset. Downloading a file needs the owner's explicit
permission in this session, and the fault is in source, not packaging. The worktree was removed.

**The copy's cost on the largest data directory here:** `autonewsapp/run/autoapp/apps/notes/data`,
5.2 MB on disk (`runs.sqlite` 4.4 MB, `notes.sqlite` 20 KB). `snapshotDirectory` took 29, 8
and 7 ms, read-only, into the scratchpad. The seed's migrated data copied in 1 ms.

## The smoke

No embedded template has a writing example. The starter has `items.list`, the blank has one
view step, and Notes has three reads. So the smoke's activation still runs reads only.
Templates are unchanged, as the prompt says.

## Where the preview and activation can still judge differently

- The two schema paths above.
- The preview's copy lives as long as the preview. `candidate.check` runs on whatever the person
  or `preview.try` has done to it since it started, while activation's copy is always fresh.
  Examples that hardcode ids (this seed's `id: 1..3`) pass on a fresh preview and could fail
  on one somebody has clicked in.
- Health is asked only of the paused `data-next` child. A health state other than `serving`
  cannot be produced from a fixture. Test 8 makes the release refuse to start live and asserts
  the shared sentence, which both branches use. That is a deviation from "reports a state".
- Seen, not changed: one workspace built under two different roots gave two release ids
  (`3dec64be…`, `fb6dba62…`). The build seems to depend on its path, which matters for
  replays that clone a workspace elsewhere.

## Decisions I made

- The examples' child is started, used and stopped inside `runExamplesOnCopy`, so a throw there
  cannot leave it running. If starting it or copying throws, the reason reads "the candidate would not run the
  acceptance examples: …".
- The stray sweep runs after the recovery loop, with no journal lookup. After that loop nothing is in flight.
- `Phase` is held unchanged by a `Record<Phase, true>` literal in test 9, so the typecheck fails
  if a phase is added or removed.

## Commands

```
bun run typecheck                                                   exit 0
bun test tests/autoapp-activation.test.ts                           37 pass, 0 fail
bun test tests/autoapp-verify.test.ts tests/autoapp-engineer.test.ts  75 pass, 0 fail
bun test tests                                                      958 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 77.7 MB
bun run scripts/autoapp-smoke.ts                                    every step passed
bun install && bun run check                                        exit 0, 958 pass
git diff --stat tests/ai-chat.test.ts packages/broapp               (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| A write example that passes `candidate.check` passes activation | pass (tests 1, 10; by hand 11/11 both) |
| Live data never written before the switch, holds nothing an example wrote | pass (test 2; by hand 0 notes) |
| External effect refused identically in both places | pass (test 5: same sentence; `fails` passes both) |
| `data-check` never outlives an activation; a stray one removed at start | pass (tests 2, 3, 6, 7, 8) |
| No phase added; recovery handles the new directory | pass (tests 6, 9) |
| `ai-chat` unchanged; no `packages/broapp` change; `check` green | pass |

The commit trailer names Claude Opus 5, per this session's attribution rule.
