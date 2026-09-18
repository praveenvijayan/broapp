# 14a — A task's turn knows its task: earlier attempts, and what is related to it

## Goal

After 13d a backlog task is built by a turn that the knowledge layer cannot tell
from any other turn. `serve.ts` finds the application by reading the first line
of the message and knows nothing else: not the task, not its labels, not that
this is its third attempt. A retry is told the last verdict's sentences and
nothing about what was edited or which build problem came back; a task resumed
after a stop or a restart is told nothing at all, because `executor.start`
clears `failure` and `lastReasons` is a local variable. The main model's
diagnosis of a failed task is stored and shown to the person and never reaches
the builder. Lessons are matched against the whole builder message, boilerplate
included.

After this prompt:

1. A spoke turn's task is known to the knowledge layer by exact run id.
2. Every attempt after the first is given one bounded document saying what the
   earlier attempts changed, what failed, what came back, and how the planning
   model read the failure — including after a stop, a resume or a restart.
3. A derived, rebuildable index in `knowledge.sqlite` records which tasks, runs,
   files, cases and lessons are related, each row naming the row it came from.
4. A task's lessons are chosen from the task's own words and from that index by
   fixed rules, and the `search` event records why each document was included.
5. One measurement says whether any of it helps a retry.

Before any of that, Step 0 closes three faults the review of 13d found in how a
failed turn is recorded and shown. They come first because the attempts document
is built from those records: a turn the provider killed must not be written
down as an attempt the builder made.

Nothing here ranks by outcome, learns a weight, or embeds text. `scoring.ts`
says an outcome is association and never promotes or ranks a lesson; report 12d
watched two unrelated lessons credited `resolved`. That rule stands.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report; 12b, 12d, 13c and 13d's
  reports in full; `docs/autoapp/learning.md`, `docs/autoapp/intents.md`.
- `packages/broapp-autoapp/src/knowledge/serve.ts` in full: `search`, `resolve`,
  `delivered`, `render`, `chooseApp`, `findLessons`, `strongMatch`,
  `pinnedLessons`, `backlogDocument`, `BACKLOG_DOCUMENT_CHARS`, `Corpus`,
  `ServedDocuments`, `TURN_LESSONS`, `TURN_CANDIDATES`.
- `packages/broapp-autoapp/src/intent/executor.ts`: `runTask`, `builderMessage`,
  `verdictOf`, `advise`, `start` (where `setFailure(task.id, null)` is called).
- `packages/broapp-autoapp/src/intent/store.ts`: the migration, `moveTask`,
  `task_events` and its append-only triggers.
- `packages/broapp-autoapp/src/intent/plan.ts`: `locks` validation (count and
  length only; an entry is free text).
- `packages/broapp-autoapp/src/knowledge/store.ts`: the migration list and how
  `PRAGMA user_version` steps through it; `episodes`, `servings`, `events`.
- `packages/broapp-autoapp/src/knowledge/log.ts`: `ALLOWED` — the fields each
  event kind may carry (`edit` keeps `paths`; `build` keeps `problems`; `check`
  keeps `results`), and `sanitise`.
- `packages/broapp-autoapp/src/knowledge/distil.ts` around the two event queries
  (`kind = 'edit'` by application and time): how a case's edits are read today.
- `packages/broapp-autoapp/src/knowledge/scoring.ts`: the header, and
  `problemSignature`.
- `packages/broapp-autoapp/src/engineer/state.ts`: `CycleProgress.failures`.
- For Step 0: report 13d's "Found, not changed here" and "Open questions";
  `packages/broapp/src/ai/host/run.ts` — `safeMessage` (line ~441) and the
  `case 'error'` branch (line ~840), to read, not to change;
  `executor.ts` `followerFor` and `finishEnded`; `launcher/tab.ts` where `logger`
  is handed to `createAi` and `engineerTools`; `launcher/ui/App.tsx` where
  `selected` is set and `IntentPanel` is mounted; `IntentPanel.tsx`
  `LiveIntentPanel`, `usePolling`, `shouldPoll`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Join on the exact run id | Never parse `intent-<id>-<slug>-a<n>` to find a task. A run id is an opaque string everywhere except the executor that makes it and the tools that test its `intent-` prefix. |
| `task_runs` | Second migration in `intents.sqlite`: `task_runs(run_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL, at INTEGER NOT NULL)`, index on `(task_id, at)`. The migration backfills it from every task's `run_ids` with `json_each`, `attempt` by position. `moveTask(→in-progress, runId)` inserts the row in the transaction that already appends to `run_ids`. `run_ids` stays: the panel and 13c's tests read it. New store methods: `taskForRun(runId): TaskRecord \| null` and `runsOf(taskId): { runId, attempt, at }[]`. |
| How serve learns the task | `search` already receives `runId`, and the executor moves the task to `in-progress` with that run id before it calls `ai.turn`. So `serve.search` calls `intents.taskForRun(query.runId)` and keeps `task` on the turn's entry beside `appId`. When a task is found its `appId` is the turn's application; `chooseApp` runs only when none is. No change to `packages/broapp`. The `Application:` first line stays for every other caller. A test asserts a spoke turn whose message lacks that line still resolves its application. |
| No cross-file SQL | Do not `ATTACH` one store to the other. It gives no referential integrity and no commit that is atomic across two WAL files. `serve` and the index read intents through `IntentStore` methods and knowledge through its own handle. |
| The attempts document | Ref `attempts:<appId>`, title `Earlier attempts at <slug>`, offered only when the turn has a task with at least one earlier run in `task_runs`. Built by a pure function `attemptsDocument(input): string \| null` in new `knowledge/attempts.ts`. `ATTEMPTS_DOCUMENT_CHARS = 1_500`, cut at a line as `backlogDocument` is. Order of refs in `search`: `digest`, `attempts`, `intent`, `evidence`, lessons — the budget cuts from the end, and for a retry this is the document worth most. Check what `query.limit` is for an engineer turn; if five refs plus lessons do not fit, say so in the report and do not raise it. |
| What it says | Per earlier attempt, oldest first, the newest never cut: `Attempt <n>` then (a) **Changed:** the distinct `paths` of that run's `edit` events, at most 8, then "and <k> more"; (b) **Ended with:** the reasons from that attempt's `failed` row in `task_events` — add `attemptNotes(taskId)` to the store, returning `{ attempt, note, at }` for moves to `failed` and `interrupted`; (c) **Still wrong at the end:** from the run's last `build` event its problems as `<stage>: <first line of message, ≤160>`, and from its last `check` event each result with `passed: false` as `<id>: <detail, ≤160>`. Then, once: **Came back:** any `problemSignature` present in the last build of two or more attempts, with the attempts named — this is the line that tells a builder not to try the same repair again. Then, when `task.advice` holds a `diagnosis`: **How the planning model read it:** the diagnosis only. The `note` is addressed to the person and the `advice` word is theirs to act on; neither is shown. An `interrupted` attempt says "stopped before it finished" and lists only what it changed. Every string goes through `sanitise`. No paths from outside the workspace, no model prose other than the diagnosis. |
| The message keeps its reasons | `builderMessage`'s "The last attempt ended with:" stays: a document can be cut by the budget, the message cannot. What changes is where `lastReasons` starts: at the top of `runTask`, when `attemptNotes(task.id)` is not empty, it is seeded from the newest note's sentences, so a task resumed after a stop or a restart is told what a task retried inside one run is told. `start` still clears `failure`: that field is the panel's, and `task_events` is the record. |
| The relationship index | The next migration in `knowledge.sqlite`'s list: `links(id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, src_kind TEXT NOT NULL, src_id TEXT NOT NULL, rel TEXT NOT NULL, dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)`, unique on `(app_id, src_kind, src_id, rel, dst_kind, dst_id)`, indexes on `(app_id, src_kind, src_id)` and `(app_id, dst_kind, dst_id)`. Kinds: `task` (id is the slug), `run`, `file`, `case` (an `episodes.id`), `lesson`. `source` names the row the link was read from, as `<table>:<id>` (`task_runs:<run_id>`, `events:412`, `servings:9`, `lessons:3`, `tasks:17`). A link is a fact that two recorded things touched. It carries no weight and no score. |
| The rows | `task ran_as run` from `task_runs`. `run edited file` from `edit` events' `paths`. `task edited file` for the same paths through the task's runs. `task planned file` for each `locks` entry that, normalised, is a file that exists in the application's source workspace — an entry that is not is skipped and counted, never guessed at. `case opened_in run` and `case resolved_in run` from `episodes.run_id` and `resolved_run_id`. `case edited file` from the `edit` events of the case's application between `opened_at` and `resolved_at`, the window `distil.ts` already uses — reuse its query, do not write a second one. `lesson distilled_from case` from `lessons.episode_id`. `lesson served_to run` from `servings` with `included = 1`. |
| File identity | `(app_id, path)` where `path` is relative to the application's source workspace, forward slashes, no leading `./`, never absolute, never containing `..` after normalisation (such a path is dropped). One function, `fileKey(layout, appId, raw): string \| null`, used for every `file` node. Two applications' `src/host/routes.ts` are different nodes because `app_id` is part of every lookup. |
| Rebuildable | `rebuildLinks({ knowledge, intents, layout, apps }): { rows, skippedLocks }` in new `knowledge/links.ts` deletes and rewrites every row of `links` in one transaction on `knowledge.sqlite`. It is called when the launcher opens its stores and after every task move to `completed`, `failed` or `interrupted`. It is derived data: dropping the table loses nothing. `knowledge links [--app <id>]` prints counts per `rel` and the skipped locks; `knowledge links --rebuild` runs it. If a full rebuild over the real store on this machine takes more than 200 ms, say so in the report and leave it; do not make it incremental here. |
| Choosing a task's lessons | Only when the turn has a task. Three tiers, filled in order up to the existing `TURN_LESSONS`, no lesson twice: **1. pinned** — as today. **2. related** — lessons `distilled_from` a case that `edited` a file this task has `edited` in an earlier attempt or has `planned` (a lock that resolved), same `scope` filter and the same status and `method_unclear` filters as `findLessons`, confirmed before provisional, then newest. At most 2. **3. words** — `findLessons` and `strongMatch` as today, but over `title`, `summary` and the criteria texts of the task, never the whole builder message, whose fixed sentences are the same for every task. A turn without a task is served exactly as today; a test holds that. |
| File overlap is a signal, not proof | Two changes to one file can be about different things. That is why tier 2 is capped at 2, sits under pinned, and is measured below before anyone relies on it. `Corpus` gains `related?: boolean` (default `true`) so a replay or an evaluation can turn tier 2 off; `ServedDocuments` gains `attempts: boolean` (default `true`). |
| Labels, scope and stage stay three things | `lessons.scope` says where a lesson holds, `applies.stage` says which part of the build it is about, a task's `labels` say what kind of work it is. Do not merge them and do not add a vocabulary. One host table `STAGES_FOR_LABEL` in `knowledge/links.ts` maps a label to the build stages that work of that kind usually fails at (read the real stage names from the build, do not invent them); it is used for one thing only: within tier 3, a lesson whose `applies.stage` is in the task's labels' stages sorts before one whose stage is not. A label with no sure mapping maps to nothing. |
| Ranking arithmetic | `findLessons` orders by `bm25(...) * CASE status …`. That is correct only because `bm25` is negative, the sort ascends, and every factor is positive with larger meaning better. Add that as a comment there. Do not add a term to that product in this prompt, and never add one by addition or with a factor that can be zero or negative. |
| Why a document was included | The `search` event gains `why: { ref, reason }[]`, reasons from a closed list: `application`, `backlog`, `attempts`, `pinned`, `related:<file>`, `words`. Add `why` to `ALLOWED.search` with `ref` and `reason` kept. `delivered` writes it from what the turn's entry recorded at `search`. The Knowledge panel is not changed here. |
| Nothing new for the model to call | No tool, no instruction line. The host assembles the pack at the start of the turn. 08c, 12j and the three-run evaluation all say the same thing about this model: what it is handed helps, what it has to go and fetch mostly does not get fetched. |
| Not in scope | Outcome-weighted ranking or any learned weight; embeddings, `sqlite-vec`, or any vector search (the trigger for those is a measured retrieval miss caused by wording, not a corpus size — add that sentence to `docs/autoapp/backlog.md`); tags written by a model; near-duplicate detection (content hashes and case signatures match exact normalised text only); showing `why` or links in the Knowledge panel; validating `locks` at plan time; scheduling by `locks`; a graph tool for the engineer; merging the two stores. |

## Step 0 — three corrections from the review of 13d, before anything else

Each with its test, listed in your report under their own heading. None changes
`packages/broapp`.

1. **A turn the provider killed is not an attempt.** In 13d's by-hand run the
   OpenRouter key ran out of credit. Both turns died at the provider with no
   tool call, were judged as a builder that tried and missed ("The example
   …-c6 failed."), used both attempts and stopped the run with a reason that
   says nothing about the provider; the advice question then failed the same
   way. The AI layer already says what happened: `run.ts` emits a chat event
   `{ type: 'error', code: 'provider' }` and ends the turn `failed`, and a turn
   that could not start returns `InProcessTurnResult.error`. In `followerFor`,
   record the first `error` event on the active run (`active.providerError =
   event.message`). After the turn, when that is set **or** `result.error` is set:
   no verdict is taken; the task moves `in-progress → interrupted` (13c made that
   move give the attempt back) with the note "the AI provider failed: <message>";
   the intent is stopped with "The AI provider returned an error while building
   <slug>. Nothing was judged. The launcher's log has the detail."; `advise` is
   not called; the run does not go on to the next task, because the next turn
   would meet the same provider. A new `Ending` kind, `provider`, handled in
   `finishEnded`, is the natural shape. The message shown is the AI layer's
   reduced one: the raw provider text never reaches the store or the panel.
   One more guard in the same place: a turn that ends `failed` with zero
   `tool-call` events and no provider error recorded is treated the same way,
   with the note "the turn ended before the model did anything", because a
   verdict over a turn that did nothing only re-reads the last attempt's state.
   Both notes start with a fixed prefix exported from `executor.ts`
   (`NOT_AN_ATTEMPT`), and Steps 1 and 2 honour it: `attemptNotes` marks such a
   row, the attempts document leaves it out entirely, and `lastReasons` is never
   seeded from it — the builder is told about attempts, and this was not one.
   Add that case to test 3 and test 5 below.
2. **The launcher's log does not print what the knowledge log redacts.** The
   same failure printed OpenRouter's raw error to stderr through `safeMessage`'s
   `logger.error`, including a settings URL carrying the key's identifier; the
   knowledge log's copy of the line had it `<redacted>`. The common rules say a
   secret is never logged, and an identifier that names a key is close enough.
   In `tab.ts`, wrap the `HostLogger` handed to `createAi`, `engineerTools` and
   the executor so every line passes through `sanitise` (`knowledge/log.ts`)
   before it is printed: one function, `sanitisedLogger(logger): HostLogger`,
   beside `sanitise`. Do not change `safeMessage`: that a provider's raw error
   is logged with its stack is the AI layer's decision and a person debugging
   needs it; what it may not carry out of the process is a credential or its
   name. If `sanitise` does not already redact the shape you find in 13d's
   report (read how the knowledge copy came to be redacted), extend it there,
   with a test on that exact shape and no real key in the fixture.
3. **The Backlog panel is empty on its first open** until Refresh. Seen in 13b
   with a turn running and again in 13d on a fresh launcher with none, so 13c's
   explanation (the draft did not exist yet) does not cover it. The review read
   `LiveIntentPanel` and `useOperation` and found nothing wrong: the list is
   requested on mount and the newest call wins. **Diagnose before you fix.**
   Reproduce it on the compiled launcher over a scratch root seeded with one
   intent (13a's report says how), open the panel as the first action after the
   page loads, and find out which it is: the request is made with an `appId`
   that is not the seeded application's (what `selected` holds at that moment,
   against `session`); the request is made before the bridge is ready and its
   answer is dropped; `list.data` arrives and a render path shows the empty
   sentence anyway; or something else. Write the cause in the report in two
   sentences, fix that cause and only that, and add a test that fails without
   the fix. If you cannot reproduce it in three tries, say so, change nothing,
   and leave a `backlog.md` row with what you tried.

## Step 1 — task identity

`task_runs`, its backfill, `taskForRun`, `runsOf`, `attemptNotes`; `serve.search`
resolving the task. Tests first. Nothing a turn receives changes in this step
except that a spoke turn's application no longer depends on its first line.

## Step 2 — the attempts document and the seeded reasons

`knowledge/attempts.ts` as a pure function over plain inputs (the notes, and per
run the edit paths, the last build's problems and the last check's failed
results), then the queries that feed it, then the ref in `search` and `render`,
then `runTask` seeding `lastReasons`.

## Step 3 — the index

`knowledge/links.ts`: `fileKey`, `rebuildLinks`, the CLI lines, the two call
sites. Report the real counts per `rel` on this machine's store, and the
skipped locks verbatim — that list says how much of what planners write in
`locks` is a file at all.

## Step 4 — lessons for a task, and `why`

The three tiers, `STAGES_FOR_LABEL`, the two switches, the event field.

## Step 5 — docs

`docs/autoapp/learning.md`: **What a task's turn is given** — the refs in order,
the attempts document's parts, the three tiers, the closed list of reasons.
`docs/autoapp/intents.md`: under **How a backlog runs**, what a retry and a
resumed task are told and where it is read from. One diagram of the index's
kinds and relations, through the `diagram-design` skill per
`~/.agents/DIAGRAM-STANDARD.md`; if that skill is not available in your session,
write the section without it and say so. `docs/autoapp/backlog.md`: rows for
outcome-weighted ranking (with why it is not done: attribution), wording-miss
embeddings, `why` and links in the Knowledge panel, `locks` checked at plan
time, links kept incrementally. `prompts/autoapp/README.md` already has this
prompt's row.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts
bun test tests/autoapp-knowledge.test.ts tests/autoapp-task-context.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

In `tests/autoapp-intent-run.test.ts`, for Step 0:

- a. A builder's turn whose fake adapter fails at the provider before any tool
  call: task `interrupted`, `attempts` unchanged, intent `stopped` with the
  provider sentence, no advice asked (the fake records no second model call),
  the next task still `in-queue`, and no `failed` row in `task_events`.
- b. The same when `ai.turn` cannot start (no provider configured).
- c. A turn that ends `failed` with no tool call and no error event: `interrupted`
  with the "before the model did anything" note.
- d. A provider failure **after** tool calls that edited the workspace is still
  an interruption, and the edits are left in place.
- e. `sanitisedLogger` redacts the shape from 13d's report on `error` and `warn`
  and leaves an ordinary line unchanged.
- f. The panel test the diagnosis calls for, or the report's statement that it
  could not be reproduced.

New `tests/autoapp-task-context.test.ts`:

1. The `intents.sqlite` migration backfills `task_runs` from `run_ids`, attempts
   by position; `moveTask(→in-progress, runId)` adds one row; `taskForRun` of an
   unknown id is `null`; the same run id twice is refused.
2. A spoke turn whose message has no `Application:` line gets its application's
   documents, and its `contexts` row names the right `appId`. A chat turn is
   resolved exactly as before.
3. `attemptsDocument`: no earlier run gives `null`; two attempts give both
   blocks, oldest first; a signature in both last builds gives the **Came back**
   line naming attempts 1 and 2; more than 8 paths gives "and <k> more"; over
   1,500 characters cuts at a line and keeps the newest attempt whole; an
   `interrupted` attempt has no **Ended with**; advice present gives the
   diagnosis and never the note; a machine path in a build message is sanitised.
4. Through the executor with the fake adapter: attempt 1 edits a file and fails
   its verdict; attempt 2's delivered documents include `attempts:<appId>`
   naming that file, in second place; attempt 1's do not include it.
5. Stop after a failed attempt, reopen both stores with `recover: true`, start
   again: the first message carries "The last attempt ended with:" and the
   attempts document is delivered. This is the case that is blind today.
6. `fileKey`: `./src/a.ts`, `src\a.ts` and `src/a.ts` are one key; an absolute
   path and a path with `..` are `null`; the same path under two applications
   gives rows that never join.
7. `rebuildLinks` over a fixture with one task, two runs, edits, a case opened
   in the first and resolved in the second, a lesson distilled from it and
   served to the second: each `rel` has exactly the expected rows, each `source`
   names a row that exists; run twice, the table is identical; a `locks` entry
   "the routes file" is skipped and reported; dropping `links` and rebuilding
   restores it.
8. Tier 2: a lesson from a case that edited `src/host/routes.ts` is served to a
   task that edited it in attempt 1, with reason `related:src/host/routes.ts`;
   not to a task in another application; not when `corpus.related` is `false`;
   never a `method_unclear` or retired lesson; never more than 2.
9. Tier 3 is matched on the task's words: a lesson whose only match is a word of
   the builder's fixed sentences ("acceptance", "criterion", "backlog") is not
   served to a spoke turn.
10. A turn with no task: `search` returns exactly what it returned before this
    prompt for the same store (hold one 12b fixture to it).
11. The `search` event's `why` has one entry per delivered ref, every reason
    from the closed list.

`tests/autoapp-intent-run.test.ts` and `tests/autoapp-knowledge.test.ts` change
only where a delivered ref list is asserted in order; list each changed
assertion in the report.

Then by hand, once, and **not while any other session or `knowledge evaluate` is
using the model on this machine** (report 12d's batch was spoiled that way):
take 12d's case as a backlog task — Notes, "Add a Mark done button to each row",
planned with 13b's tools, criteria as the planner writes them. Find or make a
variant in which attempt 1 fails on this model more often than not (12d's note
says the `confirmText` error names its own repair, so that one alone is too
easy; say what you used). Run it three times with `documents.attempts` and
`corpus.related` on and three times with both off, a fresh workspace each time.
Per run: attempts used, completed or not, tool calls and tokens of attempt 2,
whether attempt 2 re-read files attempt 1 had read, whether attempt 2 repeated
an edit attempt 1 had made, and how many delivered documents you judge
irrelevant to the task. Six runs is a small number; say what the table can and
cannot support, as 12d did. If attempt 1 never fails, report that and stop:
do not tune the task until it does.

## Acceptance criteria

- A turn that failed at the provider, could not start, or ended before the model
  did anything interrupts its task without costing an attempt, stops the run
  with a sentence that says so, asks no advice, and is never written down as a
  failed attempt.
- Nothing the launcher prints carries what the knowledge log redacts.
- The Backlog panel shows its intents on first open, or the report says why the
  fault could not be reproduced.
- A spoke turn's task is found from its run id by equality, with no parsing, and
  its application no longer depends on the message's first line.
- A second or later attempt is given what earlier attempts changed, how each
  ended, what was still wrong, what came back, and the planning model's
  diagnosis, in at most 1,500 characters; a first attempt is given none of it.
- A task resumed after a stop or a launcher restart is told the same.
- `links` can be dropped and rebuilt to the same rows; every row names where it
  came from and which application it belongs to; no row carries a weight.
- A task's lessons come from pinned, then at most two by shared file, then the
  task's own words; a turn without a task is served as before.
- The `search` event says why each delivered document was there.
- No outcome changes what is served. No embedding, no new tool, no change to
  `packages/broapp`. `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/14a-task-context.md`: the by-hand table with its
caveats; the index's counts per `rel` and the skipped locks on the real store;
the rebuild time; every existing assertion you changed; what `query.limit` is
and whether the refs fit; anything in this prompt's decisions that the code
contradicted; and for Step 0, the panel fault's cause in two sentences and the
redaction shape you tested.

## Commit

```
Give a task's turn its task: earlier attempts, and what is related

A backlog turn is now found by its exact run id, so the knowledge layer
knows which task it is building. Every attempt after the first is handed
what the earlier ones changed, how they ended, what came back and how the
planning model read the failure, and a task resumed after a stop or a
restart is told the same. A rebuildable index links tasks, runs, files,
cases and lessons with the row each link came from; a task's lessons come
from its own words and from shared files by fixed rules, and the search
event says why each document was there. Nothing is ranked by outcome.

First, three faults from the last run: a turn the provider killed interrupts
its task instead of costing it an attempt, the launcher's own log is redacted
as the knowledge log is, and the Backlog panel shows its list on first open.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
