# 15b — A finished task's example keeps what it says

## Step 0 — before any change

Written before any code changed.

Every `intents.sqlite` that still exists was read (read only, through the `sqlite3` command
line): 27 under `tests/.autoapp-run` and the real root’s, 22 of them with a completed task. The roots the prompt names map onto
them as follows. 13c, 13d and 14c ran over the real root (`reading-list` for 13c and 13d,
`background-remove` for 14c, whose replay ran on a copy that no longer exists), so the real root
holds all three. 14a's runs survive as the seed that 14b, 14d and 14e copied (`byhand-14a`
itself keeps only `base`, with nothing completed). 14b, 14d and 14e survive whole.

For each completed task, its criteria give its example ids; its `rev_after` gives the workspace
revision it completed at. The steps of each of those examples at `rev_after` were compared, by
canonical JSON, with the steps at every later commit to `autoapp.json` in that application's
workspace and with the working tree. The script is in the scratchpad, not committed. As a check
that it can see a change: pointed at 0002's own examples between its two commits in
`byhand-14d/runs/edits-on-1`, it reports all four changed — a retry rewriting its own examples,
which this prompt allows.

| application | completed task (where) | later work on the application | examples | later revisions compared | changed | removed |
|---|---|---|---|---|---|---|
| notes | 0001-add-done-at-column @16b1687a (14a's run 1; copied into 18 roots of 14b, 14d, 14e) | 0002 failed, asked, or completed, and 0003 interrupted, in each root: 0 to 5 commits | 4 | 4 to 24 per root | 0 | 0 |
| notes | 0001-add-done-at-column @ccf40f50 and @63021bbd (14b silent-off 1 and 2) | 0002 interrupted, no commit | 4 | 4 | 0 | 0 |
| notes | 0002-record-done-at @a57d7ea3 (14d on 2), @60b39748 (14d on 1, 14e ×3) | 0003 interrupted, no commit | 4 | 4 | 0 | 0 |
| reading-list | 0004-author-column @cbcf980f (13c) | 0001 completed (13d), 0002 failed: 4 commits | 3 | 15 | 0 | 0 |
| reading-list | 0001-author-field @1d73315a (13d) | 0002 failed, no commit | 6 | 6 | 0 | 0 |
| background-remove | 0001-store-image-and-settings @44ace8cf (14c's intent) | 0002 completed, 0004 interrupted: 16 commits | 4 | 68 | 0 | 0 |
| background-remove | 0002-run-rembg @686ac9a1 | 0004 interrupted: 8 commits | 2 | 18 | 0 | 0 |

**The count: 29 completed-task rows in 22 stores, 0 cases of a later task changing a finished
task's example, so 0 honest and 0 weakening.** Nor was one removed. The rule this prompt adds
would have stopped no task on this machine. What the data does show is the case the rule leaves
alone: retries of a task rewriting that task's own examples (0002 in 14d did, twice).

The sample is thin in the way that matters: most later tasks here failed or were interrupted,
and only three later tasks completed on top of an earlier one (reading-list 0001 over 0004,
background-remove 0002 over 0001, notes 0002 over 0001). None of those touched the earlier
examples.

## What was built

- `knowledge/evidence.ts`: `stepsHash(example)`, the hash of an example's `steps` through the
  same private `hashOf` that `exampleHash` uses (first 32 hex characters of the `sha256` of the
  canonical JSON). Not a second hash: one function, two things hashed. Exported from
  `broapp-autoapp/knowledge`.
- `intent/store.ts`: a third `MIGRATIONS` entry, `task_criteria (task_id, criterion_id,
  example_hash TEXT)`, one row per criterion of a completed task, `example_hash` nullable.
  `TaskResult.exampleHashes` (by criterion id), written by `recordResult` in the same call that
  writes `revAfter`. `TaskRecord.exampleHashes` reads them back; a task with no rows reads `{}`.
- `intent/executor.ts`: `RequiredExample { id, hash: string | null }`; `required` is now
  `RequiredExample[]` and `verdictOf` takes an eighth argument, `current`, the hashes by id.
  `verdictOf.length` is still 4 and it is still pure. `finishedExamples` returns each id with its
  kept hash. `builtExampleHashes` reads the built release and hashes every example; `runTask`
  passes it to the verdict and, on completion, stores this task's criteria's hashes.
  `builderMessage`: "Do not remove, rename or change an acceptance example that is already
  there. If an older example fails, run candidate.cycle again so the checks run on a fresh
  preview. If it still fails, your change is wrong or the plan is: say which with intent.ask."
  Nothing else new.
- The rule: gone sentences, then changed sentences ("The example <id>, from a finished task, was
  changed."), both after the failed-example lines and before the per-criterion lines, as the gone
  sentence already sat. A null hash is held by id only. An unknown current hash reads as changed.
- `docs/autoapp/intents.md` (the builder's message, the completed rule, what a completed task
  records) and one `docs/autoapp/backlog.md` row, **Accepting a changed example from the panel**,
  with Step 0's count as the reason it waits.
- Tests: nine in `tests/autoapp-intent-run.test.ts` under "15b" (the prompt's 1–8 and one for
  removal and replacement).

## Where the executor reads the examples from

`readRelease(layout, appId, status.releaseId)`: the specification stored with the release the
last build wrote. That is the build the verdict is about. `checksVerified` (in
`engineer/state.ts`) holds only when the checks ran on a preview of that same `releaseId`, and a
verdict without it is not completed anyway. It is not a fresh read of `autoapp.json`: the
workspace may have moved since the build, and a hash of the file as it is now would be a hash of
something nobody checked. A release's specification is also the one parsed by `parseSpec`, so
what is hashed is what the check ran. If the release cannot be read, every required example with
a hash reads as changed. A build that cannot be read back cannot vouch for anything.

## An honest change to an older example, step by step

1. Task B's plan truly needs task A's example to change (say A's `expect` must follow a field
   B adds). B's builder has been told not to change it, and to cycle again and then say with
   `intent.ask` whether the change or the plan is wrong.
2. If it asks, the task waits with that question in the panel (13c). The person can answer. But
   no answer lets the example change: the verdict will refuse it whatever the answer says.
3. If it changes the example anyway, the verdict is "The example A-c<n>, from a finished task,
   was changed." The task fails (after its attempts), the run stops, and the advice question is
   asked with that reason.
4. The person revises B's plan (13c's revise path) so that it does not need A's example to
   change, or leaves B failed. There is no third way.

Tolerable until the backlog row is done? On this machine, yes. Step 0 found no case, and a
person who meets one can still get the change made outside a backlog run, in a chat turn, which
no verdict judges. It stops being tolerable the first time an honest change blocks a run. That
is the backlog row's precondition.

## Can a backlog turn reach a verdict on checks from a preview already written to

Yes. `candidate.cycle` always calls `candidate.preview`, which starts a fresh copy of the live
data (`engineer/tools.ts`, `candidate.preview`: "a preview runs on a fresh copy of the live data").
But `candidate.check` on its own (`engineer/tools.ts`, `tools['candidate.check']`) runs on
whatever preview is running, and `checksVerified` (`engineer/state.ts`, `status()`) asks only
that the checks ran on the preview of the built release: the same `previewId`, not an unwritten
one. So a builder that cycles, then calls `candidate.check` again on the same preview, gets a
verdict on data its own first check's write steps already changed. So does one whose preview a
person clicked in. The verdict counts those checks as verified. This prompt's builder sentence
covers the failing direction (cycle again before blaming the change). The passing direction,
an example that passes only because an earlier check wrote to the data, is not covered. That
is 14e's finding restated, not changed here.

## Deviations, and decisions I made

1. **"The criterion's row" did not exist.** Criteria are one JSON array in `tasks.criteria`,
   not rows. The fixed decision asks for the hash on the criterion's row, added by a migration as
   `example_hash TEXT`, null allowed. The one way to do all of that is a migration that creates
   the rows: `task_criteria`, one row per criterion, keyed by task and criterion id. Nothing else
   about a criterion moved out of the JSON. I read this as the decision done as written, not a
   substitute. The other readings each drop a stated property: a field inside the JSON needs no
   migration, and a column on `tasks` is per task, not per criterion. Per the common rules (§5),
   this is reported as the prompt and the repository disagreeing about how things are today.
2. **The migration is `CREATE TABLE IF NOT EXISTS`.** 14a's migration test fakes an older store
   by dropping `task_runs` and setting `user_version = 1`; reopened, the store runs both later
   migrations, and 15b's table was still there. The test simulates something no real store is,
   but the migration only adds a table and has nothing to redo, so it tolerates that rather than
   the older test being edited.
3. **An unknown current hash reads as changed.** The fixed rule names "present with a different
   hash". When the built release cannot be read, the hash is not known; completing on an
   example nobody could compare would be the fault this prompt closes.
4. **Rows only for completed tasks.** A task not completed has no rows, and a task completed
   before this prompt has none either; both read as `{}`, which `finishedExamples` turns into a
   null hash. A completed task is terminal (no move leaves `completed`), so a replaced or removed
   task never had rows. The removal-and-replacement test confirms both still contribute nothing,
   and that a completed task can be neither removed nor replaced.
5. **Two existing assertions changed shape, not strength.** 13d's pure test passes its earlier
   ids as `{ id, hash: null }` (held by id only, which is what an id-only list meant), with the
   same expected sentences. 13d's executor test looks for the builder's new sentence, "Do not
   remove, rename or change…", where it looked for the old one the fixed decision replaces.
6. **Mutation check.** With the changed sentence disabled, tests 1, 2 and 5 fail; restored.
7. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Commands run

```
bun run typecheck                                                        exit 0
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts \
  tests/autoapp-task-context.test.ts                                     first: 107 pass, 1 fail (deviation 2); then 108 pass, 0 fail
bun test tests                                                           974 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                     dist/broapp-autoapp 77.8 MB, exit 0
bun run scripts/autoapp-smoke.ts                                         every step passed
bun run check                                                            exit 0, 974 pass, 0 fail
git diff --stat tests/ai-chat.test.ts packages/broapp                    (nothing)
```

No live-model run: the prompt asks for none.

## Acceptance criteria

| Criterion | Result |
|---|---|
| A completed task's example cannot be changed by a later task without that task failing, with a sentence naming the example | pass (tests 1, 2, 5) |
| Removal is refused exactly as before | pass (13d's tests unchanged in meaning; test 2) |
| Tasks completed before this prompt behave exactly as before | pass (tests 3, 8) |
| `verdictOf` is still pure and still the one rule | pass (the executor reads and hashes; `verdictOf.length` 4) |
| No change to `packages/broapp`; `ai-chat` unchanged; `bun run check` green | pass |
