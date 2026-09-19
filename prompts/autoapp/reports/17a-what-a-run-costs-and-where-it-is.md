# 17a — What a run costs and where it is

## What was built

- **Core, the two files the prompt names.** `run.ts`: `RunDeps.onUsageSoFar`, called
  from the `onStepEnd` already given to `streamText`, through `safely`, with the
  running subtotal `tally` keeps; `TurnTally.modelId`, set from `resolved.modelId`
  and passed on as `RunEndDetail.modelId`. `create-ai.ts`: `CreateAiOptions.onUsageSoFar`
  passed into `runDeps`, and `RunEndDetail.modelId?` (additive, optional). Nothing else
  in `packages/broapp`; `git diff --stat packages/broapp` shows those two files only.
- **Usage.** `intents.sqlite` migration 4: `usage` exactly as the table fixes it, indexed
  on `ended_at` and `task_id`. `intent/usage.ts`: `recordUsage`, `usageRowOf`, `spendOf`,
  `costOf`, `startOfToday`, `usageToday`/`usageOfTask`/`usageOfRun`, `mergeParts`,
  `estimateFor`. `tab.ts` writes one row per turn from `onRunEnd` (task from
  `taskForRun`), holds live subtotals in memory from `onUsageSoFar`, and drops them at
  `onRunEnd`. A failing write is logged, never the turn's failure.
- **Prices.** `intent/prices.ts`: `readPrices`/`writePrices` over `prices.json`, read as
  `intent-models.json` is; `launcher.pricesGet`/`pricesSet` (the set refuses off
  channel `user`).
- **Progress.** `RunProgress` gains `runId`, `stage`, `turn`, `maxTurns`, `maxAttempts`,
  `quietSince`, `idleLimitMs`, `turnLimitMs`, `filesChanged`, `criteria`, `lastRefusal`,
  `tokens`, derived in `progressOf` when read. `stageOf` is the pure stage function.
  The executor remembers run events (`recent()`, at most 20) and writes a usage row for
  the advice question; the distiller reports each question's usage (`onUsage`).
- **The route.** `launcher/overview.ts`: `needsYouOf` (pure), `readOverview`;
  `launcher.overview` in `app.ts` and `contract.ts`.
- **Alerts.** `react/pending.ts`: `announce`, `announceOverview`, `alertsBetween`,
  `requestAlerts`, `ALERT_TONES`, `webAudioSound`; `browserSurface()` is now one surface
  per tab, with `sound`, `attending` and `raised`.
- Docs: `intents.md` "What a run costs, and where it is"; three `backlog.md` rows.
- Tests: `tests/autoapp-overview.test.ts` (28), `tests/ai-history.test.ts` (+3),
  `tests/autoapp-intent-run.test.ts` (+2), `tests/autoapp-knowledge.test.ts` (+1).

## How a turn's model is known at `onRunEnd`

It was not, reliably. The tab learned it only in `onContext`, which it wired only when a
knowledge store was present, and a turn can fail between resolving its model and
`onContext`. So `modelId` was added to `RunEndDetail`, set where `run.ts` resolves the
model. The tab now also always sets `onContext`, to name the model of a live subtotal.

## Turns a person would not think of

All counted: chat and planning turns and builder turns through `onRunEnd`; the **advice**
question (`advice-<taskId>-<ms>`, with its task) and each **distillation** question
(`distil-<caseId>-<ms>`, no task), which call `streamObject` directly and never reach
`onRunEnd`, write their rows from where they end, zeros and partial when the provider
never said. A test holds the advice row and the distiller's report.

## `launcher.overview`, as built — for 17b

```
{
  needsYou: [{ key, kind: 'question'|'answer'|'advice'|'activate', appId, title (≤80), detail (≤400),
               at, expiresAt: number|null,
               target: { panel: 'backlog'|'candidate', appId, intentId|null, taskId|null, releaseId|null } }],  // newest first
  running: null | { taskId, runId, attempt, startedAt, lastTool, lastToolAt, approvals,
                    stage: 'reading'|'editing'|'building'|'checking', turn, maxTurns, maxAttempts,
                    quietSince, idleLimitMs, turnLimitMs, filesChanged: number,
                    criteria: { passed, total }, lastRefusal: { tool, reason } | null,
                    tokens: { input, output },
                    appId, appName, intentId, taskSlug, taskTitle, taskIndex, taskCount, modelId|null },
  spend: { task: Total|null, run: Total|null, today: Total, budgetDay: number|null,
           todayByModel: [{ modelId|null, inputTokens, outputTokens, cost|null, atLeast }] },
  backlog: [{ appId, appName, intentIds, done, failed, running, queued, blocked, total,
              estimate: { ms, tokens, estimate: true } | null }],
  apps: [{ …appsList row, state: 'serving'|'stopped'|'building'|'needs-review',
           checks: { passed, total } | null, changedAt: number|null }],
  recent: [{ key, kind: 'task-completed'|'task-failed'|'turn-limit'|'run-ended'|'provider-error',
             appId, intentId, runId|null, taskSlug|null, text, at }],  // newest first
}
Total = { inputTokens, outputTokens, cost: number|null, atLeast, unpricedTokens }
```

`attempt` is the task's turn count across runs (the number in the run id); "attempt n of
m" is `turn` of `maxAttempts`. `queued` counts proposed, in-queue, interrupted and
needs-answer tasks. `state` is `building` while a run works on the app, `needs-review`
while any `needsYou` item names it. `today.cost` is `0` only when nothing ran today.

## The stage function with a turn that alternates

It folds the events in order, so it follows the turn back and forth: a cycle or build's
start is `building`, a preview or check (called, or asked as a cycle step) `checking`, a
landed edit `editing`; a build that failed, was declined or whose preview did not start
returns to `editing`, or to `reading` if nothing has landed. A refused edit moves nothing.

## Deviations, and decisions I made

1. **`overview` has a sixth field, `recent`,** and `RunProgress` a `runId`. The five
   blocks cannot say a limit ended a turn or the provider failed once `running` is null;
   the alerts are keyed by run id. Nothing listed was left out.
2. **`apps[]` gains `changedAt`** (the mockup's "Last changed"), and `spend` gains
   `todayByModel` (the prices editor's "usage by model"). Additions for 17b.
3. **`announce` is written as `raiseAlert` and exported as `announce`.** 14b's scan holds
   `announce(` to the two files that print a launch address; the name alone collided.
4. **The advice and distillation rows are written where those questions end**, not from
   `onRunEnd`, which never sees them.
5. **Migration 4 is `IF NOT EXISTS`,** for 15b's reason: its test rewinds `user_version`.
6. **The "writes nothing" test leaves out `runs.sqlite`:** the gate records every call,
   reads included; the route writes nothing. `-shm` is left out too.
7. **Backlog rows** for stopping at the budget, cost by day or week, and more than one run
   — the list's first, fifth and last once "any screen (17b)" is set aside as 17b's.
8. **One existing test's fixture** (`autoapp-intent-run`, the panel test's `run`) gained
   the new `RunProgress` fields; no assertion changed. Commit trailer names Claude Opus 5.

## Commands run

```
bun run typecheck                                                   exit 0
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts tests/autoapp-gate.test.ts   126 pass, 0 fail
bun test tests/ai-chat.test.ts tests/ai-history.test.ts             48 pass, 0 fail
bun test tests                                                      1051 pass, 0 fail (55 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 78.0 MB, exit 0
bun run scripts/autoapp-smoke.ts                                    autoapp smoke: every step passed
bun run check                                                       exit 0
git diff --stat packages/broapp tests/ai-chat.test.ts               run.ts, create-ai.ts only
```

Test 12's timing: `launcher.overview` over 1,000 usage rows, best of ten **0.35–0.40 ms**.
No live-model run.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Every turn leaves a row saying what it used, and when that is only what is known | pass (tests 2, 3; advice and distillation rows) |
| A running turn's tokens are known while it runs | pass (core test 4; `tokens` in test 9) |
| No cost for an unpriced model, no floor reported as exact | pass (tests 5, 6) |
| One read answers what needs the person, the run and stage, cost, what is left, the apps | pass (test 12, empty and with a run) |
| Six events reach a person not looking, the needful with a sound; only a click asks | pass (tests 13, 14; the source scan of `request()`) |
| Only `run.ts` and `create-ai.ts` in `packages/broapp`; `ai-chat` unchanged; check green | pass |

**Core moved: the next release publishes `broapp` before `broapp-autoapp`.**
