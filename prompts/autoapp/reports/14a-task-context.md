# 14a — A task's turn knows its task

## What was built

- **Step 0.** `executor.ts`: a turn the provider killed (the first `error` event, or `result.error`), or one
  that ended `failed` with no tool call, is an `Ending` of kind `provider`: `in-progress → interrupted`
  (attempt given back), a note starting `NOT_AN_ATTEMPT` (`'not an attempt: '`), the intent stopped with
  `providerStopped(slug)` / `nothingDoneStopped(slug)`, no advice, no next task. `sanitisedLogger` in
  `knowledge/log.ts`; `tab.ts` hands it to `createAi`, `engineerTools` and the executor. The Backlog-panel
  fault is fixed in `launcher.appsList` (`selected`) and `ui/selection.ts` (`firstSelection`).
- **Step 1.** `intents.sqlite` migration 2: `task_runs` + index, backfilled from `run_ids` by position (`at`
  from the matching `in-progress` event). `moveTask(→in-progress, runId)` inserts in the same transaction.
  `taskForRun`, `runsOf`, `attemptNotes`. `serve.search` looks the run id up; a found task names the app.
- **Step 2.** `knowledge/attempts.ts`: pure `attemptsDocument`, plus `runRecord` / `attemptsInput` (the
  reads). Ref `attempts:<appId>`, second in `search`. `runTask` seeds `lastReasons` from the newest note that
  was an attempt (`reasonsFromNote`).
- **Step 3.** `knowledge.sqlite` migration 3: `links` (`LINKS_TABLE`). `knowledge/links.ts`: `fileKey`,
  `plannedFiles`, `rebuildLinks`, `linksReport`, `runLinksCommand`; `STAGES_FOR_LABEL`. Rebuilt in `main.ts`
  when the stores open and from the executor's new `onTaskEnded`. `distil.ts` exports `caseEdits`, its own
  query, now shared with the index. `knowledge links [--app <id>] [--rebuild]`.
- **Step 4.** Three tiers in `serve.ts` (`taskLessons`, `relatedLessons`), `Corpus.related`,
  `ServedDocuments.attempts`, the ranking comment in `findLessons`, `why` on the `search` event.
- **Step 5.** `learning.md` "What a task's turn is given" (with the diagram), `intents.md` (step 4, "What a
  retry is told", "A turn the provider killed is not an attempt"), five `backlog.md` rows. Diagram
  `diagrams/autoapp-task-links.{html,svg}` drawn with the `diagram-design` skill (ER type, doc-inline,
  `self_check.py` OK, looked at in the in-app browser).
- Tests: 6 in `autoapp-intent-run.test.ts` (Step 0 a–f); `tests/autoapp-task-context.test.ts`, 18 tests
  for cases 1–11.

## Step 0

**The panel fault, in two sentences.** The launcher's page selected the first application row whenever
nothing was selected, not the one the person last chose, which `session.json` holds and the engineer's turns
use; on a root with more than one application the Backlog panel therefore listed another application's (empty)
backlog. Refresh re-reads that same application, so only clicking the right row "fixed" it.
Reproduced on the first try: compiled launcher, scratch root with `alpha` and `zeta`, one intent on `zeta`,
`session.json` naming `zeta`; the Releases panel showed `alpha`'s release and Backlog said "Nothing has been
planned yet"; clicking `zeta` showed the intent. After the fix the same first open lists it. Test f fails
without the fix (`listed.selected` is undefined).

**The redaction shape.** 13d's knowledge log has it (event 257):
`…To increase, visit https://openrouter.ai/workspaces/default/keys/<64 hex> and adjust the key's total limit`.
`sanitise` already took it (the 40+-hex rule); the terminal copy was raw because the event log's `tee`
prints before sanitising. `sanitise` is unchanged; test e uses a made-up 64-hex id.

## Deviations, and decisions I made

1. **`sanitisedLogger` wraps only the three consumers the prompt names.** The first cut wrapped the tab's
   whole logger, and the smoke failed at "panel link": the launcher's routes print the launch address a person
   must open, and `sanitise` removes its `?bt=` query. Other callers of the event log still tee raw (open
   question).
2. **A provider ending is taken only when nothing here aborted the turn.** An idle, time-limit or Stop abort
   also surfaces as `result.error` ("Failed to process successful response" in 13d); without this guard the
   idle limit would have become "not an attempt". The "before the model did anything" case stops with its own
   sentence, `nothingDoneStopped`.
3. **`NOT_AN_ATTEMPT` lives in `intent/types.ts`** and is re-exported from `executor.ts`, so the store can mark
   rows without importing the executor. `attemptNotes` reads only moves *from* `in-progress` (a "model no
   longer offered" failure is not an attempt's end).
4. **Still wrong at the end** takes the last check only when it came after the last build; an older check
   checked a build that is gone. Lines are capped (3 per section, 160 characters) so the newest attempt always
   fits; over budget, older attempts go first, then the diagnosis, then "Came back".
5. **`why` has one entry per delivered document and per delivered lesson** (`lesson:<id>`), because lessons
   reach the model as one `lessons:<appId>` document but each has its own reason.
6. **`fileKey`** makes an absolute path inside the workspace relative; any other absolute path is `null`.
   **`rebuildLinks` indexes only listed applications** and re-creates the table if dropped (test 7 drops it).
7. **`STAGES_FOR_LABEL`**: contract→contract, host→host, views→views, theme→page, acceptance→check;
   migration and copy map to nothing. `check` is not a `BUILD_STAGES` name but is a lesson stage.
8. The commit trailer names Claude Opus 5, per this session's attribution rule. The report runs past 100 lines because of the by-hand table and the index counts the prompt asks for (as 12h, 13b, 13c).

**`query.limit`** is `SEARCH_LIMIT = 8` (`run.ts`). Four documents and three lessons are seven: they fit;
not raised.

## The index on this machine's store

Measured on `.backup` copies of the real `knowledge.sqlite` and `intents.sqlite` (the real root untouched),
compiled launcher, `knowledge links --rebuild`: **1.4, 1.8, 1.7 ms**.

```
task ran_as run 10 · run edited file 40 · task edited file 7 · task planned file 0 · case opened_in run 3
case resolved_in run 0 · case edited file 3 · lesson distilled_from case 0 · lesson served_to run 30
locks that are not a file of the workspace: 0
```

Skipped locks, verbatim: none — every task on this machine (`reading-list` 0001–0004) has `locks: []`. So
what planners write in `locks` is, so far, nothing; `task planned file` is empty for the same reason.

## Existing assertions changed

None. `tests/autoapp-intent-run.test.ts` gained world options (`failFrom`, `noModel`) and six tests;
`tests/autoapp-knowledge.test.ts` did not change. Test 10 holds a no-task turn to the refs the pre-14a
`serve.ts` (from `HEAD`) returns for the same store: compared for three messages, identical.

## The by-hand run

2026-09-18, local Ollama `qwen3.8:27b-mlx` (nothing left the machine, no key entered; 12d's case was
measured on it), no other session or evaluation on the machine. Script: `tests/.autoapp-run/byhand-14a.ts`
(gitignored), the launcher's tab in-process, default run limits (20 min turn, 8 min idle, 2 attempts).

**The variant.** 12d's `confirmText` case names its own repair, so I asked for something 12d saw fail most:
"Add a Mark done button to each row of the notes table. Marking a note done records the time it was done,
and the table shows that time in a Done at column" — a migration, the host, the contract and the views.
Planned by the model with 13b's tools in one turn (9m53s, 24 calls; a first try died at the provider after
6 min): four tasks, run order `0001-add-done-at-column` (migration, 4 criteria, `locks: []`),
`0002-record-done-at`, `0003-done-at-view`, `0004-done-at-acceptance`. The measured task is 0001; each
run stopped once 0001 was completed or failed, on a fresh copy of the planned root.

| run | switches | attempt 1 | attempt 2 | calls / tokens of attempt 2 | re-read by 2 | edit repeated | irrelevant docs (a2) |
|---|---|---|---|---|---|---|---|
| 1 | on | completed, 12 calls, 10m35s, 153,634 in / 12,004 out | – | – | – | – | – |
| 2 | on ¹ | completed, 9 calls, 4m40s, 72,029 in / 5,255 out | – | – | – | – | – |
| 3 | on | failed: 4 reads, no edit, idle limit (13m33s) | failed the same way (8m14s) | 4 / unknown ² | 2 of 2 (`src/host/db.ts`, `autoapp.json`) | none (no edits) | 0 of 5 |

¹ Run 2 was meant to be "off". My loop passed `1 off` as one argument (zsh does not split an unquoted
variable), so every run had both switches on. That does not change attempt 1, which has no earlier attempt
and no edited file for tier 2 to join on. ² Both turns of run 3 were ended by the idle limit, which records no
`usage` event, so their tokens are not known.

**Attempt 1 failed in 1 of 3, not "more often than not".** So the prompt's condition for the six-run
comparison was not met, and I stopped there rather than tune the task: the three "off" runs were never
made, and no with/without comparison exists. What the one retry shows: attempt 2 was given
`digest, attempts, intent, evidence, lessons` in that order, `why` recorded each (`lesson:4`, the migration
seed, by `words` — relevant to a migration task), and the attempts document said "Changed: nothing" and the
verdict's reasons. It did not help: attempt 2 re-read the two files attempt 1 had read and went silent again.
It also showed a fault, fixed after the run: the document cut "Ended with" at three lines and the sentence
that mattered, "The turn made no tool call for 8 minutes.", was among the six hidden. Reasons about how the
turn ended now come first (a test holds it). One run with a retry supports nothing about whether the
document helps; the table can say only that the plan's first task usually passes first time on this model.

## Commands run

```
bun run typecheck                                          exit 0
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts   pass
bun test tests/autoapp-knowledge.test.ts tests/autoapp-task-context.test.ts   pass
bun test tests                                             905 pass, 0 fail (53 files)
bun run --cwd packages/broapp-autoapp build:launcher       dist/broapp-autoapp 77.6 MB
bun run scripts/autoapp-smoke.ts                           first: 1 failed (deviation 1); then every step passed
bun run site                                               25 files
bun install && bun run check                               exit 0; 905 pass, 0 fail
git diff --stat tests/ai-chat.test.ts                      (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| Provider failure, no start, or nothing done: interrupted, no attempt spent, run stopped with a sentence, no advice, never a failed attempt | pass (a–d) |
| Nothing the launcher prints carries what the knowledge log redacts | pass for the AI layer, tools and run (e); see open question |
| The Backlog panel shows its intents on first open | pass (cause found, fixed, f; by hand) |
| Task found from its run id by equality; application not from the first line | pass (1, 2, 4) |
| Later attempts get changed/ended/still wrong/came back/diagnosis in ≤1,500; a first attempt none | pass (3, 4) |
| Resumed after a stop or restart is told the same | pass (5) |
| `links` dropped and rebuilt to the same rows; source and app on every row; no weight | pass (7) |
| Pinned, ≤2 by shared file, then task words; no-task turn as before | pass (8, 9, 10) |
| `search` says why each document was there | pass (11) |
| No outcome ranking, no embedding, no new tool, no `packages/broapp` change; ai-chat unchanged; check green | pass |

## Open questions

- `createEventLog`'s `tee` prints warnings and errors before sanitising for every other caller (supervisor,
  child stderr). Sanitising in the tee would close it everywhere, but must not touch lines that carry a launch
  address.
- `tests/autoapp-task-context.test.ts` is not in CI's per-platform Autoapp list.
