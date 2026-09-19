# 17a — What a run costs and where it is

## Goal

A person who presses **Run** on a backlog is told one thing while it works: that
it is working. Three things they need to decide anything are not there.

**Where the task is.** `RunProgress` in `intent/executor.ts` holds the task, the
attempt, when it started, the last tool and when, and the approvals. It does not
say which stage that is, how long the turn has been quiet against the limit that
will end it, how many of the task's criteria pass, or what was last refused —
all of which the executor already knows.

**What it has cost.** Every turn ends with `onRunEnd(runId, status, summary,
detail)`, and since 15d `detail.usage` is there even for a turn that was cut
short, marked partial. `tab.ts` receives it (line ~397) and nothing keeps it:
no store has a column for tokens. There is no price anywhere, so no cost either.

**When to come back.** `react/pending.ts` renames the tab and raises a
notification for one event, a question waiting. A task that failed, a run that
finished and a turn the provider killed are silent.

This prompt builds the data and one route that serves it. It draws nothing:
17b is the screen. After it, `launcher.overview` answers, in one call, what
needs the person, what is running and at what stage, what it has cost, what is
left, and what each application is doing.

Run this after 16a (a preview that says why) is merged: both add to
`launcher/contract.ts` and `launcher/app.ts`, and 16a changes what
`CandidatePanel` and `IntentPanel` show, which 17b links to.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13a (the intent store and the
  panel's routes), 13c (the executor, `RunProgress`, the standing answer), 13d
  (limits), 16a (a preview's start failure is now a sentence a person can read:
  a candidate that built and does not load is **not** "ready to activate"), 14a (`task_runs`: a backlog turn found by its run id), 14c
  (`RefusalGroup`, how an ending is said), 15d (partial usage, what `complete`
  means), 15f (`stuck`).
- `packages/broapp-autoapp/src/intent/executor.ts`: `RunProgress`, `RunQuestion`,
  `progress()`, `followerFor`, `idleClock`, `TASK_IDLE_TIMEOUT_MS`, the turn
  limit, `maxAttempts`, the turns cap, `verdictOf`'s `passed`, `refusedIn`.
- `packages/broapp-autoapp/src/intent/store.ts`: `MIGRATIONS` and how one is
  appended, `task_runs`, `TaskRecord`, `actualLines`, how a task's failure and
  advice are stored.
- `packages/broapp-autoapp/src/launcher/tab.ts`: where `onRunEnd` is wired, what
  else hangs on it, how a chat turn and a backlog turn differ there, and how the
  model a turn ran on is known at that point.
- `packages/broapp/src/ai/host/run.ts`: `tally`, `partialUsage`, `RunEndDetail`,
  `end`, `safely`, and the `onStepEnd` callback already given to `streamText`
  (the SDK's, not ours: the new hook below has another name so the two are never
  confused). `create-ai.ts`: `onRunEnd`,
  `onContext` and how an optional hook is passed down. This prompt names these
  two files: they may change, by the one hook below and nothing else.
- `packages/broapp-autoapp/src/intent/models.ts` and
  `knowledge/task-context.ts`: how a settings file in the launcher's data
  directory is read — missing or unreadable means the default, re-read when used.
- `packages/broapp-autoapp/src/launcher/contract.ts` and `app.ts`: how a
  `launcher.*` route is declared and served; `launcher.intentRunning`,
  `launcher.candidateStatus`, `launcher.appsList` — what each already returns.
- `packages/broapp-autoapp/src/react/pending.ts` in full, above all the comment
  on `requestPermission()`.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. Usage is kept | A `usage` table in `intents.sqlite`, by a new entry appended to `MIGRATIONS`: `run_id TEXT PRIMARY KEY, app_id TEXT, task_id INTEGER, model_id TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, partial INTEGER NOT NULL, steps INTEGER NOT NULL, ms INTEGER NOT NULL, ended_at INTEGER NOT NULL`, indexed on `ended_at` and on `task_id`. One row per turn, written from `onRunEnd`, for **every** turn the tab runs — chat, planning, builder, advice — so "today" is everything the launcher spent. `task_id` comes from `task_runs` by run id; a chat turn has none. A turn with no usage at all writes a row with zeros and `partial = 1`: it happened and its cost is unknown, which is not the same as free. A write that fails is logged and never fails a turn. |
| The model | The row carries the model the turn ran on. If that is not known where `onRunEnd` is handled, add `modelId` to `RunEndDetail` in core (additive, optional) rather than guessing it from settings. |
| 2. A running turn's usage | One new optional core hook, `onUsageSoFar?: (runId: string, soFar: { inputTokens: number; outputTokens: number }) => void`, in `RunDeps` and the `Ai` options, called after each completed step with the running subtotal `tally` already keeps, through `safely`. The launcher holds the latest subtotal per live run id in memory, not in the table; `onRunEnd` replaces it with the row. No other core change. `tests/ai-chat.test.ts` stays unchanged: a turn that sets no hook emits exactly what it emits today. |
| 3. Prices are the person's | `prices.json` in the launcher's data directory, read as `intent-models.json` is: `{ "<modelId>": { "input": <USD per million tokens>, "output": <USD per million tokens> }, "budget": { "day": <USD> } }`. Missing file, unreadable file, a model not in it: **no cost for that model, tokens only**. Nothing ships with a price in it and nothing fetches one: a price that is wrong is worse than none, and a local model has none. `budget.day` is shown and never enforced. A `launcher.pricesGet` / `launcher.pricesSet` pair as `intentModelsGet/Set` are, validated: non-negative finite numbers, at most 200 models. |
| Cost arithmetic | Cost is computed when read, from the row and today's prices, so correcting a price corrects history. A total that includes a partial row or a live subtotal is a **floor** and is returned as such (`atLeast: true`); a total that includes a model with no price says how many tokens it left out (`unpricedTokens`). Never a number that looks exact and is not. |
| "Today" | From local midnight of the machine the launcher runs on, by `ended_at`. |
| 4. The stage | `RunProgress` gains `stage: 'reading' \| 'editing' \| 'building' \| 'checking'`, derived in one pure exported function from the turn's tool events: `reading` until the first edit lands (`source.edit`, `source.change`, or a cycle's patch step); `editing` after it; `building` from a cycle's or `candidate.build`'s start; `checking` from a preview or check step. It moves forward and back as the turn does: a failed build followed by an edit is `editing` again. A turn that has called nothing is `reading`. |
| What else `RunProgress` gains | `turn` and `maxTurns`, `maxAttempts`; `quietSince` (the last tool call or result) with `idleLimitMs`; `turnLimitMs`; `filesChanged` (distinct paths edited this task, from what 14a records); `criteria: { passed, total }` from the last verdict or the last check of this task, zero before one; `lastRefusal: { tool, reason } \| null`, the newest `RefusalGroup`, reason cut at 160; `tokens: { input, output }`, the live subtotal. All derived from what the executor holds; no new timer. |
| 5. What needs the person | One list, newest first, from four sources and no others: a `RunQuestion` waiting (with its expiry); a task in `needs-answer`; a task failed with advice stored; a candidate whose checks all passed and is not the serving release. Each item: `kind`, `appId`, a title of at most 80 characters, a detail line, and `target` — which panel and which record opens it. Built by one pure function over the store, the executor and the candidate states, so it can be tested without a launcher. |
| 6. What is left | Per application with an open intent: tasks `done`, `failed`, `running`, `queued`, `blocked`. An estimate of what remains — milliseconds and tokens — is the mean of **this application's completed tasks'** actuals from `usage`, times the tasks left; `null` until two have completed, and `null` whenever any of them is partial. Marked `estimate: true`. No estimate across applications and none from `estimatedLines`. |
| 7. The route | `launcher.overview`, effect `read`, no input: `{ needsYou[], running: RunProgress & { appId, appName, taskSlug, taskTitle, taskIndex, taskCount, modelId } \| null, spend: { task, run, today, budgetDay }, backlog[], apps[] }` where each spend entry is `{ inputTokens, outputTokens, cost: number \| null, atLeast, unpricedTokens }` and `apps[]` is what `appsList` gives plus `state: 'serving' \| 'stopped' \| 'building' \| 'needs-review'` and the candidate's check count. One call, assembled from the stores; it starts nothing and writes nothing. Held under 50 ms on a store with 1,000 usage rows, by a test. |
| 8. Alerts | `pending.ts` gains `announce(surface, event)` beside `announcePending`, for five more events: a task completed, a task failed (its advice is ready), a turn ended by a limit (`stuck`, idle, out of time), the run finished or stopped, a provider error. Each raised once, keyed by run id and kind, remembered for the tab's life. The rule already there holds for all six: **never** `requestPermission()` from code that was not a person's click. Add `requestAlerts(surface)`, to be called only from a button, which asks once and reports the answer; 17b places the button. The title badge counts `needsYou`, not only questions. **Sound, for the events that need the person**: a question waiting, a task failed, a provider error, and the run finished or stopped — not a task completed and not a turn ended by a limit, which a retry follows. `PendingSurface` gains an injected `sound?: { enabled: boolean; play(kind: 'attention' \| 'done'): void }`; the real one is the Web Audio API, two short generated tones (rising for `attention`, one soft note for `done`), under 400 ms, gain ramped so it never clicks — **no audio file, no asset, no network**. It plays once per event with the notification, only when `enabled`, and only when the document is hidden or does not have focus: somebody looking at the tab is not beeped at. A browser that will not start audio (no gesture yet, no `AudioContext`) is silent without an error; `requestAlerts`'s click is the gesture that unlocks it. 17b places the switch. The events come from `launcher.overview`'s fields changing between two reads, compared in one pure function: no new socket, no server push. |
| Not in scope | Any screen (17b); stopping a run at the budget; a price list that ships or updates itself; per-tool or per-step token tables; charts; cost by day or week; OS-level or phone notifications; a choice of sounds, a volume control or an audio file; more than one run at a time. A row each in `docs/autoapp/backlog.md` for the first, the fifth and the last, with what would justify it. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts tests/autoapp-gate.test.ts
bun test tests/ai-chat.test.ts tests/ai-history.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

The launcher's routes are tested in `autoapp-intent.test.ts` and
`autoapp-intent-run.test.ts`, and `announcePending` in `autoapp-gate.test.ts`;
put the new tests beside them, or in a new `tests/autoapp-overview.test.ts`
where they belong to neither. New tests:

1. The migration: a store written before it opens; `usage` exists and is empty.
2. A finished turn writes one row with its totals and `partial = 0`; a turn cut
   short writes its subtotal with `partial = 1`; a turn with no usage writes
   zeros with `partial = 1`; a chat turn has a null `task_id`; a builder turn
   has its task's.
3. A failing write is logged and the turn's result is unchanged.
4. Core: a turn with `onUsageSoFar` set is called once per completed step with a
   growing subtotal that equals the final usage; a hook that throws does not
   fail the turn; a turn without the hook emits byte for byte what it did.
5. `prices.json`: missing, unreadable and malformed each mean no cost; a priced
   model gives `tokens × price / 1e6`; changing the file changes history's cost;
   `pricesSet` refuses a negative, a `NaN` and a 201st model.
6. Spend: a total with a partial row is `atLeast`; a total with an unpriced
   model reports `unpricedTokens` and a cost that covers only the rest; a total
   with nothing priced has `cost: null`, never `0`.
7. "Today" excludes a row from 23:59 yesterday and includes 00:00 today.
8. The stage function: read, read → `reading`; then an edit → `editing`; a cycle
   → `building`, then `checking`; a failed build then an edit → `editing`;
   nothing called → `reading`. A refused edit does not leave `reading`.
9. `RunProgress` through the executor with the scripted builder: `quietSince`
   moves on a tool result, `criteria` follows the check, `lastRefusal` is the
   newest group, `tokens` follows `onUsageSoFar`.
10. `needsYou`: each of the four sources alone and together, newest first; an
    answered question leaves it; a candidate that is already serving is not in
    it; nothing else ever is.
11. The estimate is `null` with one completed task, a number with two, and
    `null` again when one of them is partial.
12. `launcher.overview` on an empty root returns empty lists and `running:
    null`; on a root with a run going it returns all five blocks; it writes
    nothing (the stores' modification times do not move); 1,000 rows under 50 ms.
13. Alerts: each of the six events is raised once across three identical reads;
    none is raised when permission is not `granted`; `requestAlerts` is the only
    path that asks; the badge counts `needsYou`.
14. Sound: `attention` plays for a question, a failed task and a provider
    error, `done` for the run finishing, nothing for a completed task or a
    limit-ended turn; once per event; never when `enabled` is false; never when
    the document is visible and focused; a `play` that throws is swallowed; and
    sound plays when notification permission is `denied`, because they are
    separate.

New tests must survive Windows and a slow runner: close every store and
`tab.ai` a test opens, never read `HOME`, no fake limit so tight a slow machine
trips it, and the 50 ms bound measured over ten reads with the best taken.

## Acceptance criteria

- Every turn the launcher runs leaves a row that says what it used, and says so
  when that is only what is known.
- A running turn's tokens are known while it runs.
- No cost is ever shown for a model the person has not priced, and no total
  that is a floor is reported as exact.
- One read answers what needs the person, what is running and at what stage,
  what it cost, what is left and what each application is doing.
- Six events can reach a person who is not looking at the tab, the ones that
  need them with a sound, and nothing asks for permission except their click.
- The only files changed in `packages/broapp` are `src/ai/host/run.ts` and
  `src/ai/host/create-ai.ts` (and the shared type that declares the hook or
  `modelId`, if one must); `tests/ai-chat.test.ts` unchanged; `bun run check`
  green.

## Report

`prompts/autoapp/reports/17a-what-a-run-costs-and-where-it-is.md`: how a turn's
model is known at `onRunEnd` and whether `modelId` had to be added; which turns
the launcher runs that a person would not think of (advice, distillation) and
that they are counted; the exact shape of `launcher.overview` as built, for 17b
to read; what the stage function does with a turn that alternates; the timing of
test 12; and that core moved, so the next release publishes `broapp` before the
launcher.

## Commit

```
Keep what a turn used, and say where a run is

Nothing kept a turn's tokens and nothing had a price, so a person could
not know what a run had cost; the panel knew a task was running and not
which stage, how close its limits were or what it was last refused. Every
turn now leaves a usage row, partial when it was cut short; a running
turn reports its subtotal as each step ends; prices are a file the person
writes and a model without one has no cost. launcher.overview serves what
needs the person, the run and its stage, spend, what is left and the
applications in one read, and five more events can raise a notification, the ones that
need the person with a short generated sound.
```

End the commit with the co-author trailer your session's rules give you.
