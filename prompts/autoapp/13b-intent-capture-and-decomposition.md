# 13b — Capture an intent, question it, and split it into plans

## Goal

13a built a backlog nobody fills. After this prompt the engineer fills it. When
a person asks for something with more than one part, the engineer does not start
editing. It reads the application, writes down what was asked and what it makes
of it — what the request builds on, what it collides with, what the rules put
out of reach, what it is assuming, what it has to ask — and then splits the work
into tasks small enough to build and verify one at a time, each in the plan
format. The person reads all of it in the Backlog panel, not in the chat.

The host, not the model, decides whether the analysis touched the real
application, whether a plan is valid, which tier a task is and which model that
means. Nothing runs: 13c does that.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report; 13a's report and
  `docs/autoapp/intents.md`.
- `packages/broapp-autoapp/src/intent/*` from 13a.
- `packages/broapp-autoapp/src/engineer/tools.ts`: `EngineerToolsOptions`,
  `EngineerKnowledge`, `TurnRecord`, how `apps.list` and `knowledge.show` are
  declared (small `read` tools), how a tool answers with located problems
  (`candidate.cycle`).
- `packages/broapp-autoapp/src/engineer/instructions.ts` and the test that holds
  its five headings.
- `packages/broapp-autoapp/src/knowledge/serve.ts`: how a turn's application is
  resolved (line ~257) and how documents are assembled and budgeted;
  `knowledge/freshness.ts` `instructionsHash` and `reviewFlags`.
- `packages/broapp-autoapp/src/spec/store.ts` and `spec/types.ts`: how to read
  the current release's route names and view component ids.
- `packages/broapp/src/ai/host/fake.ts`: `createFakeAdapter`, `FakeStep`.
- `docs/autoapp/security.md`, the effect vocabulary.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Three tools | `intent.open`, `intent.task`, `intent.submit`, in new `src/engineer/intent-tools.ts`, merged into `engineerTools(...)` only when `options.intents` is present. Small calls on purpose: 08b measured that one large tool input stalls this model, and hunks under a kilobyte land. |
| Their effect | `read`. A draft is the engineer's proposal written down, as a transcript is: it changes no application and no release, nothing acts on it, and it cannot leave `draft` except by a person on channel `user` or by a tool that asks (13c). The three tools refuse with `conflict` when the intent is not `draft`. Put that reasoning in a comment above the tools and in `security.md`. If you find a way a draft row can cause an effect without a person, stop and report: the classification is then wrong. |
| `intent.open` input | `{ appId, restated: string 20–400, fits: string 20–600, conflicts: string[] ≤5 × ≤200, outOfReach: string[] ≤5 × ≤200, assumptions: string[] ≤5 × ≤200, questions: string[] ≤3 × ≤200 }`. The person's request is **not** an input: the host takes it from the turn record (`options.knowledge.turn(runId)?.message`), so what is stored is what was typed. Without a turn record the tool stores `restated` as the request and says so in a `note`. |
| Grounding check | `fits` must name at least one thing that exists in the application's current specification: a route name (`notes.create`), a view page id or a component id. The host reads the specification and looks for each known name as a whole word in `fits`. None found → `invalid_input`: "`fits` names nothing this application has. Read it with spec.read and say which routes or pages the request builds on." Skipped when the specification has no routes and no components (a blank application). This is what "analysed against the existing application" means in code. |
| Per application | An intent belongs to exactly one application, named by `appId`; a request that spans two applications is two intents, and the `intent.open` description says so. |
| One draft per application | `intent.open` for an application that already has a `draft` intent replaces that intent's analysis (`replaceAnalysis`) and keeps its tasks; it never creates a second draft. It is refused with `conflict` while an intent of that application is `running`. Output: `{ intentId, status: 'draft', waitingForAnswers: boolean, next }`. |
| Questions block tasks | While the draft's `questions` is non-empty, `intent.task` and `intent.submit` refuse with `conflict`: "This intent has open questions. Ask the person, then call intent.open again with their answers folded in and questions empty." |
| `intent.task` input | `{ intentId, words: string (the slug's words, 1–6 lowercase words), title, priority, labels, blockedBy: string[], estimatedLines, locks?, risk?, stub?, repaidBy?, summary, criteria: { text, failure }[], noFailurePath?, nonFunctional?, testNotes?, runbook?, reasoning: 'low' \| 'medium' \| 'high', replaces?: slug }`. The host assigns criterion ids `c1…`, the slug number and the tier. With `replaces`, the task with that slug is rewritten in place (only while `proposed`). Output on success: `{ slug, tier, tierReasons, model, exampleIds: ['0007-add-tags-c1', …], next }`. On a validation failure: **not** an error — `{ ok: false, problems: [{ field, message }], next: 'Fix these fields and call intent.task again.' }`, so the model repairs as it does after a failed build. `blockedBy` and `repaidBy` may name a task not yet added; that is checked at submit. |
| `intent.submit` input | `{ intentId }`. Runs `validateGraph` and the deferred `blockedBy`/`repaidBy` checks, and refuses an intent with no tasks. Problems are returned as above. On success sets `submitted_at` and returns `{ tasks: [{ slug, title, tier, model, blockedBy }], next: 'Tell the person the plan is in the Backlog panel, in one or two sentences. Do not list the tasks in the chat. Do not start any of them.' }`. |
| What a good split is | Written once, in the `intent.task` description and in a new `intents` topic for `spec.reference` (`engineer/reference.ts`): one task is one change a person could accept or reject alone; it leaves the application building and every earlier check passing; it is at most 400 changed lines, and a task over 200 is a sign it is two; a migration is its own task and blocks what reads the new column; contract before host before views when they depend on each other; every criterion is something an acceptance example can assert — a route's return value or what a page declares — never "looks good"; what only a person can judge goes in `runbook`; a task that ships less than a working path is `stub: true` and names the task that finishes it. |
| When to open an intent | New paragraph at the end of `# How to work` in `ENGINEER_INSTRUCTIONS`, at most eight lines: a request with more than one independently verifiable change, or that you estimate over 200 changed lines, is planned, not started — read the specification, call `intent.open`, then `intent.task` for each part, then `intent.submit`, then stop; a single small change is made directly as before; if the application does not exist yet, create it first, then plan; never call `source.edit`, `source.change` or `candidate.cycle` in a turn that opened or changed an intent. Keep the five headings. The instructions hash changes, so `reviewFlags` will flag lessons for review on next start: expected, say so in the report. |
| Host enforcement of "plan, do not start" | In the turn that called `intent.open` or `intent.task`, `source.edit`, `source.change`, `candidate.build` and `candidate.cycle` refuse with `conflict`: "This turn planned a backlog. The person reviews it first." Keep the set of planning run ids in the intent tools' closure and pass a `planning(runId): boolean` into the existing tools through `EngineerToolsOptions`; clear the id in `onRunEnd`. |
| The hub's context | A new document from `serve.ts`, ref `intent:<appId>`, title "The backlog for <appId>", served on every turn for an application that has an intent in `draft`, `running` or `stopped`, placed after the orientation. At most 1,500 characters: status, open questions, then one line per task — slug, status, tier, title — and for a `failed` task its failure's first line. It is recorded in the context row like every other document. This is how the main model keeps oversight across turns without being asked to remember. |
| Panel | Two small changes to `IntentPanel.tsx`: a draft not yet submitted shows "Being written" beside its status; a draft with open questions shows them first, under the heading "The engineer needs answers", and says to answer in the chat. The chat column gets nothing new. |
| Logging | One knowledge event per accepted call through `options.knowledge.log`, kind `log`, level `info`: `intent 4 opened for notes`, `task 0007-add-tags proposed (deep)`, `intent 4 submitted with 5 tasks`. |
| Not in scope | Running a task; `intent.start`; changing the executor's approvals; the panel's Run button; editing tasks from the panel; an evaluation condition. |

## Step 1 — the tools

`intent-tools.ts`, built with `guardedTool` like the others. Wire
`options.intents` through `tab.ts`.

## Step 2 — the grounding check and the reference topic

A pure function `groundedIn(fits, spec): string[]` returning the names it
found, tested on its own.

## Step 3 — instructions, planning guard, context document

## Step 4 — panel changes and docs

`docs/autoapp/intents.md`: sections **How a request becomes a backlog** and
**What the host checks and what the model decides** (a two-column table).
`docs/autoapp/security.md`: a short section on why drafting is `read`.
`docs/autoapp/backlog.md`: a row "An evaluation condition for planned against
direct", precondition: 13c's demo.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-tools.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-knowledge.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New `tests/autoapp-intent-tools.test.ts`, with the fake adapter scripted to make
the calls and the world built as `makeWorld` builds it:

1. `intent.open` stores the person's typed message as `request`, not `restated`.
2. `fits` naming no route, page or component is refused with the sentence above;
   naming one real route passes; a blank application skips the check.
3. A second `intent.open` for the same application replaces the analysis and
   keeps the tasks; it is refused while an intent is `running` (set the status
   directly through the store).
4. With open questions, `intent.task` and `intent.submit` are refused; after an
   `intent.open` with `questions: []` they pass.
5. `intent.task` with an invalid field returns `ok: false` with the field named
   and stores nothing; the corrected call stores the task with a host-assigned
   slug, tier and example ids; `replaces` rewrites in place and keeps the slug.
6. `intent.submit` names a dangling `blockedBy`, a cycle, and an empty intent.
7. All three tools refuse once the intent is not `draft`.
8. None of the three asks a question: run them on channel `ai` through the real
   gate and assert zero `confirm` events.
9. In a turn that called `intent.open`, `source.edit` is refused with the
   planning sentence; in the next turn it is not.
10. The next turn's delivered documents include `intent:<appId>` with one line
    per task, and the context row records it; an application with no live intent
    gets no such document.
11. `ENGINEER_INSTRUCTIONS` still has the five headings and mentions each of the
    three tool names; the `intents` reference topic mentions every label in
    `LABELS` (so the vocabulary cannot drift from the text).

Then by hand, once, against the configured model and a real application with at
least two routes: type a request with three parts. Record in the report the tool
calls in order, how many `intent.task` calls came back `ok: false` and for which
fields, whether the model stopped after `intent.submit`, the elapsed time, and
the rendered plan of one task.

## Acceptance criteria

- A multi-part request produces a draft intent whose analysis names real parts
  of the application, and tasks in the plan format, visible in the Backlog panel;
  the chat says only that the plan is there.
- An analysis that names nothing in the application is refused with a sentence
  the model can act on.
- Open questions stop decomposition until answered.
- A turn that plans cannot edit.
- The main model sees the backlog's state on every later turn for that
  application.
- Drafting asks the person nothing; nothing here can start work.
- `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/13b-intent-capture.md`, with the by-hand run above.

## Commit

```
Plan before building: the engineer captures an intent and splits it

Three small tools write a draft backlog: an analysis the host checks against
the application's real routes and pages, open questions that hold the split
until answered, and tasks in the plan format whose tier and model the host
assigns. A turn that plans cannot edit, and every later turn is handed the
backlog's state.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
