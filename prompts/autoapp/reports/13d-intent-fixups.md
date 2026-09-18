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

Compiled launcher from this tree, over the real root, 2026-09-18. The 13c launcher (pid 54153, the
old binary) was still serving that root; I stopped it with SIGTERM and started the new one with
`open --no-open` (`restored: reading-list`). Settings model: OpenRouter `z-ai/glm-5.3`. Two runs:

**Run 1, 12:51:22, pressed by me: out of credit.** Turns a4 and a5 of `0001-author-field` failed at
the provider ("This request requires more credits, or fewer max_tokens. You requested up to 131072
tokens, but can only afford 83488."), 62 s and 1 s, no tool call, and the run stopped "failed after 2
attempts". The advice question failed the same way. The person topped the key up.

**Run 2, 13:08:02, pressed by the person,** who had also set `0001-author-field`'s own model to
`deepseek/deepseek-v4.1-flash` in the panel. Tool calls are the gate's steps in `runs.sqlite`.

| task | model | turn | started | length | tool calls | verdict |
|---|---|---|---|---|---|---|
| 0001-author-field | deepseek-v4.1-flash | a6 | 13:08:03 | 20m00s | 23 | not completed: `…-c6` failed; ran out of time |
| | | a7 | 13:28:04 | 19m42s | 31: 2 edits, 2 builds, 3 checks | **completed**; est. 110, actual 184 lines; 528,192 in, 28,791 out |
| 0002-unread-page | glm-5.3 | a1 | 13:47:46 | 10m05s | 13, reads only | not completed: no change, no example; **no tool call for 8 minutes**; error "Failed to process successful response" |
| | | a2 | 13:57:51 | 8m31s | 12, reads only | the same; run stopped, "0002-unread-page failed after 2 attempts." |
| 0003-author-counts | deepseek-v4-flash | – | – | – | – | not reached |

**What it shows about 13d.**
- **The idle limit fired twice**, both on glm-5.3 after twelve or thirteen reads: 8 minutes of silence
  ended turns that would otherwise have had twenty. That is the 13c pattern (twelve reads, no edit,
  twenty minutes) cut to ten. Its sentence reached the failure and the builder's next message. The
  abort also shows as "The turn ended with an error: Failed to process successful response", the SDK's
  message for a response cut off mid-read: one cause, two sentences.
- **Fix 2:** a6's verdict did not say "The workspace did not change." It was judged against 13c's first
  turn, whose edits are still there.
- **Fix 3 was not exercised by a real run.** 0001 went from 5 of 6 to completed, which the ordinary
  second attempt allows; 0002 passed 0 then 0, so no progress and a stop after two, as the rule says.
- **Fix 1:** 0001 completed with 0004's examples still passing; nothing was removed.
- The advice for 0002, verbatim in substance: `retry`, "the run stalled and errored out before the
  workspace was touched, so the plan has not been tested at all".

The intent is `stopped`; 0001 and 0004 are `completed` in the candidate, 0002 `failed`, 0003 queued.
Nothing was activated. The launcher is still running.

**Found, not changed here (out of scope):**
- A provider failure is a builder's failure. The out-of-credit turns ended with no error in the
  verdict (it read as a missed example) and each cost an attempt, where an interruption gives one back.
- The launcher's stderr printed the provider's error text unredacted, including the key's identifier
  in OpenRouter's settings URL; the knowledge log's copy has it `<redacted>`.
- glm-5.3 stalled after reading on 0002 in both turns, as on 0001 in 13c; deepseek finished 0001.
  Whether 0002 wants its own model is the person's call; the advice says retry.

## Open questions

- The Backlog panel was empty on its first open until Refresh, as 13b saw once; it recurred here on a
  fresh launcher with no turn running.
