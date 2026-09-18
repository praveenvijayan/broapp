# Autoapp: the backlog

A request that is really five changes becomes one long turn, and the
measurements in reports 08c, 12b and 12j say long turns are where a local
model stalls. The backlog records what was asked, how it was split, and how
far each part got. The launcher's rail calls it **Backlog**; the code calls it
`intent`, because [backlog.md](backlog.md) already uses the word for deferred
framework work.

This page describes what exists after prompt 13a: the store, the plan format,
the tier rule, the routes and the panel. Nothing fills the backlog or runs it
yet. Prompt 13b makes the engineer plan into it, and 13c runs it.

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
| `failed` | `in-queue` |
| `interrupted` | `in-queue` |
| `completed`, `removed` | nothing |

`needs-answer` is a task whose builder asked the person a question. The
question is in `question`, and every `{ question, answer, at }` so far is in
`answers`. When an intent is withdrawn, a `failed` or `interrupted` task goes
to `in-queue` and then to `removed`. Both moves are recorded, so the history
shows the way the task went.

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
- Priority is `high`, `normal` or `low`.

`validateTask` names the field of each problem. `validateGraph` refuses a
cycle in `blocked_by`, and names every slug in the cycle. It also refuses more
than twelve live tasks in one intent.

## Run order

`runOrder` sorts blockers first, then priority (`high` first), then slug. The
panel and the executor use the same function.

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
these is refused with a sentence when the rules above do not allow it.
