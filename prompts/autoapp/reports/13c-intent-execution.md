# 13c — Run the backlog: one task, one turn, one model, the host in charge

## Step 0 — four corrections from the review of 13b

1. **Words or whole slugs.** `resolveReference` in `plan.ts`: a whole slug of a live task matches
   itself; anything else matches the intent's live task whose slug without its number equals it.
   Resolved at add time when the task exists, else at `submit`, which rewrites the rows; the stored
   value is always the whole slug. Two matches is a problem naming both. The `intent.task`
   description says either form is accepted. Test: "blockedBy and repaidBy accept a task's words…".
2. **The panel notices a backlog being written.** `IntentPanel` takes `turnActive`, from a new
   optional `BroappChat.onBusy`; one polling hook (`usePolling`, reasons in the pure `shouldPoll`)
   reads every two seconds while a turn runs, the open draft is unsubmitted, or a run goes, and once
   more when that stops. Test: "the panel reads again while…".
3. **A read route answers while a turn is held open** — it does: a chat turn waits on a `source.edit`
   confirmation and `launcher.intentGet` answers meanwhile. Test: "a read route answers while…".
4. **What a criterion may be.** One sentence in `SPLIT_RULES` (so in the `intents` topic and the
   `intent.task` description); a backlog row, **A verdict as strong as its examples**, links it to
   **Fail-before, pass-after**.

## What was built

- **Core** (`create-ai.ts`): `answer` may return `'defer'`; the question it is given now also carries
  `requestId`, `callId` and `expiresAt` (`InProcessQuestion`, exported from `broapp/ai/host`). On
  `'defer'` nothing is settled. `tests/ai-chat.test.ts` untouched.
- `intent/executor.ts`: `INTENT_APPROVES`, `INTENT_REFUSES`, `standingAnswer`, `verdictOf` (pure),
  `builderMessage`, the advice question (`ADVICE`, patterned on `distil.ts`), and `createExecutor` →
  `{ start, stop, stopAll, busy, ask, active, progress, idle }`.
- Store: `moveTask(…, runId?)` stamps `started_at`/`ended_at`/`attempts`/`run_ids` in its transaction;
  `setRun`, `recordResult`, `setFailure`, `setAdvice`, `ask`, `answer`; restart recovery on open, opt-in
  (`recover: true`), passed only by `main.ts` for the commands that open the launcher tab — never by
  `serve <appId>` or a one-shot command, which may open the store beside a running launcher;
  `replaceTask` accepts a failed task of a stopped intent and returns it to `proposed`. Moves added:
  `in-queue → failed` (model gone, no turn) and `failed → proposed` (revised).
- Tools: `intent.start` (`write`), `intent.ask` (`read`); the three drafting tools and `intent.start`
  refuse an `intent-` run with `conflict`; `BUSY_LOCKED` refused before the gate while a run works on
  the application.
- Routes: `launcher.intentRun|intentStop|intentAnswer` (write, channel `user`),
  `launcher.intentRunning` (read, for the rail mark); `intentGet` gains `run` (progress, and the
  waiting `question`); `launcher.activate` refuses while busy.
- Panel: Run and Stop with inline confirmations, the question card (Approve/Deny through
  `ai.chatConfirm`, countdown), answer boxes, per-task progress, failure reasons and advice, the
  closing sentence and "For you to check by hand"; the rail button is marked while a question waits.
- Shutdown stops the run and awaits `idle()` with the child deadline, before the stores close.
- Docs: `intents.md` "How a backlog runs" with `diagrams/autoapp-backlog-run.{html,svg}` (drawn with
  the `diagram-design` skill, self-check clean), `security.md` "A run answers for the person", the
  package README, four backlog rows (revert and continue, a stream for progress, a verdict as
  strong as its examples, `answeredBy` on the execution record). Instructions: two sentences in 13b's paragraph.

## How a stand-in answer appears in the gate's record

The gate records it exactly as a person's: `decision: confirmed` (or `denied`), bound to its
arguments, once per request id. `ExecutionRecord` has no field for who answered, so, as the prompt
allows, the executor writes one knowledge `log` event per answer — "the run's standing answer approved
candidate.cycle for items (intent 1)", "the run refused release.activate…", "the run put source.edit to
the person…" — with the run and call ids. The record's `caller` is `ai:intent-<id>-<slug>-a<n>`, which
already names the intent and the task. Test 4 asserts the five decisions and one row per request id.

## Deviations, and why

1. **`serve.ts` honours a first line `Application: <appId>`.** The prompt says that is how the turn's
   application is resolved; it was not — `chooseApp` took the first id named anywhere, and test 3
   caught a builder of `items` served `empty`'s documents because its plan said "an empty list". The
   declaration now wins when it names a real application.
2. **The verdict derives `editsSinceBuild` from the revision it just read.** `CandidateStates` caches
   the revision briefly; read the instant a turn ends it could be stale, and test 2 failed a task that
   had passed. `builtFromRev` vs the fresh `revNow` is the same rule without the cache.
3. **Run ids are numbered by turn, not by counted attempt** (`a<runIds.length + 1>`): an interruption
   gives its attempt back, and a run id reused would collide in transcripts and contexts.
4. **Attempts are counted per run.** A resumed task gets two more tries; the column keeps the lifetime
   count. Between attempts the task moves `in-progress → failed → in-queue`, so each failed attempt
   is in its history with its reasons.
5. **Question expiry is read from the tool result.** A forwarded question's turn is aborted when its
   refusal arrives at or after `expiresAt` (a person's Deny comes before it). No core hook was needed.
6. **Refusals are `conflict`, not `rejected`**, wherever the builder must read the sentence: the run
   loop turns `rejected` into a bare "declined".
7. **`BroappChat.onBusy`** (optional prop, `broapp-ai-elements`) — the only way `App.tsx` could know a
   turn is streaming. **`launcher.intentRunning`** — a read the rail polls only while a run goes.
8. **A model no longer offered fails without asking for advice**: nothing about the plan went wrong.
   Advice otherwise stays on a task when it is queued again, and is cleared when the task completes
   or is revised (with its failure); the failure itself is cleared on re-queue.
9. **Instructions cap 70 → 72**, exactly the two lines added (three tests, one title).
10. Commit trailer names Claude Opus 5, per this session's attribution rule. The report runs past
    100 lines because of the by-hand run and its table, which the prompt asks for (as 12h and 13b).

## Tests

`tests/autoapp-intent-run.test.ts`, 24 tests: Step 0 (5), `verdictOf` (2), standing answer (3), runs
2+3, 4, 4b, 4c, 5+6 (with the advice kept on re-queue and cleared on completion), 6, 7, 8, 9, 11, 12,
restart 10 (an open without `recover` changes nothing), revising a failed task, panel 13. Builders' turns are real: a completed task
edited `autoapp.json` in a git workspace, built, previewed and passed. 4d is in `tests/ai-host.test.ts`.

## The by-hand run

Compiled launcher over the real root, 2026-09-18, nothing else running on the machine. The Settings
model is OpenRouter `z-ai/glm-5.3`, the one 13b planned with; the launcher read its own key. I reused
13b's plan of the same three-part request (intent 1 on `reading-list`, submitted, four tasks) rather
than plan it again, reviewed it in the panel, set `0003-author-counts` to `deepseek/deepseek-v4-flash`
there, and typed "The reading-list backlog looks right. Go ahead." `intent.start` asked; the card was
answered Allow in the pane about ten seconds in, not by me. The run began at 11:39:40.

| task | model | turns (attempts) | minutes | tool calls | verdict | est. / actual lines |
|---|---|---|---|---|---|---|
| 0004-author-column (deep) | glm-5.3 | 1 (1) | 3m17s | 11: 5 reads, 1 cycle, explain… | completed, 4 of 4 checks | 15 / unknown ¹ |
| 0001-author-field (standard) | glm-5.3 | a1 (1) | 20m00s | 12, reads only | no edit: out of time | 110 / – |
| | | a2 (2) | 20m00s | 20: 2 cycles, 4 `preview.try` | `…-c6` failed; out of time | |
| | | a3 (–) ² | 3m41s | 14 | interrupted: **Stop** pressed | |
| 0002-unread-page | glm-5.3 | 0 | – | – | not reached | 100 / – |
| 0003-author-counts | deepseek-v4-flash | 0 | – | – | not reached | 70 / – |

¹ The workspace had no commit before the run (`rev_before = no-git`); the builder's edit made the
first one, so there is no base to diff against. ² The resumed attempt; the interruption gave it back.

**Did the run finish?** No. After 0001's second failure the run stopped with "0001-author-field failed
after 2 attempts." The advice, verbatim in substance: *advice `retry`* — only the over-length-author
example still failed, the cap fires but not as `invalid_input`, and "the prior attempt was cut off by
the clock, not defeated by the design". I resumed with **Run** in the panel, as the advice said; at
12:27 **Stop** was pressed in the pane (not by me), the task went `interrupted` with its attempt given
back, and the intent `stopped` "by the person". I did not resume it again. Nothing was activated;
`reading-list` still serves its old release, with 0004's candidate and 0001's partial work in the
workspace.

The standing answer approved 3 × `candidate.cycle`, 3 × build, 3 × preview; nothing was brought to the
person and nothing refused. Tokens for 0004: 149,199 in, 31,168 out.

**Beside a single long turn.** 08c: one 36-minute turn on local `qwen3.8:27b-mlx`, three edits, no
build. 12b: nine minutes, two edits, stopped by the step cap, no build. 12d's three-run evaluation:
the contract-and-migration task (`notes-tags`) produced working code in at most 2 of 3 runs per
condition, and 2 or 3 of the 3 runs timed out under every condition but baseline. Here, a migration task
was built, previewed and verified with its own examples in one 3-minute turn, and the second task came
within one example of passing. The models differ (hosted glm-5.3 against a local 27B), so this is not the
same measurement. What it does show is that the twenty-minute limit, not the verdict, stopped the run.

## Commands run

```
bun run typecheck                                                    exit 0
bun test tests/autoapp-intent{,-tools,-run}.test.ts                  63 pass, 0 fail
bun test tests/autoapp-{engineer,knowledge,gate}.test.ts             150 pass, 0 fail
bun test tests/ai-host.test.ts                                       14 pass, 0 fail
bun test tests                                                       871 pass, 0 fail (52 files)
bun run --cwd packages/broapp-autoapp build:page                     launcher-page.html 1324.7 KiB
bun run --cwd packages/broapp-autoapp build:launcher                 dist/broapp-autoapp 77.4 MB
bun run scripts/autoapp-smoke.ts                                     every step passed
bun install && bun run check                                         exit 0, 871 pass
git diff --stat tests/ai-chat.test.ts                                (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| "Go ahead" or **Run** starts only after one question saying what is approved | pass (tests 11, 9; by hand, chat and panel) |
| Each task its own turn on its model, in order, `in-queue → in-progress → completed` | pass (tests 2, 3; by hand for 0004) |
| Completed only on a verified build with an example per criterion, nothing regressed | pass (verdict tests; test 5; by hand 0001 was refused on one example) |
| Two failures stop the run, workspace left, reasons and advice shown | pass (tests 5, 6; by hand) |
| The run answers only for its own edits, builds and previews; the rest waits; an unanswered question costs no attempt; activation and creation never; each question recorded once | pass (tests 4, 4b; standing-answer tests) |
| A builder asks one question, the task waits, the answer reaches the next attempt | pass (test 4c) |
| Stop, resume, read and chat meanwhile; other writes refused | pass (tests 8, 9; by hand stop and resume) |
| A restart interrupts and never resumes | pass (test 10) |
| `tests/ai-chat.test.ts` unchanged; `bun run check` green | pass |

## What this prompt strains in the common rules

- **Approval identity** holds, but "who answered" is not part of it. A standing answer is
  indistinguishable in the gate's record from a person's; only the log and the `intent-` caller say
  so. If a stand-in is to be permanent, `ExecutionRecord` wants an `answeredBy` (backlog row added).
- **Channel identity**: a builder's turn is channel `ai` like a chat turn. The rules fix four channels;
  the run is told apart by run id, which is set by the executor, never by a model.

## Open questions

- `tests/autoapp-intent*.test.ts` are not in CI's per-platform Autoapp list (they run in the suite job).
- A workspace with no commit before a run reports `actual_lines` as unknown for the task that makes
  its first commit (seen in the by-hand run).
