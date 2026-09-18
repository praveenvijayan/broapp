# Autoapp: the backlog

A request that is really five changes becomes one long turn, and the
measurements in reports 08c, 12b and 12j say long turns are where a local
model stalls. The backlog records what was asked, how it was split, and how
far each part got. The launcher's rail calls it **Backlog**; the code calls it
`intent`, because [backlog.md](backlog.md) already uses the word for deferred
framework work.

This page describes what exists after prompt 13c: the store, the plan format,
the tier rule, the routes, the panel, the engineer's tools that fill the
backlog, and the executor that runs it.

## Words

- An **intent** is one request from a person, analysed: the request as typed,
  what it was understood to be, what it builds on, what conflicts with it,
  what is out of reach, what was assumed and what is still open.
- A **task** is one independently verifiable change inside an intent,
  written as a **plan**.

## Where it is kept

`<root>/launcher/intents.sqlite`, beside `knowledge.sqlite`. It has its own
migrations under `user_version`, and uses the same pragmas as the knowledge
store (WAL, `foreign_keys`, a five-second busy timeout). `synchronous` stays at
WAL's NORMAL for the reason given in `src/knowledge/store.ts`: recovery reads
nothing in this file. `task_events` is append-only, and triggers refuse any
update or delete. The launcher opens the store for `open` and `serve` and
closes it on shutdown. `<root>/launcher/intent-models.json` holds the model for
each tier.

## Statuses

An intent is `draft`, `running`, `stopped`, `done` or `withdrawn`. A person can
withdraw a draft or a stopped intent. Every task it has not completed is then
removed.

A task stores one of eight statuses. A ninth, `blocked`, is derived when the
task is read and is never stored: it is an `in-queue` task with a blocker that
is not `completed`.

Every change of status goes through `moveTask`. It refuses a move that is not
in the table below, and it appends a `task_events` row in the same
transaction.

| From | To |
|---|---|
| `proposed` | `in-queue`, `removed` |
| `in-queue` | `in-progress`, `failed`, `removed` |
| `in-progress` | `completed`, `failed`, `interrupted`, `needs-answer` |
| `needs-answer` | `in-queue`, `removed` |
| `failed` | `in-queue`, `proposed`, `removed` |
| `interrupted` | `in-queue`, `removed` |
| `completed`, `removed` | nothing |

`moveTask` also stamps what a move means, in the same transaction, and nothing
else writes these columns: `in-progress` sets `started_at`, clears `ended_at`,
adds one to `attempts` and appends the run id to `run_ids`; `completed` and
`failed` set `ended_at`; `interrupted` and `needs-answer` set `ended_at` and take
the attempt back, because neither was the builder's failure. `in-queue → failed`
is a task whose model is no longer offered, which fails without a turn;
`failed → proposed` is a failed task the engineer revised after a run stopped.

`needs-answer` is a task whose builder asked the person a question. The
question is in `question`, and every `{ question, answer, at }` so far is in
`answers`. When an intent is withdrawn, a `failed` or `interrupted` task goes
straight to `removed`, with one event. It never waited in the queue, so its
history does not say it did.

## Tiers

The host computes a task's tier. A model never supplies it. The model gives
`reasoning` (`low`, `medium` or `high`), and that is one input to the rule.

| Tier | When | Reason given |
|---|---|---|
| `deep` | `risk` is `high` | It is marked high risk. |
| `deep` | labels include `migration` | It changes a migration. |
| `deep` | `reasoning` is `high` | It needs deep reasoning. |
| `deep` | `estimated_lines` over 200 | It is estimated at more than 200 lines. |
| `deep` | two or more `blocked_by` | It waits on two or more other tasks. |
| `light` | no `deep` rule applies, 60 lines or fewer, `reasoning` is `low`, and every label is `views`, `theme` or `copy` | It is 60 lines or fewer, needs little reasoning, and touches only views, theme or copy. |
| `standard` | anything else | It is neither small enough to be light nor risky enough to be deep. |

A task runs on its own model when a person chose one. If not, it runs on its
tier's model from `intent-models.json`. If that is `null`, it runs on the
model chosen in Settings. Every model must come from the one configured
provider.

## The plan format

The rows are the source of truth. The markdown is a view of them: the host
renders it, and nothing parses it back.

```
---
title: <imperative summary of the one change>
priority: high
labels: [views]
blocked_by: []
estimated_lines: 120
locks: []
risk: normal
stub: false
---

One or two sentences: what this is and why it exists.

## Acceptance criteria
- [ ] <observable, testable outcome>
- [ ] <what the person sees when it fails: a clear message, never a raw error>
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- ...

## Test notes
- ...

## Human runbook
- ...
```

- `repaid_by: <slug>` follows `stub:` only on a stub.
- A task with a `no_failure_path` reason renders `- [ ] No failure path:
  <reason>` in place of a failure criterion.
- The host writes the last criterion. Criterion `c2` of task `0007-add-tags`
  is tested by the acceptance example `0007-add-tags-c2`.
- A slug is `NNNN-words`. The number is the next free one for the
  application, across all of its intents. The words are at most six,
  lowercase.
- Labels come from a fixed list: `contract`, `host`, `migration`, `views`,
  `theme`, `acceptance`, `copy`. A task has one to four.
- Priority is `high`, `medium` or `low`. Risk is `high` or `normal`.

`validateTask` names the field of each problem. `validateGraph` refuses a
cycle in `blocked_by`, and names every slug in the cycle. It also refuses more
than twelve live tasks in one intent.

## Run order

`runOrder` sorts blockers first, then priority (`high` first), then slug. The
panel and the executor use the same function.

## How a request becomes a backlog

A request with more than one change that can be checked on its own, or one the
engineer estimates at over 200 changed lines, is planned rather than started.
A single small change is still made directly. The engineer's instructions say
so, and the `intents` topic of `spec.reference` has the details.

1. The engineer reads the application with `spec.read`.
2. `intent.open` writes the analysis: the request restated, what it builds on
   (`fits`), conflicts, what is out of reach, assumptions and questions. The
   request itself is the message the person typed, taken from the turn the tab
   recorded. An application has at most one draft: a second `intent.open`
   replaces the analysis of that draft and keeps its tasks and its request.
3. With questions, the engineer asks them in the chat and stops. The panel shows
   them first, under **The engineer needs answers**. The answer starts a new
   turn, and the engineer calls `intent.open` again with the answers folded in
   and no questions left. Until then `intent.task` and `intent.submit` refuse.
4. `intent.task` adds one task at a time. A plan problem comes back as
   `ok: false` with each field named, and nothing is stored, so the model repairs
   the plan as it repairs a failed build. `replaces` rewrites a task that is
   still `proposed` and keeps its slug.
5. `intent.submit` checks the whole plan and stamps `submitted_at`. Until then
   the panel shows the draft as **Being written**. The engineer tells the person,
   in a sentence or two, that the plan is in the Backlog panel, and stops.

A turn that called `intent.open` or `intent.task` cannot edit or build:
`source.edit`, `source.change`, `candidate.build` and `candidate.cycle` answer
"This turn planned a backlog. The person reviews it first." The next turn can.

Every later turn about an application with an intent in `draft`, `running` or
`stopped` is given a document, `intent:<appId>`, "The backlog for <appId>",
after the orientation: each live intent's status, its open questions, and one
line per task with its slug, status, tier and title, and a failed task's reason.
It is at most 1,500 characters, and the turn's context row records it like any
other document.

Each accepted call writes one `log` event: `intent 4 opened for notes`,
`task 0007-add-tags proposed (deep)`, `intent 4 submitted with 5 tasks`.

## What the host checks and what the model decides

| The host checks or decides | The model decides |
|---|---|
| The request, from what the person typed | The restatement of it |
| That `fits` names a route, page or component of the release that is serving, as a whole word (skipped for an application with no routes, such as the blank) | Which parts of the application the request builds on |
| One draft per application; no new analysis while an intent runs | Whether the request needs questions answered first |
| That nothing is split while questions are open | The questions |
| Every field of a task against the plan format | Titles, summaries, criteria, labels, estimates, priority, reasoning |
| The slug's number, the criterion ids, the tier and the model | The slug's words |
| That every `blocked_by` and `repaid_by` names a task, and that there is no cycle | How the work is split and what waits on what |
| That a turn which planned does not edit or build | When to plan and when to change directly |
| That a draft leaves `draft` only by a person, or a tool that asks one | Nothing: the engineer cannot start a task |
| Whether a task is completed, from the verdict below | Nothing: its closing words are not evidence |

## How a backlog runs

![Hub and spoke: the host executor, started and stopped by the person, runs each task as its own builder turn, answers the launcher gate itself only for edits, builds and previews of its own application, sends every other question to the person, decides completion from a verdict on evidence, and asks the main model for advice when a task fails.](../../diagrams/autoapp-backlog-run.svg)

The hub is two things. The **host executor** (`src/intent/executor.ts`) is
deterministic code: it decides the order, the model, the time allowed, whether a
task is finished and when to stop. The **main model**, the one chosen in
Settings, is asked where judgement is needed: once for advice when a task
fails, and on the person's next chat turn, where the `intent:<appId>` document
tells it what happened. No model supervises another; reports 08c and 12j
measured what a local model does with one long open-ended turn.

1. The person says to go ahead in the chat (`intent.start`, which the gate asks
   about) or presses **Run** in the panel (`launcher.intentRun`, behind an
   inline confirmation). Both say what is being agreed to, and both call
   `executor.start`.
2. Start requires a submitted draft with no open questions, or a stopped
   intent whose live tasks form a valid graph; no task waiting for an answer;
   something left to run; no other run in this launcher; and AI set up. It moves
   `proposed`, `failed` and `interrupted` tasks to `in-queue`, sets the intent
   `running`, and returns at once.
3. One task at a time, in run order. Each is one engineer turn, run id
   `intent-<intentId>-<slug>-a<n>`, with no history, on `modelFor(task)`: its own
   model, its tier's, or the Settings model. A model the provider no longer
   offers fails the task without a turn.
4. The builder's message starts `Application: <appId>` (the turn's documents are
   chosen from its run id, which the backlog records in `task_runs`; the line is
   for a reader), says to build this one task with one example per
   criterion under exactly the ids `<slug>-c<n>`, to use `candidate.cycle`
   until every check passes, not to remove or rename an example already there,
   and not to activate or plan. Then the plan, then any answers the person
   gave, then why the last attempt was not completed.
5. During the turn the executor answers the gate for the person, as described
   in [security.md](security.md#a-run-answers-for-the-person). A question it
   does not cover waits in the panel.
6. When the turn ends, however it ended, the verdict decides. A turn that
   makes no tool call for eight minutes is ended first (the clock holds while a
   tool runs and while a question waits for the person), and the verdict says
   so: "The turn made no tool call for 8 minutes." The twenty-minute limit
   stays.
7. Completed: the next task. Not completed: another attempt with the reasons.
   Two attempts that do not complete stop the run, but an attempt that passed
   more criteria than every earlier one of this run is not counted, and its
   history says "another attempt: it got further (5 of 6)". Four turns a task
   is the ceiling, however much each improves.
8. Every task completed: the intent is `done`. Nothing is activated. The panel
   says to open the preview, look, and activate from the Candidate panel, and
   lists every task's runbook lines under "For you to check by hand".

A task is **completed** only when all of these hold after its turn: the
workspace revision moved since before the task's first turn (so an attempt that
only builds what the last one edited counts); the last build has no problems;
nothing was edited after it; its checks ran on the preview that is running now;
every check passed, so no earlier task's example regressed; every example of the
application's completed tasks is still among the checks ("The example
0004-author-column-c2, from a finished task, is gone."), so none was removed to
make that true; and for every criterion an example named `<slug>-c<n>` ran. Otherwise each condition that did not hold is a
sentence ("No example named 0007-add-tags-c2 was run.", "The turn ran out of
time."). A completed task records `rev_after`, `release_id` and `actual_lines`
(from `git diff --shortstat`), and each criterion whose example passed is drawn
`[x]` in its plan. A verdict is only as strong as the examples the builder wrote;
the backlog's **A verdict as strong as its examples** row says what would
strengthen it.

**Failure policy: stop.** After the second counted attempt, or the fourth turn, the task is `failed`
with its reasons and run ids, the intent is `stopped`, and later tasks stay
`in-queue`. The workspace is left as the attempt left it, so the person and the
engineer can look; nothing is reset. The main model is then asked one
structured question, `{ diagnosis, advice: retry | revise | split | ask, note }`,
and the answer is shown under the failure; it stays there when the task is
queued again and goes when the task completes or is revised. An answer that does not arrive or
does not parse stores nothing and changes no status. From there the person runs
again (failed and interrupted tasks are queued, and the run continues from the
first unfinished task), or asks the engineer to revise the failed task with
`intent.task` and `replaces`, which returns it to `proposed`.

**What a retry is told, and where it is read from.** An attempt after the first
is told, in its message, "The last attempt ended with:" and the reasons. Inside
one run those come from the verdict just taken; at the start of a run they come
from the task's own history, the newest move from `in-progress` to `failed` or
`interrupted` (`attemptNotes`), so a task resumed after a stop or a launcher
restart is told the same. The message cannot be cut by the context budget. The
turn is also given the attempts document (see
[learning.md](learning.md#what-a-tasks-turn-is-given)): what each earlier attempt
changed, how it ended, what was still wrong, what came back, and the planning
model's diagnosis, read from the knowledge log's events for each run id in
`task_runs`. An earlier attempt that edited nothing also says what it read (at
most six paths, from the launcher's run store, which already records every
`source.read`), and when the newest earlier attempt changed nothing the
document ends with the one line in it that tells the builder what to do: "The
last attempt read these and changed nothing. Do not read them again: make the
first edit the plan calls for, then use candidate.cycle."

**A turn the provider killed is not an attempt.** When the AI provider fails
during a builder's turn, the turn cannot start, or it ends `failed` before the
model made a single tool call, no verdict is taken: the task moves to
`interrupted` (the attempt is given back) with a note beginning
`not an attempt:`, the intent stops with "The AI provider returned an error
while building <slug>. Nothing was judged. The launcher's log has the detail."
(or "…ended before the model did anything…"), no advice is asked, and the next
task is not started, because it would meet the same provider. The note carries
the AI layer's reduced sentence, never the provider's raw text. A turn the idle
clock, the time limit or a Stop ended is judged as before.

**A builder that is unsure asks.** `intent.ask` records one question on the
task, moves it to `needs-answer`, stops the intent with "<slug> needs an
answer", and ends the turn without counting the attempt. The person answers in
the panel (`launcher.intentAnswer`), which returns the task to the queue; they
then press Run. At most two questions per task; a third is told to decide with
what it has.

**Stopping.** `launcher.intentStop` aborts the turn: the task is `interrupted`,
the intent `stopped` "by the person", and the preview is left as it is. While a
run is going, other turns may read the application and talk to the engineer,
but every tool that writes to that application, and `launcher.activate`, is
refused until the run stops.

**A restart interrupts and never resumes.** When the launcher's tab opens the
store (`openIntents(…, { recover: true })`; `serve <appId>` and the one-shot
commands open it without, because a launcher beside them may be running), any
`in-progress` task becomes `interrupted` (attempt given back) and any `running`
intent becomes `stopped`, "The launcher stopped." An interrupted turn may have
left half a change, and a person decides what happens to an outcome nobody saw.

## Routes and the panel

The reads are `launcher.intentsList`, `intentGet`, `intentPlan` and
`intentModelsGet`. The writes are `launcher.intentTaskModel`,
`intentTaskRemove`, `intentWithdraw`, `intentModelsSet`, and since 13c
`intentRun`, `intentStop` and `intentAnswer`. Each write is a `write` that is
accepted only on channel `user`. No engineer tool names any of them.
`launcher.intentGet` carries the run's progress (`run`: the task in hand, its
turn, when it started, its last tool, how many approvals, and a question
waiting for the person), and `launcher.intentRunning` says whether any run is
going and waiting. If a launcher has no store, every one of these routes answers
`unavailable`.

The **Backlog** panel shows the intents of the application selected in the
launcher, newest first. Open an intent to see the request, the analysis and
the tasks in run order. Each task shows its slug, title, priority, tier (the
reasons are in the tooltip), model, status and the tasks it is blocked by. A
person can change a task's model, open a task to read its plan and history,
remove a task, withdraw the intent, and set the three tier models. Each of
these is refused with a sentence when the rules above do not allow it. A draft
the engineer has not submitted shows **Being written** beside its status, and a
draft with open questions shows them first.

A submitted draft or a stopped intent has **Run**, and a running one **Stop**,
each behind an inline confirmation. While a run goes, the task in hand shows
its last tool; a failed task shows its reasons, the main model's advice and
"Run again to retry, or ask the engineer to revise this task."; a task waiting
for an answer shows the question and a box to answer it. A question the run
brought to the person is shown at the top with **Approve** and **Deny**, answered
through `ai.chatConfirm`, and the rail's Backlog button is marked while one
waits. The panel reads again every two seconds while a chat turn runs, while the
open draft is being written, or while a run goes, and never otherwise.
