# 13a — The intent store, the plan format and the Backlog panel

## Goal

Today a person types what they want and the engineer starts editing. A request
that is really five changes becomes one long turn, and the measurements in 08c,
12b and 12j say long turns are where this model stalls. Nothing records what was
asked, how it was split, or how far it got.

This prompt builds the ground for a backlog and nothing that needs a model: a
store for intents and their tasks, the plan format and its validator, the rule
that gives a task a tier, the setting that maps a tier to a model, the launcher
routes, and a **Backlog** panel on the rail where a person reads the tasks,
changes a task's model, removes a task and withdraws an intent. 13b makes the
engineer fill it. 13c runs it. After this prompt the panel works over rows a test
or the command line put there.

Words, fixed: an **intent** is one request from a person, analysed. A **task** is
one independently verifiable change inside it, written as a **plan**. The rail
says **Backlog**. The code says `intent`, because `docs/autoapp/backlog.md` and
prompt 10 already own the word "backlog" for deferred framework work.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report so far; 12k's report for how
  a panel and its routes were added.
- `docs/autoapp/design.md`, the section **How the launcher is composed**. This
  feature is the "second feature that needs routes, tools, an engineer hook, a
  panel and migrations together" that section names. The decision stays: wire it
  by hand in `createLauncherTab` under its own name. Do not build a registry.
  Your report lists what knowledge and intent each needed from the tab, side by
  side, so the abstraction can be judged later from two instances.
- `packages/broapp-autoapp/src/knowledge/store.ts` — `MIGRATIONS`, `user_version`,
  the pragmas and the comment about `synchronous`. Copy the shape.
- `packages/broapp-autoapp/src/launcher/{contract,app,tab,main}.ts` —
  `launcher.knowledge*` routes are the pattern; `main.ts` line ~687 is where the
  knowledge store is opened and handed in.
- `packages/broapp-autoapp/src/launcher/ui/{App,KnowledgePanel,LogsPanel}.tsx`
  and `launcher.css` — the rail, the overlay, tabs, row opening, inline
  confirmation, chips.
- `packages/broapp/src/ai/shared/types.ts` (`BroappModel`) and
  `packages/broapp/src/ai/react/use-ai-models.ts`.
- `packages/broapp-autoapp/src/spec/types.ts` (`AcceptanceExample`).
- `tests/autoapp-knowledge.test.ts`: `makeWorld` and `describe('the launcher tab')`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Module | `packages/broapp-autoapp/src/intent/`: `types.ts`, `plan.ts`, `tier.ts`, `store.ts`, `models.ts`, `index.ts`. |
| Store | `intents.sqlite` beside `knowledge.sqlite` (`join(root.root, 'launcher')`), its own `MIGRATIONS` array and `user_version`, WAL, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous` left at WAL's NORMAL with a one-sentence comment pointing at the reasoning in `knowledge/store.ts`. Opened by `main.ts` when `longRunning`, handed to `createLauncherTab` as `options.intents?: IntentStore`, passed on to `createLauncherApp`. Absent, every intent route answers `unavailable`: "This launcher keeps no backlog." |
| Tables | `intents(id INTEGER PK, app_id, request, restated, fits, conflicts JSON, out_of_reach JSON, assumptions JSON, questions JSON, status, proposed_by_run, hub_model, created_at, submitted_at, started_at, ended_at, stop_reason)`. `tasks(id INTEGER PK, intent_id FK, seq, slug UNIQUE per app, title, priority, labels JSON, blocked_by JSON, estimated_lines, locks JSON, risk, stub, repaid_by, summary, criteria JSON, no_failure_path, non_functional JSON, test_notes JSON, runbook JSON, reasoning, tier, tier_reasons JSON, model_override, status, attempts, rev_before, rev_after, release_id, actual_lines, run_ids JSON, failure JSON, advice JSON, question, answers JSON, started_at, ended_at)`. `task_events(id, task_id FK, at, from_status, to_status, note)` append-only. Several columns are written only by 13b or 13c; create them now so there is one migration. |
| Intent status | `draft`, `running`, `stopped`, `done`, `withdrawn`. |
| Task status | Stored: `proposed`, `in-queue`, `in-progress`, `needs-answer`, `completed`, `failed`, `interrupted`, `removed`. `needs-answer` is a task whose builder asked the person something (13c); `question` holds it and `answers` holds every `{ question, answer, at }` so far. Derived when read, never stored: `blocked` — an `in-queue` task with a blocker that is not `completed`. The three words the person asked for are the literal values `in-queue`, `in-progress`, `completed`. Every change of status goes through one function, `store.moveTask(taskId, to, note)`, which refuses a move not in the table below and appends a `task_events` row in the same transaction. |
| Allowed moves | `proposed→in-queue`, `proposed→removed`, `in-queue→in-progress`, `in-queue→removed`, `in-progress→completed`, `in-progress→failed`, `in-progress→interrupted`, `in-progress→needs-answer`, `needs-answer→in-queue`, `needs-answer→removed`, `failed→in-queue`, `interrupted→in-queue`. Nothing leaves `completed` or `removed`. |
| Slug | `NNNN-kebab-words`: four digits, the next free number for that application across all its intents, then at most six lowercase words from the title. The host assigns the number; a caller supplies only the words. Pattern `^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+){0,5}$`. |
| Labels | A fixed vocabulary: `contract`, `host`, `migration`, `views`, `theme`, `acceptance`, `copy`. One to four per task. Anything else is `invalid_input` naming the label. |
| Criteria | `criteria` is an array of `{ id: 'c1'…, text: string ≤ 200, failure: boolean }`, two to eight. At least one has `failure: true` (what the person sees when it goes wrong), unless the task carries `no_failure_path` — a reason, 20 to 200 characters — in which case none is required. The format's last line, "Every criterion above has exactly one test named after it", is never stored: the host writes it when it renders the plan, because the host is what checks it (13c): criterion `c2` of task `0007-add-tags` is tested by the acceptance example whose `id` is `0007-add-tags-c2`. |
| Plan validation | `plan.ts` `validateTask(input, siblings)` returns a list of `{ field, message }`, empty when valid: `title` 8–100 characters and not ending with a full stop (whether it is imperative cannot be checked, so it is not); `priority` one of three; `estimated_lines` integer 1–400; `risk` `high` or `normal`; `stub` true requires `repaid_by`, false forbids it; `repaid_by` and every `blocked_by` entry must be the slug of another task of the same application that is not `removed`; a task may not block itself; `locks` at most five strings of at most 60 characters; `summary` 20–400 characters; the three optional sections at most six lines of at most 200 characters each. `validateGraph(tasks)` refuses a cycle in `blocked_by`, naming the slugs on it, and more than twelve live tasks in one intent. |
| Plan rendering | `plan.ts` `renderPlan(task): string` produces exactly the format in the appendix: front matter in that key order, the summary, `## Acceptance criteria` with `- [ ]` lines (`- [x]` for a criterion whose example passed, once 13c records that), then the optional sections only when non-empty. No parser: the rows are the source of truth and markdown is a view of them. |
| Tier | `tier.ts` `tierOf(task): { tier: 'light' \| 'standard' \| 'deep'; reasons: string[] }`, computed by the host and never supplied by a model. `deep` when any of: `risk` is `high`; labels include `migration`; `reasoning` is `high`; `estimated_lines` > 200; two or more `blocked_by`. Otherwise `light` when all of: `estimated_lines` ≤ 60; `reasoning` is `low`; every label is one of `views`, `theme`, `copy`. Otherwise `standard`. Each rule that fired contributes one plain sentence to `reasons` ("It changes a migration."). `reasoning` is `low`, `medium` or `high`, supplied with the task; it is an input to the rule, not the answer. |
| Tier → model | `models.ts`: `<dataDir>/intent-models.json`, `{ light, standard, deep }`, each a `modelId` or `null`. `null` means the model configured in Settings. Written with `writeAtomic`. `modelFor(task, mapping): string \| null` = `task.model_override ?? mapping[task.tier]`. All models are within the one configured provider, because `registry.resolve` overrides a model id and nothing else. A model from another provider is out of scope; add the row to `docs/autoapp/backlog.md`. |
| Reads | `launcher.intentsList { appId?, limit?: 1..100 }` → intents newest first with `id`, `appId`, `status`, `restated` (or the first 120 characters of `request`), `createdAt`, and task counts by status including derived `blocked`. `launcher.intentGet { id }` → the intent in full and its tasks in run order (see below), each with every column, derived `status`, `model` (what `modelFor` resolves to, or `null`), and its `task_events`. `launcher.intentPlan { taskId }` → `{ markdown }`. `launcher.intentModelsGet` → the mapping. All effect `read`. |
| Writes | All effect `write`, channel `user`. `launcher.intentTaskModel { taskId, modelId: string \| null }` — only while the task is `proposed`, `in-queue`, `failed` or `interrupted`; else `conflict`. `launcher.intentTaskRemove { taskId }` — only `proposed` or `in-queue`, and refused with `conflict` naming the slugs when another live task lists it in `blocked_by` or `repaid_by`. `launcher.intentWithdraw { id }` — only `draft` or `stopped`; its non-completed tasks become `removed`. `launcher.intentModelsSet { light, standard, deep }`. No engineer tool names any of these; a test asserts it. |
| Run order | `store.runOrder(intentId)`: topological by `blocked_by`, then `priority` (`high` first), then slug. One function; the panel and 13c's executor both use it. |
| The panel | A **Backlog** item on the rail (icon `ListChecks` from `lucide-react`; confirm the export exists before using it), an overlay like Knowledge, width `min(56rem, 100%)`. The backlog is per application: the panel shows the intents of the application selected in the launcher (`session`), newest first, and with none selected it says "Choose an application to see its backlog." There is no all-applications view; `launcher.intentsList` keeps its optional `appId` for tests and the panel always sends it. Opening one shows, top to bottom: the **request** as typed; the **analysis** — restated, what it builds on, conflicts, out of reach, assumptions, open questions — each block absent when empty; then the tasks in run order. A task row: slug, title, priority pill, tier pill with its reasons as the `title` attribute, a model `<select>` (options from `useAiModels`, filtered to `capabilities.tools`, first option "Settings model"), a status chip, `blocked by 0003-…` when blocked. Opening a row shows the rendered plan in a `<pre>`, the status history, and **Remove** with an inline confirmation. Above the list: **Withdraw** (inline confirmation), and a collapsed **Models by tier** block with three selects. Refresh on open and on a **Refresh** button. No Run button yet: 13c adds it. |
| Status chips | Colours from the four existing pairs only: `completed` good, `failed` error, `in-progress`, `needs-answer` and `interrupted` warn, the rest quiet. |
| Empty and error states | No intents: "Nothing has been planned yet. Ask the engineer for a change with more than one part." No store: the `unavailable` sentence. A models list that fails to load leaves the select showing the current value and a sentence under it. |
| CLI | None in this prompt. |
| Not in scope | Any engineer tool, any change to `instructions.ts`, running anything, editing a task's text from the panel, reordering by hand, a stream route. |

## Step 1 — `types.ts`, `plan.ts`, `tier.ts`

Pure functions, no database. Export `TaskInput` (what 13b's tool will send:
every plan field except slug number, tier and status), `TaskRecord`,
`IntentRecord`, `INTENT_STATUSES`, `TASK_STATUSES`, `TASK_MOVES`, `LABELS`.

## Step 2 — `store.ts` and `models.ts`

`openIntents(dataDir): IntentStore` with `createIntent`, `replaceAnalysis`,
`addTask` (validates, assigns slug and tier), `replaceTask` (same slug, only while
`proposed`), `moveTask`, `setModel`, `removeTask`, `withdraw`, `get`, `list`,
`runOrder`, `close`. Every write is one transaction. `close()` is called from the
launcher's shutdown beside the knowledge store's.

## Step 3 — routes

`contract.ts` and `app.ts`, then `tab.ts` and `main.ts` for the wiring.

## Step 4 — the panel

`ui/IntentPanel.tsx`; rail button, overlay and Escape in `App.tsx`; styles in
`launcher.css` as `launcher__intent-*`, reusing `launcher__k-*` chips and tabs
where the shape is the same. Follow section 2b of the common rules: this panel
adds no renderer kind and no vendored component, so the gallery and harness
items do not apply; keyboard, focus, labels, states and tokens do.

## Step 5 — docs

New `docs/autoapp/intents.md`: what an intent and a task are, the statuses and
moves as a table, the tier rule as a table, the plan format, where the store is.
Link it from `docs/autoapp/README.md` and from design.md's closing list. In
`design.md` under **How the launcher is composed**, one paragraph: the second
cross-cutting feature arrived with this prompt and was wired by hand; what the
two needed is compared in report 13a. `docs/autoapp/backlog.md`: rows for
"models from a second provider per task", "editing a task's text in the panel",
"parallel tasks".

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New `tests/autoapp-intent.test.ts`:

1. `validateTask` names the field for each refusal in the table: a label outside
   the vocabulary, 401 lines, `stub` without `repaid_by`, `repaid_by` without
   `stub`, one criterion, no failure criterion and no `no_failure_path`, a
   `blocked_by` naming an unknown slug, a task blocking itself.
2. `validateGraph` refuses a three-task cycle and names all three slugs; refuses
   a thirteenth task.
3. `renderPlan` of a full task equals a fixture string, byte for byte, including
   the host-written last criterion; of a minimal task it has no optional sections.
4. `tierOf`: one case per rule, each with its reason sentence; a task matching
   both a `deep` rule and the `light` rules is `deep`.
5. Slugs: two tasks in two intents of one application get consecutive numbers; a
   second application starts again at `0001`.
6. `moveTask` refuses every move not in the table (generate the pairs), appends
   one event per accepted move, and `blocked` is derived and never stored.
7. `removeTask` refuses while another task depends on it and names the dependant.
8. `runOrder`: blockers first, then priority, then slug.
9. `modelFor`: override wins; `null` mapping gives `null`; mapping applies by tier.
10. Under `describe('the launcher tab')` in this file (build the tab as
    `makeWorld` does, with an intent store in the temp dir): the four reads
    return what was stored; each write works on channel `user`; no key of
    `engineerTools(...)` starts with `intent.` or names a `launcher.intent*`
    route; a tab without the store answers `unavailable` on all of them.
11. `IntentPanel` rendered with `renderToString`: an empty list shows the empty
    sentence; an intent with a blocked task shows `blocked by` and its slug; the
    `unavailable` error shows its sentence.

## Acceptance criteria

- The Backlog panel opens from the rail and shows intents, their analysis and
  their tasks in run order, each with slug, tier and reasons, model, and status.
- A person can change a task's model, remove a task nothing depends on, withdraw
  an intent and set the three tier models; each is refused with a sentence when
  the table says so.
- A plan renders in exactly the appendix's format.
- A task's tier comes from the host's rule, with reasons a person can read.
- `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/13a-intent-store.md`. Include the side-by-side table of
what knowledge and intent each needed from `createLauncherTab`, `main.ts`, the
contract and the rail; the bytes the panel adds to the launcher page.

## Commit

```
Keep a backlog: intents, tasks as plans, and a panel to read them

An intent store beside the knowledge store, the plan format with a validator
and a renderer, a host rule that gives each task a tier and a setting that
maps a tier to a model, launcher routes, and a Backlog panel on the rail where
a person changes a task's model, removes a task or withdraws an intent.
Nothing fills it or runs it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

## Appendix — the plan format

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

`repaid_by: <slug>` appears after `stub:` only when `stub: true`. A task with
`no_failure_path` renders that reason as `- [ ] No failure path: <reason>` in
place of a failure criterion.
