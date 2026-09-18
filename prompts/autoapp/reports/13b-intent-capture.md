# 13b — Capture an intent, question it, and split it into plans

## Step 0 — two corrections to 13a

1. **Priority is `high`, `medium`, `low`**: `PRIORITIES`, `PRIORITY_RANK`, the test fixture,
   `intents.md`. The contract and the panel take any string, so neither changed. There is
   no `CHECK` on priority, so there is no migration.
2. **Withdrawn failed/interrupted tasks go straight to `removed`.** Both moves are in
   `TASK_MOVES`. The test asserts one `failed → removed` event, and the doc table is updated.

## What was built

- `engineer/intent-tools.ts`: `intentTools()` gives the three `read` tools and
  `planning`/`ended` over a set it owns. Also `groundedIn`, `isBlank`, and the two refusal
  sentences.
- `engineer/tools.ts`: `EngineerToolsOptions.intents` (the bundle) and `.planning`. While
  a turn is planning, `source.edit`, `source.change`, `candidate.build` and
  `candidate.cycle` refuse with `PLANNING_REFUSAL`.
- `intent/`: deferred references (`validateTask` option, `referenceProblems`). The store
  gains `planProblems`, `submit`, `live` and `submittedAt`; a change to a draft un-submits
  it.
- `reference.ts`: the `intents` topic, whose `SPLIT_RULES` are also in the `intent.task`
  description. `instructions.ts` gains a paragraph of six lines.
- `serve.ts`: `backlogDocument` (at most 1,500 characters) as `intent:<appId>`, after
  `digest:`. `tab.ts` wires the store and the bundle, and clears a turn in `onRunEnd`.
- Panel: "Being written" beside an unsubmitted draft. A draft's open questions come first,
  under "The engineer needs answers". Docs: `intents.md` (both sections), `security.md`
  ("Drafting a backlog is `read`"), and a `backlog.md` row.

## Deviations, and decisions I made

1. **Blank means no routes.** The blank template carries a page and a `welcome`
   component, so "no routes and no components" never skips the check for it.
2. **The planning refusal comes before the gate**, so nobody is asked to allow an edit
   that is then refused. The gate records nothing for it.
3. **The bundle is built in `tab.ts`**, because `onRunEnd` must clear it.
   `EngineerToolsOptions.intents` is that bundle, not the store.
4. **A second `intent.open` keeps the first request and the tasks.** `proposed_by_run`
   and `hub_model` come from the turn. Success outputs also carry `ok: true`.
5. **Problems name the tool's fields** (`estimatedLines`). The graph is checked as each
   task is added as well as at submit, so test 6 makes its cycle by editing a row.
6. **Instructions stay at 70 lines**, as the existing test requires. Headings lost their
   blank line, and two "may not" bullets became one; no wording changed. The hash
   changed, so `reviewFlags` will flag every lesson for review on the next start. This
   is expected.
7. **Fixed after the by-hand run:** an empty optional string (`replaces: ""`) is read as
   absent (test 5 covers it), and the `blockedBy` wording now asks for whole slugs. The
   launcher was rebuilt and the smoke passed.
8. The commit trailer names Claude Opus 5, per this session's rule. The report runs past
   100 lines because of the by-hand run and the rendered plan the prompt asks for (as 12h).

## The by-hand run

This launcher build ran over the real root. `create reading-list` built the starter from
npm, which has five routes. The configured model was OpenRouter `z-ai/glm-5.3`; the
launcher read its own key. The request: *"In reading-list, add an author to each book,
let me filter the list to only the books I have not read yet, and show how many books
there are by each author."*

- **The calls, in order:** `spec.read`, `source.list`, 6 × `source.read`, 5 ×
  `spec.reference`, then `intent.open`, grounded on `items.list`, `items.add`,
  `items-table` and others. Then 12 × `intent.task` and 2 × `intent.submit`. The first
  submit returned three `blockedBy` problems: the model had named the words
  (`author-column`), not slugs. It fixed them with 3 × `replaces`, and the second submit
  passed. That is 28 calls in all, with no question asked.
- **`ok: false`: 4.** Three were `summary` (902, 836 and 801 characters) and one was
  `labels` (`"data"`). One more call was refused `not_found` for `replaces: ""`
  (deviation 7).
- **The tasks:** `0004-author-column` (deep, the migration, first in run order), then
  `0001-author-field`, `0002-unread-page` and `0003-author-counts` (standard).
- **Did it stop?** Yes: no edit and no build after the submit. Its first words were
  "This request has three parts … so I'll plan it rather than start building." But its
  last message described the four tasks in a paragraph, which the tool says not to do.
- **Cost:** 2 min 55 s, 331,741 tokens in and 28,182 out.
- **The panel** showed the row, the analysis and the tasks. On the very first open the
  list was empty until Refresh, probably queued behind the turn. It did not recur (250 ms
  on reopen).

One plan (`0002-unread-page`, four of its six criteria left out):

```
---
title: Show only the books not yet read
priority: high
labels: [contract, host, views]
blocked_by: [0001-author-field]
estimated_lines: 100
locks: []
risk: normal
stub: false
---

A new read route items.unread (every book not yet read, newest first) and a db.ts WHERE done = 0 statement. …

## Acceptance criteria
- [ ] A route step calls items.unread and succeeds, returning an items array and a count.
- [ ] items.unread returns only books with done false: the filter is the SQL WHERE clause, never a slice taken after the fact.
- [ ] Every criterion above has exactly one test named after it
```

`reading-list` and draft intent 1 are still in the real root. Withdraw the intent from
the panel, or run `broapp-autoapp remove reading-list --yes`.

## Commands run

```
bun run typecheck                                                  exit 0
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-tools.test.ts   40 pass
bun test tests/autoapp-engineer.test.ts tests/autoapp-knowledge.test.ts    117 pass
bun test tests                                                     846 pass, 0 fail
bun run --cwd packages/broapp-autoapp build:launcher               77.2 MB, exit 0
bun run scripts/autoapp-smoke.ts                                   every step passed
bun install && bun run check                                       exit 0
```

## Acceptance criteria

- **A grounded draft with plan-format tasks, shown in the panel** — pass. The chat was
  meant to say only that the plan is there; the model also summarised the tasks.
- **An analysis that names nothing is refused with a sentence the model can act on** —
  pass (test 2).
- **Open questions stop the split** — pass (test 4).
- **A turn that plans cannot edit** — pass (test 9).
- **Later turns see the backlog** — pass (test 10).
- **Drafting asks nobody** — pass (test 8).
- **`tests/ai-chat.test.ts` unchanged, and `check` green** — pass.

## Open questions

- Should `intent.submit` end the turn? The instruction to keep the chat short is text
  only, and a hosted model partly ignored it.
- Should `intent.task` accept a task's words in `blockedBy` and resolve them at submit?
