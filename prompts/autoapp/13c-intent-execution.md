# 13c — Run the backlog: one task, one turn, one model, the host in charge

## Goal

After 13b a person has a reviewed backlog and no way to run it. After this
prompt they say "go ahead" in the chat, or press **Run** in the Backlog panel,
and the tasks are built one after another: each task is one engineer turn on the
model assigned to it, given that task's plan and nothing else to do. The host
moves each task through `in-queue`, `in-progress` and `completed` from evidence —
a verified build whose checks include one passing example per criterion — never
from a model saying it is done. The panel shows it happening.

The shape is hub and spoke, and the hub is two things. The **host executor** is
deterministic code: order, models, timeouts, verdicts, stopping. The **main
model** — the one configured in Settings, the one that made the plan — is asked
at the two places judgement is needed: when a task fails, for a diagnosis and
advice the person reads; and on the person's next chat turn, where the
`intent:<appId>` document (13b) tells it everything that happened. A model is
not put in a loop supervising other models: 08c and 12j measured what this model
does with long open-ended turns.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report; 13a and 13b's reports;
  `docs/autoapp/intents.md`; `docs/autoapp/security.md` in full.
- `packages/broapp/src/ai/host/create-ai.ts`: `Ai.turn`, `InProcessTurn`
  (`modelId`), `InProcessTurnOptions` (`answer`, `signal`, `onEvent`).
- `packages/broapp-autoapp/src/knowledge/harness.ts`: `RUN_APPROVES` and
  `turn(...)` (lines ~224–330) — a timeout, a stand-in answer and event
  bookkeeping around `tab.ai.turn`. The executor is that pattern inside the
  launcher.
- `packages/broapp-autoapp/src/engineer/state.ts`: `CandidateStatus`
  (`checks`, `checksVerified`, `problems`, `editsSinceBuild`), `CycleProgress`.
- `packages/broapp-autoapp/src/knowledge/ids.ts` `sourceRevision`;
  `engineer/workspace.ts` for how every applied change is committed.
- `packages/broapp-autoapp/src/knowledge/distil.ts`: how one structured question
  is put to `ai.model()` and how a failed or malformed answer is handled.
- `packages/broapp/src/host/gate.ts` and `approvals.ts`: what the gate records
  for a question and its answer.
- `packages/broapp-autoapp/src/launcher/{tab,app,contract,main}.ts`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| The common rules still hold | Policy v1 and approval identity are unchanged. The gate still asks for every `write` a spoke turn makes, each question is still bound to its arguments and consumed once, and each answer is still recorded. What is new is who answers: for the length of one run the executor answers as the person's stand-in, exactly as `Ai.turn`'s `answer` was built for and as the replay harness already does. The person authorises that once, by starting the run, after being shown what it covers. |
| The obvious route | `INTENT_APPROVES` in `intent/executor.ts`: `source.edit`, `source.change`, `candidate.cycle`, `candidate.build`, `candidate.preview`, `preview.stop` — and only when the tool's input names the run's own `appId`. These are what building a task is made of; the run answers yes to them itself. A test holds the list and asserts `release.activate` and `apps.create` are not in it. Do not call this a grant: `launcher.grants*` already means capabilities. Call it the **run's standing answer** in code, UI and docs. |
| Anything else goes to the person | A question the list does not cover — another tool that asks, an `external` tool, a listed tool naming a different application — is **not** answered no. It is put in front of the person and the turn waits, exactly as a chat turn's question waits: `run.question = { runId, callId, tool, input, askedAt, expiresAt }` in `launcher.intentGet`, shown at the top of the Backlog panel with **Approve** and **Deny**, the rail's Backlog button marked while one is waiting. The panel answers through the existing `ai.chatConfirm`, so it is the same approval table, the same binding to the arguments, the same single use. If the gate's window (`confirmTimeoutMs`, ten minutes) passes unanswered, the executor aborts the turn, the task becomes `interrupted` without using an attempt, and the intent is `stopped` with "A question waited ten minutes without an answer." A person who was away comes back to a stopped run, not to a task that failed for lack of them. Two exceptions are refused outright and never forwarded, because a builder has no business with them and its message says so: `release.activate` and `apps.create`. Activation stays a person's click on a candidate they have looked at. |
| The one core change | `packages/broapp/src/ai/host/create-ai.ts`: `InProcessTurnOptions.answer` may return `boolean \| 'defer'`. On `'defer'` the turn settles nothing: the question stays in the approval table for somebody else to answer by its request id, and the gate's own window still ends it. Existing callers return a boolean and are unchanged. The executor returns `true` for the obvious route, `false` for the two refused tools, and `'defer'` for everything else, recording the question in `run.question`; the panel's `ai.chatConfirm` is then the only answer, so no approval is ever answered twice. Update the doc comment on `answer`. `tests/ai-chat.test.ts` stays unchanged. |
| A builder that is unsure asks | New tool `intent.ask { question: string 10–300 }`, effect `read`, usable only from a run id starting with `intent-` (refused elsewhere). It records the question on the task, moves it `in-progress → needs-answer`, stops the intent with "<slug> needs an answer", and returns `{ next: 'Stop now. The person will answer and the task will be run again.' }`; the executor ends the turn after the tool returns and does not count the attempt. The panel shows the question on the task with a text box (≤ 1,000 characters) and **Answer**; route `launcher.intentAnswer { taskId, answer, by }`, effect `write`, channel `user`, appends `{ question, answer, at }` to `answers`, clears `question`, and moves the task to `in-queue`. It does not restart the run: the person presses **Run**, or says go ahead. Every later attempt's message carries "The person answered:" and each pair. The builder's message says: "If the plan leaves a real choice open that changes what you build, call intent.ask once with one question rather than guessing. Do not ask about anything the plan or the application already answers." At most two questions per task; a third call is refused: "Decide with what you have." |
| Starting | Tool `intent.start { intentId }`, effect `write`, so the gate asks; its description says what the person is agreeing to: "Start building this backlog. Until it finishes or is stopped, edits, builds and previews for <appId> are approved without asking. Anything else is put to you in the Backlog panel and waits. Activation is never approved this way." Route `launcher.intentRun { id }`, effect `write`, channel `user`, behind an inline confirmation in the panel with the same sentence. Both call one function, `executor.start(intentId, startedBy)`. It requires: status `draft` with `submitted_at` set and no open questions, or `stopped`; no task in `needs-answer`; at least one task `proposed`, `in-queue`, `failed` or `interrupted`; no other run active in this launcher; AI set up. Otherwise `conflict` or `unavailable` with a sentence. It moves `proposed`, `failed` and `interrupted` tasks to `in-queue`, sets the intent `running`, returns at once `{ started: true, tasks: n }`, and the work continues in the host. The tool's `next`: "Tell the person it has started and that progress is in the Backlog panel. Do nothing else this turn." |
| Per application | An intent, its tasks, its run and its panel view belong to one application. `busy`, the standing answer and the verdict are all keyed by that `appId`. |
| Who stamps a task | 13a's `moveTask` changes status and history only (report 13a, open question). Extend it, in the same transaction: `→in-progress` sets `started_at`, clears `ended_at`, adds one to `attempts` and appends the run id it is given to `run_ids`; `→completed` and `→failed` set `ended_at`; `→interrupted` and `→needs-answer` set `ended_at` and take the attempt back (`attempts - 1`), because neither was the builder's failure. The executor never writes those columns itself. |
| One at a time | One run per launcher, one task at a time, in `store.runOrder`. An application has one source workspace, one candidate and one preview, and a local model has one GPU. `locks` is validated and shown and does not schedule anything yet. |
| A spoke turn | `ai.turn({ runId: 'intent-<intentId>-<slug>-a<attempt>', message, modelId? }, { answer, signal, onEvent })`, no history. `modelId` is `modelFor(task, mapping)`; omitted when `null`. Before the turn, check the id is still in the provider's list (`adapter.models` through the registry, as `ai.modelsList` does); if the list cannot be fetched, proceed; if it can and the id is absent, the task fails without a turn: "The model <id> is no longer offered by <provider>." |
| The spoke's message | First line `Application: <appId>` (that is how `serve.ts` resolves the turn's application — assert it in a test through the context row). Then: "Build this one task and nothing else. Add one acceptance example to autoapp.json for each criterion, with exactly these ids: <ids>. Use candidate.cycle until every check passes, then stop. Do not request activation. Do not plan or change the backlog." Then the rendered plan. On a second attempt, append "The last attempt ended with:" and the verdict's reasons. The three `intent.*` drafting tools and `intent.start` refuse any run id starting with `intent-`. |
| Limits | `TASK_TURN_TIMEOUT_MS = 20 * 60_000` (the harness's figure), `TASK_MAX_ATTEMPTS = 2`. Both exported constants, both overridable through the executor's options for tests. |
| The verdict | After the turn ends, however it ended, `verdictOf(task, states.status(appId), revBefore, revNow)` decides. `completed` needs all of: the workspace revision changed; `problems` empty; `editsSinceBuild` false; `checksVerified` true; every check passed (no regression in earlier tasks' examples); for each criterion, a check whose `id` is `<slug>-c<n>` exists. Otherwise the reasons are listed in plain sentences ("No example named 0007-add-tags-c2 was run.", "The build has 2 problems.", "The turn ran out of time."). The model's closing text is never evidence. On `completed`: `rev_after`, `release_id`, `actual_lines` (from `git diff --shortstat rev_before rev_after`, insertions plus deletions, `null` without git), then `moveTask`. |
| Failure policy | `stop`, as workflows have it and for the same reason. After the second failed attempt the task is `failed` with `failure = { reasons, runIds, at }`, the intent is `stopped` with `stop_reason`, and later tasks stay `in-queue`. The workspace is left as the attempt left it, so the person and the engineer can look; nothing is reset. "Revert and continue with independent tasks" goes to `docs/autoapp/backlog.md`. |
| The main model's advice | (Advice `ask` means the main model thinks the person has to decide something; the panel then shows the note beside a text box that uses `launcher.intentAnswer`, which for a `failed` task records the pair and leaves the status alone.) After a task fails, one structured question to `ai.model()` (no override: the Settings model), patterned on `distil.ts`: given the plan, the reasons and the last cycle's failures, answer `{ diagnosis: string ≤ 400, advice: 'retry' \| 'revise' \| 'split' \| 'ask', note: string ≤ 400 }`. Stored as the task's `advice` and shown in the panel under the failure. A call that fails or does not parse stores nothing and logs one line; it never changes a status. The model advises; the person decides. |
| After a stop | `launcher.intentRun` again resumes: `failed` and `interrupted` go back to `in-queue` and the run continues from the first unfinished task. In the chat the person can instead ask the engineer to revise the task: 13b's tools accept `replaces` only for a `proposed` task, so extend `replaceTask` to `failed` tasks of a `stopped` intent, returning them to `proposed`; `executor.start` accepts a `stopped` intent whose live tasks are all valid under `validateGraph`. |
| Stopping | `launcher.intentStop { id }`, effect `write`, channel `user`: aborts the current turn's signal, the task becomes `interrupted`, the intent `stopped` with reason "Stopped by <by>". The preview is left as it is. |
| While a run is active | For that application, engineer tools that write (`source.edit`, `source.change`, `candidate.build`, `candidate.preview`, `candidate.cycle`, `preview.stop`, `release.activate`) called from a run id that does not start with `intent-<thatIntentId>-` refuse with `conflict`: "A backlog run is working on <appId>. Stop it from the Backlog panel first." `launcher.activate` for that application refuses the same way. One `busy(appId, runId): string \| null` function from the executor, passed through `EngineerToolsOptions` and `LauncherAppOptions`. Reads, and other applications, are untouched, so the person can keep talking to the engineer. |
| Restart | A run does not survive the launcher. On `openIntents`, any `in-progress` task becomes `interrupted` and any `running` intent becomes `stopped` with reason "The launcher stopped." Nothing resumes by itself: an interrupted turn may have left half a change, and the rule for unknown outcomes is that a person decides. `CycleProgress` is already durable, so the resumed task's orientation says where the last cycle got to. |
| Finishing | When every live task is `completed` the intent is `done`. Nothing is activated. The panel says: "All tasks are built and checked in the candidate. Open the preview, look, then activate from the Candidate panel." Tasks with a `runbook` list it there under "For you to check by hand". |
| Progress | `launcher.intentGet` gains `run: { taskId, attempt, startedAt, lastTool, lastToolAt, approvals } \| null`, kept in memory by the executor from `onEvent`. The panel polls `launcher.intentGet` every two seconds while the open intent is `running` (and for the two reasons in Step 0.2), and stops when none holds or the panel closes. The launcher contract has no stream today and this prompt does not add the first one. Rendered `- [x]` for a criterion whose example passed in the verdict. A task row shows estimated against actual lines once completed. |
| Panel | **Run** (draft and submitted, or stopped), **Stop** (running), both with inline confirmation; per failed task the reasons, the advice, and the sentence "Run again to retry, or ask the engineer to revise this task." |
| Records | Every spoke turn is an ordinary turn: events, contexts, servings, cases, lessons, the run store — all as today, under its `intent-…` run id. Add one knowledge event per task move and per run start, stop and finish, kind `log`. The gate's record of each stand-in answer must show it was the run's standing answer and which intent: read how `approvals.ts` records an answer and use the field it already has for who answered; if there is none, put it in the knowledge event and say so in the report rather than changing the gate. |
| Instructions | Add to the paragraph 13b wrote, two lines: when the person says to go ahead with a reviewed backlog, call `intent.start`; after a stop, read the backlog document, and either explain the advice or revise the failed task with `intent.task` and `replaces`. |
| Not in scope | Desktop notification of a waiting question (the rail mark is the signal); parallel tasks; models from a second provider; automatic activation; reverting a failed task; a model-driven supervisor loop; a stream route; an evaluation condition. |

## Step 0 — four corrections from the review of 13b, before anything else

Small, each with its test, listed in your report under their own heading.

1. **`blockedBy` and `repaidBy` accept a task's words as well as its whole slug.**
   The host assigns slug numbers, so a model adding tasks in one pass cannot know
   them; in 13b's by-hand run a hosted model named `author-column`, was refused
   three times at submit and spent three `replaces` calls repairing it. A
   reference is resolved among the intent's live tasks: a whole slug matches
   itself; anything else matches the task whose slug without its number equals
   it. Resolution happens when the referenced task exists — at add time if it
   already does, otherwise at submit — and the stored value is always the whole
   slug. No match, or two matches, is a problem naming the reference and, for
   two, both slugs. The tool description says either form is accepted.
2. **The panel notices a backlog being written.** The list loads once, so a
   person who opens the Backlog panel while the engineer is planning sees
   nothing until Refresh (13b's report put this down to queueing; the code says
   the draft simply did not exist yet when the list was read). `IntentPanel`
   takes `turnActive: boolean` from `App.tsx` (the chat already knows when a
   turn is streaming) and re-reads the list, and the open intent, every two
   seconds while it is true or while the open intent is an unsubmitted draft;
   once more when it turns false. This is the same timer the running state uses
   below: one polling hook, three reasons.
3. **A read route answers while a turn is running.** Add a test that holds a
   fake-adapter turn open on a tool call and asserts `launcher.intentGet`
   answers meanwhile. Progress polling depends on it; if it does not hold, stop
   and report, because the progress design is then wrong.
4. **The split rules say what a criterion may be.** 13b's sample plan carried
   "the filter is the SQL WHERE clause, never a slice taken after the fact",
   which no acceptance example can assert. Add one sentence to `SPLIT_RULES`
   (and so to the `intents` topic and the `intent.task` description): a
   criterion says what a route returns or what a page declares, never how the
   code is written; how it is written goes in `testNotes`. No host check: it is
   not checkable. Put a row in `docs/autoapp/backlog.md` linking this to the
   existing "Fail-before, pass-after" row: a run's verdict is only as strong as
   the examples the builder wrote, and that row is what would strengthen it.

The instructions test caps `ENGINEER_INSTRUCTIONS` at 70 lines and 13b met it by
deleting blank lines around headings. Do not squeeze further: fold this prompt's
two sentences into 13b's paragraph, and if that still does not fit, raise the
cap by exactly the lines you add and say so in the report.

## Step 1 — `intent/executor.ts`

`createExecutor({ intents, ai: () => Ai, states, layout, mapping, log, logger,
turnTimeoutMs?, maxAttempts? })` → `{ start, stop, busy, active(), idle() }`.
`ai` is a function because the executor is built before `createAi` returns, as
the distiller is. `idle()` resolves when no run is active; tests await it. The
loop catches everything: an exception inside it stops the intent with a sentence
and never takes the launcher down. The launcher's shutdown calls `stop` and
awaits `idle()` with the same deadline it gives a child.

## Step 2 — `verdictOf` and the advice question

Pure function first, with its own tests, then the model call.

## Step 3 — `intent.start`, the routes, `busy`, restart recovery

## Step 4 — panel

## Step 5 — docs

`docs/autoapp/intents.md`: **How a backlog runs** — the loop as a numbered list,
the verdict's conditions, the failure policy, what a restart does, and a hub and
spoke diagram. Any diagram goes through the `diagram-design` skill per
`~/.agents/DIAGRAM-STANDARD.md`; if that skill is not available in your session,
write the section without a diagram and say so in the report. `security.md`:
**A run answers for the person** — what it approves itself, what it brings to
the person, what a builder can never do, that every answer is still asked and
recorded, that the code it builds is trusted local
code as always. `README.md` of the package: two sentences.
`docs/autoapp/backlog.md`: rows for parallel tasks, a second provider, revert
and continue, a stream for progress, an evaluation of planned against direct.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-tools.test.ts tests/autoapp-intent-run.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-knowledge.test.ts tests/autoapp-gate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New `tests/autoapp-intent-run.test.ts`. The fake adapter scripts each spoke
turn; short timeouts through the executor's options; every test awaits `idle()`
and cleans up children in `afterEach`:

1. `verdictOf`: one case per condition, each with its sentence; all conditions
   met is `completed`.
2. Two tasks, the second blocked by the first, both scripted to add their
   examples and pass: statuses move `in-queue → in-progress → completed` in
   order, `task_events` has the rows, the intent ends `done`, and nothing was
   activated (`current` unchanged).
3. Each spoke turn's context row names the right `appId`, and its run id has the
   `intent-` shape; the task's `modelId` reached the adapter (the fake records
   the model it was asked for); a `null` mapping sends none.
4. The stand-in answers yes to `candidate.cycle` for the run's application;
   refuses `release.activate` and `apps.create` outright; and for `source.edit`
   naming another application puts the question in `run.question`, where an
   `ai.chatConfirm` yes lets the call through and a no refuses it. Each question
   appears in the gate's record exactly once.
4b. A forwarded question left past a short `confirmTimeoutMs` aborts the turn:
   task `interrupted`, `attempts` unchanged, intent `stopped` with the sentence.
4c. `intent.ask` from a builder's run: task `needs-answer` with the question,
   intent `stopped`, attempt not counted; `executor.start` refuses while it
   waits; `launcher.intentAnswer` stores the pair and returns the task to
   `in-queue`; the next attempt's message carries the answer; a third
   `intent.ask` on one task is refused; from an ordinary chat run it is refused.
4d. In `tests/ai-host.test.ts`: `Ai.turn` with an `answer` returning `'defer'`
   leaves the tool waiting until `ai.chatConfirm` answers its request id, then
   runs it on yes and refuses it on no.
5. A turn that ends saying "done" without a passing example for `c2` is not
   completed; the second attempt's message carries the reason; after it the task
   is `failed`, the intent `stopped`, the next task still `in-queue`.
6. The advice question's answer is stored and returned by `launcher.intentGet`;
   a malformed answer stores nothing and changes no status.
7. A model id missing from the provider's list fails the task without a turn.
8. While running, `source.edit` from an ordinary chat run for that application
   is refused with the sentence; `source.read` is not; another application is
   not; `launcher.activate` is.
9. `launcher.intentStop` mid-turn: task `interrupted`, intent `stopped`;
   `launcher.intentRun` resumes from that task.
10. Reopening the store with an `in-progress` task and a `running` intent yields
    `interrupted` and `stopped` with the restart reason, and no run starts.
11. `intent.start` on channel `ai` produces one `confirm` event and starts only
    after a yes; from a run id beginning `intent-` it is refused.
12. `executor.start` refuses a draft that was never submitted, one with open
    questions, and a second run while one is active.
13. `IntentPanel` markup: a running intent shows the active task's last tool; a
    failed task shows reasons and advice; a done intent shows the closing
    sentence and the runbook lines.

Then by hand, once: the three-part request from 13b's report, reviewed, one
task's model changed in the panel, "go ahead" typed in the chat. Record per
task: model, attempts, minutes, tool calls, verdict, estimated and actual lines;
whether the run finished; what the advice said if it stopped. Put the table
beside 08c's and 12d's numbers for a single long turn. Do not start this while a
`knowledge evaluate` is running on the machine.

## Acceptance criteria

- "Go ahead" in the chat or **Run** in the panel starts the backlog after one
  question that says what is being approved; nothing starts without it.
- Each task runs as its own turn on its assigned model, in dependency order, and
  its status in the panel moves `in-queue`, `in-progress`, `completed`.
- A task is completed only when a verified build's checks include a passing
  example for every criterion and nothing else regressed.
- A task that fails twice stops the run, leaves the workspace as it is, and
  shows the reasons and the main model's advice.
- A run answers for itself only on edits, builds and previews of its own
  application. Any other question reaches the person in the panel and waits; an
  unanswered one stops the run without costing the task an attempt. Activation
  and creating applications are never available to a builder. Every question is
  still asked and recorded once.
- A builder that meets a real open choice asks one question; the task waits as
  `needs-answer`, and the answer is in front of the next attempt.
- A person can stop a run, resume it, and keep reading and chatting meanwhile;
  other writes to that application are refused while it runs.
- A restart interrupts, and never resumes on its own.
- `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/13c-intent-execution.md`, with the by-hand table, how a
stand-in answer appears in the gate's record, and anything in the common rules'
decisions table you believe this prompt strains.

## Commit

```
Run the backlog: one task, one turn, one model, the host in charge

Saying go ahead starts a run that builds each task as its own engineer turn
on its assigned model, answers the gate's questions for edits, builds and
previews of that one application and for nothing else, and marks a task
completed only when a verified build passes an example for every criterion.
Two failed attempts stop the run with reasons and the main model's advice.
Nothing is activated; a restart interrupts and never resumes by itself.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
