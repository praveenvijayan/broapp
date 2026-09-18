# Autoapp: the backlog

A request that is really five changes becomes one long turn, and the
measurements in reports 08c, 12b and 12j say long turns are where a local
model stalls. The backlog records what was asked, how it was split, and how
far each part got. The launcher's rail calls it **Backlog**; the code calls it
`intent`, because [backlog.md](backlog.md) already uses the word for deferred
framework work.

This page describes what exists after prompt 13b: the store, the plan format,
the tier rule, the routes, the panel, and the engineer's three tools that fill
the backlog. Nothing runs it yet: prompt 13c does that.

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
| `in-queue` | `in-progress`, `removed` |
| `in-progress` | `completed`, `failed`, `interrupted`, `needs-answer` |
| `needs-answer` | `in-queue`, `removed` |
| `failed` | `in-queue`, `removed` |
| `interrupted` | `in-queue`, `removed` |
| `completed`, `removed` | nothing |

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

## Routes and the panel

The reads are `launcher.intentsList`, `intentGet`, `intentPlan` and
`intentModelsGet`. The writes are `launcher.intentTaskModel`,
`intentTaskRemove`, `intentWithdraw` and `intentModelsSet`. Each write is a
`write` that is accepted only on channel `user`. No engineer tool names any of
them. If a launcher has no store, every one of these routes answers
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
