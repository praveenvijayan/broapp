# 13d — Fix-ups to the backlog run

## What was built

All four in `intent/executor.ts`; nothing else in the run changed.

1. **Earlier tasks' examples.** `verdictOf(task, status, revBefore, revNow, ending, required = [])`:
   one reason per id of `required` not among the checks, "The example 0004-author-column-c2, from a
   finished task, is gone." `runTask` passes `finishedExamples(appId)` — every `<slug>-c<n>` of every
   `completed` task of the application, read from the store (`list({ appId })` then `runOrder`).
   `builderMessage` gains "Do not remove or rename an acceptance example that is already there."
2. **"The workspace did not change" is judged against the task.** `runTask` passes
   `task.revBefore ?? revBefore`, as `changedLines` does, with a comment saying why.
3. **Progress earns a turn.** `TASK_MAX_TURNS = 4`, exported, `maxTurns` in the executor's options and
   in the tab's `run` options. The first attempt always counts; after that, an attempt that does not
   complete and passed strictly more criteria than the best earlier attempt of this run is not counted
   against `maxAttempts`. The run stops at `maxAttempts` counted attempts or `maxTurns` turns, whichever
   comes first. The requeue note reads "another attempt: it got further (2 of 3)".
4. **The idle limit.** `TASK_IDLE_TIMEOUT_MS = 8 * 60_000`, `idleTimeoutMs` in both options.
   `idleClock` restarts on every `tool-call` and `tool-result` and holds while a call is in flight or a
   forwarded question waits. When it fires, the turn's controller is aborted and the verdict's ending
   gains `idleMs`, which `idleSentence` turns into "The turn made no tool call for 8 minutes."
   (seconds below a minute). The twenty-minute limit stays.

Exported from `broapp-autoapp/intent`: `TASK_MAX_TURNS`, `TASK_IDLE_TIMEOUT_MS`, `idleSentence`.
Docs: `intents.md` (the builder's message, steps 6 and 7, the completed rule, the failure policy);
`backlog.md`'s no-progress row gains the sentence pointing at the run, and stays deferred.

## Deviations, and decisions I made

1. **The idle clock also holds while a tool runs.** The prompt names only a waiting question. A
   `candidate.cycle` builds, previews and checks in one call; counting that as the model's silence could
   end a turn in the middle of its own build on a slow machine. The clock measures what 13c's by-hand
   run showed: the model holding the turn with no call. It restarts at each result, not only each call.
2. **`required` is the sixth parameter, defaulting to `[]`,** so `verdictOf.length` stays 4 and the
   existing test that pins it holds. The executor always passes it.
3. **"Best earlier attempt" starts undefined.** With the first attempt free, "1, then 1" would run three
   times, against the prompt's own case; so the first attempt of a run always counts.
4. **The stop reason still counts turns** ("failed after 4 attempts"): every turn was an attempt; only
   the count against the limit changed.
5. Commit trailer names Claude Opus 5, per this session's attribution rule.

## Tests

Seven new in `tests/autoapp-intent-run.test.ts` (33 in the file): `verdictOf` with a missing and a
present `required` id; the idle sentence; the prompt's 2, 3, 4 (three tests: 0/2/3 completes, 1/1
stops after two, four turns is the ceiling with 0/1/2/3 of 5), and 5 (silent past 400 ms is ended with
`idleSentence(400)`; a question answered after 1.2 s against a 400 ms limit is not). Each fix was
reverted in turn and its test failed: `revBefore` (test 3), `required` (test 2), the uncounted
attempt (test 4), the paused clock (test 5b). `world()` gained `maxTurns`, `idleTimeoutMs` and the fake's
`chunkDelayMs`.

## Commands run

```
bun run typecheck                                        exit 0
bun test tests/autoapp-intent-run.test.ts                33 pass, 0 fail
bun install && bun run check                             exit 0, 880 pass, 0 fail (52 files)
bun run --cwd packages/broapp-autoapp build:launcher     dist/broapp-autoapp 77.4 MB
git diff --stat tests/ai-chat.test.ts                    (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| A task cannot complete by removing a finished task's example | pass (verdict test; test 2) |
| A second attempt that only builds what the first edited can complete | pass (test 3) |
| An attempt that got further than any before it is followed by another without a person, up to four turns | pass (test 4, three cases) |
| A turn silent for eight minutes ends with a sentence saying so | pass (test 5, at 400 ms; the sentence for 8 minutes is asserted) |
| `tests/ai-chat.test.ts` unchanged; `bun run check` green | pass |

## The by-hand run

Compiled launcher from this commit's tree, over the real root, 2026-09-18. The 13c launcher (pid
54153, the old binary) was still serving that root; I stopped it with SIGTERM and started the new one
with `open --no-open`, which printed `restored: reading-list`. In the panel: select Reading list,
Backlog, intent 1 (`stopped`, "1 completed · 1 interrupted · 2 blocked"), **Run**, confirm. The run
began at 12:51:22 on the Settings model, OpenRouter `z-ai/glm-5.3`.

| task | model | turn | started | ended | tool calls | verdict |
|---|---|---|---|---|---|---|
| 0001-author-field | glm-5.3 | a4 | 12:51:22 | 12:52:24 | 0 | not completed: checks not on the running preview; `…-c6` failed |
| | | a5 | 12:52:24 | 12:52:25 | 0 | same; run stopped, "0001-author-field failed after 2 attempts." |
| 0002-unread-page | glm-5.3 | – | – | – | – | not reached |
| 0003-author-counts | deepseek-v4-flash | – | – | – | – | not reached |

**Why it stopped: the OpenRouter key is out of credit.** Both turns, and the advice question, failed
at the provider: "This request requires more credits, or fewer max_tokens. You requested up to 131072
tokens, but can only afford 83488." No tool was called and nothing in the workspace changed. The rest
of the run was not measured; it needs the key topped up (a person's step), then **Run** again. The
intent is `stopped`, `0001-author-field` is `failed` with 4 lifetime attempts, and nothing was activated.

What the run did show about 13d: attempt a4's verdict no longer says "The workspace did not change."
(fix 2 — it is judged against 13c's first turn, and 13c's attempts did change it), and the two
failures stopped the run after two counted turns, as neither got further.

**Found, not changed here (out of scope):**
- A provider error mid-turn is not in the verdict's reasons. `InProcessTurnResult.error` is set only
  for a turn that could not start; one that fails on the provider ends `failed` with no `error`, so the
  task's failure reads as if the builder had tried and missed. And such a turn costs an attempt, where
  an interruption gives it back.
- The launcher's stderr printed the provider's error text unredacted, including the key's
  identifier in OpenRouter's settings URL; the knowledge log's copy has it `<redacted>`.

## Open questions

- The Backlog panel was empty on its first open until Refresh, as 13b saw once; it recurred here on a
  fresh launcher with no turn running.
