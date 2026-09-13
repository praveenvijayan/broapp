# 12j — Structured history, and a second turn that can be measured

## What was built

- **Store** (`threads.ts`): migration 3, `transcripts` (`run_id` key, `messages`, `chars`, `created_at` + index). `saveTranscript` removes unpaired tool calls and the messages they leave empty, drops `providerOptions`/`providerMetadata`/`providerExecuted`, writes canonical JSON, refuses over 200,000 characters (`warn`). `transcript` reads back only arrays of `assistant`/`tool` messages with typed parts (anything else is absent, reported once). `retainTranscripts`: older than 30 days or beyond the newest 2,000, one transaction, on open and on every save.
- **Run** (`run.ts`): `RunDeps.transcripts`. On `finish`, `await result.responseMessages` is saved before `usage` and `done`. A turn that does not finish keeps what it did: finished steps from `onStepEnd`, the step in flight from `onChunk` text and the calls this layer ran; written at the moment of the abort. Exported pure `expandHistory(history, read, limits)` and `HISTORY_LIMITS` (6 turns, 1,000 / 2,000 / 60,000). `safeToolMessage` and the result shape unchanged.
- **Wire and clients**: `chatTurn.runId` optional, same pattern as `ai.chat`'s `runId`. `ChatTurn.runId`. Transport writes `metadata.runId` at first text or tool input and with `usage`; `toHistory` sends it. `use-ai-chat.ts`: `ChatMessage.runId`, `toHistory` passes it (exported for its test, not from `broapp/ai/react`). `use-broapp-chat.ts` unchanged.
- **Harness**: `InProcessTurn.history`; `RunHandle.turn(runId, message, timeoutMs, history?, { stopAfter })`, stopping after a call's result is in; `TurnOutcome.text`/`stopped`; `RunLabel.turn/history/restart`.
- **Evaluation**: `turns: 2`, `between`, `HISTORY_MODES`, `RESTART_CONDITION = orientation+facts`, `twoTurnColumns` (exported), cells per task × condition × history (+ restart), `tasks`/`conditions` options, run ids unique across evaluations, a second Markdown table. `notes-tags` is two turns; new `starter-priority` (`touch-file`).
- **Docs**: `ai.md` "What the host keeps per run" and the "What leaves the machine" row; `learning.md` "Evaluation"; `backlog.md` scratchpad row and a "What was measured" row.
- **Tests**: `tests/ai-history.test.ts` (17: the prompt's 1–8, plus a stop mid-text, a stop after a result, unreadable rows, the 200,000 cap, and a cut input sent through the real Ollama adapter). `tests/autoapp-evaluate.test.ts` gains 9–11 (child in `two-turn` mode, and pure counters). `tests/ai-chat.test.ts` untouched.

## Deviations, and why

1. **`ResponseMessage` is not exported by `ai`**; `threads.ts` exports it as `AssistantModelMessage | ToolModelMessage`, which is its declaration.
2. **A stopped turn writes a transcript too**, not only `finish`. The harness stops turn one on purpose; without this, structured history would have had nothing to expand. Written at the abort, because the SDK waits for a running tool before ending the stream (spiked); a call still running then is unpaired and dropped (test 2).
3. **A cut tool input is `{ truncated: "<head><omitted N chars>" }`, not a bare string.** The first version used the string; the OpenAI-compatible adapter sends input as `arguments`, and Ollama refused the whole request ("invalid tool call arguments"). Found by the evaluation, fixed in `ee100c1` with a test through the real adapter that fails on the old code.
4. **Test 5** takes the table away (`DROP TABLE`) rather than closing the store: `Ai.close()` reopens it lazily. **Test 4** uses a fresh adapter per turn, so the prompt is `calls[0]`, not `calls[1]`. **Test 8** calls the hook's `toHistory` directly: no DOM renderer in the repo.
5. **Existing assertions changed**: transport chunk order gains `message-metadata`; `user_version` 3; the knowledge test's evaluation counts single-turn tasks, which is what its child now runs by default.
6. **Two-turn cells have their own table**, and the single-turn table lists only single-turn tasks. Tokens for a turn that times out read 0 (no `usage` event), as in 12d.
7. Commit trailers name Claude Opus 5, per this session's rule; the code landed in `4dc276c` and `ee100c1` before this report, at the person's request.
8. The harness's transcripts go to the launcher AI data directory it is given (for the evaluation, `<root>/launcher/ai/threads.sqlite`), as the prompt fixes; retention bounds them.

## Transcript size of a real turn

From the 47 transcripts the two evaluation attempts wrote (`qwen3.8:27b-mlx`), measured with `expandHistory`:

| turn | calls | stored chars | after bounds | expands under the 60,000 cap |
|---|---|---|---|---|
| baseline notes-tags, turn one (edited at call 15) | 15 | 100,659 | 37,810 | yes |
| orientation+facts notes-archive, single turn | 19 | 174,649 | 99,030 | **no** |
| orientation starter-done-filter, single turn | 31 | 182,573 | 144,630 | **no** |
| baseline starter-priority, turn one (reads only) | 8 | 26,507 | 16,457 | yes |

Largest stored: 182,573 (under 200,000). **Finding:** after per-part bounds, a turn of about 20 calls or more is still 60,000–145,000 characters, so under "a turn expands whole or not at all" it stays text. The long turns the prompt's anecdote is about (17–20 calls of rediscovery) are the ones least likely to expand. Tighter output bounds, or expanding the newest calls of a turn, would change that; both reopen fixed decisions, so neither is done here.

## The evaluation — not completed

**Attempt 1** (2026-09-12 22:36 → 2026-09-13 10:17, launcher source at `4dc276c`, demo root `tests/.autoapp-run/demo-12d`, 40 steps, 20 min a turn): stopped at run 23 of 78 for deviation 3. Its structured cells whose turn one only read were unaffected (short inputs); the first structured cell whose turn one edited failed turn two with the provider error.

**Attempt 2** (from 10:20, at `ee100c1`): stopped by the person at run 10 of 78, to use the machine. No other session ran during either attempt until that stop.

No three-run table exists. What was measured, one run a cell, turn two only:

| attempt | condition | history | task | turn-one calls | reads before first edit | repeated reads | repeated actions | working code |
|---|---|---|---|---|---|---|---|---|
| 1 | baseline | text | notes-tags | 6 | 2 | 1 | 0 | no |
| 1 | baseline | structured | notes-tags | 6 | 3 | 0 | 0 | no |
| 1 | orientation | text | notes-tags | 5 | 2 | 0 | 0 | no |
| 1 | orientation | structured | notes-tags | 5 | 3 | 1 | 0 | no |
| 1 | orientation+facts | text | notes-tags | 6 | 5 | 3 | 0 | no |
| 1 | orientation+facts | structured | notes-tags | 6 | 0 | 0 | 0 | no |
| 1 | orientation+facts | structured, restart | notes-tags | 6 | 3 | 2 | 0 | no |
| 1 | learned | text | notes-tags | 6 | 5 | 3 | 0 | no |
| 1 | learned | structured | notes-tags | 5 | 2 | 0 | 0 | no |
| 1 | baseline | text | starter-priority | 8 | 6 | 5 | 0 | no |
| 1 | baseline | structured | starter-priority | 3 | 5 | 0 | 0 | no |
| 1 | orientation | text | starter-priority | 8 | 6 | 5 | 0 | no |
| 1 | orientation | structured | starter-priority | 7 | 17 | 5 | 0 | no |
| 1 | orientation+facts | text | starter-priority | 18 | 7 | 10 | 0 | yes |
| 2 | baseline | text | notes-tags | 16 | 15 | 13 | 0 | no |
| 2 | baseline | structured | notes-tags | 15 | 12 | 8 | 0 | no |

(Attempt 1's structured orientation+facts starter-priority cell is left out: its turn two is the bug.) Every two-turn run but one timed out; on this model turn one mostly used its twenty minutes without an edit, so turn two usually followed a timeout, not a stop at an edit. `readChangedFirst`: text 3 of 3, structured 2 of 2 (starter-priority, attempt 1).

**What it says about "seventeen calls of rediscovery"**, with that sample size: under text history turn two repeats most of turn one's reads (13 of 15, 10, 5 of 6 twice). Under structured history repeated reads drop in 5 of 7 text/structured pairs (1→0, 3→0, 3→0, 5→0, 13→8), stay once (5→5) and rise once (0→1); the restart cell gave 2 against text's 3. Reads before the first edit do not reliably drop (6→17 once), and no structured run produced more working code. Directionally consistent with the claim; not a measurement.

**The scratchpad row stays deferred**: nothing here shows structured history is insufficient, and the size finding above is the cheaper thing to try first.

## Commands run

```
bun run typecheck                                              exit 0
bun test tests/ai-threads.test.ts tests/ai-host.test.ts tests/ai-history.test.ts   pass
bun test tests/ai-chat.test.ts tests/ai-elements-transport.test.ts                  pass
bun test tests/autoapp-knowledge.test.ts tests/autoapp-evaluate.test.ts             pass
bun run --cwd packages/broapp-autoapp build:launcher           exit 0
bun run scripts/autoapp-smoke.ts                               exit 0 (every step passed)
bun run dryrun / bun run dryrun:autoapp                        exit 0 / exit 0
bun install && bun run check                                   exit 0, 787 pass; after ee100c1: 800 pass, 0 fail
knowledge evaluate --runs 3 --out .broapp-tmp/eval-12j         attempt 1 stopped at 23/78 (bug); attempt 2 stopped by the person at 10/78
```

## Acceptance criteria

- **The host writes every turn's transcript before `done`, and a "continue" whose history names it receives its tool calls and results, bounded, on every client and in the harness** — pass (tests 1, 4, 7, 8, 9), with the size finding above: a turn over the cap after bounds stays text.
- **A client that sends no `runId` gets today's behaviour; `tests/ai-chat.test.ts` unchanged and green** — pass.
- **Nothing the browser saved is read into a prompt** — pass (only the host-written `transcripts` table is read; test 7 goes through a save and reload).
- **`knowledge evaluate` runs the two-turn tasks under both history modes and prints the columns; the three-run table is in the report** — the command and its test pass; **the three-run table is not met** (two attempts stopped, see above).
- **`bun run check` green; every command exits 0** — pass.

## Open questions

- Should the 60,000 total, the 2,000 output bound, or "whole or not at all" change, given that long turns do not expand?
- Turn one on `qwen3.8:27b-mlx` rarely reaches an edit in twenty minutes, so "stopped at the first edit" is rarely what turn two follows. A longer turn-one limit, or a smaller task, would measure the intended case.
- The full run is ~35 hours on this model; `--tasks`/`--conditions` flags on the command (the options exist) would let two-turn cells be measured alone.
