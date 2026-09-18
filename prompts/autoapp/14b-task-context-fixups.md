# 14b — Fix-ups to 14a, and the measurement it could not make

## Goal

14a built what it was asked to and measured nothing: attempt 1 failed in one run
of three, the "off" runs never ran (a shell variable passed `1 off` as one
argument), and the one retry it saw failed by going silent, which no account of
earlier edits can help. This prompt closes 14a's two open questions, makes the
attempts document say something to a retry whose first attempt changed nothing,
and takes the measurement in a form that does not depend on attempt 1 failing
by luck. Nothing else is built.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13c, 13d and 14a in full.
- `packages/broapp-autoapp/src/knowledge/log.ts`: `sanitise`, `sanitisedLogger`,
  `createEventLog` and every `tee?.` call in it (five today: the write-failure
  line, `warn`, `error`, and the child's two).
- `packages/broapp-autoapp/src/launcher/tab.ts` where `printed` is made, and
  `launcher/app.ts` line ~153, the one line that prints a launch address through
  the log. Find every other line that prints an address with a `?bt=` query
  (`grep -rn "bt=" packages/broapp-autoapp/src`) before deciding anything.
- `packages/broapp-autoapp/src/knowledge/attempts.ts` in full; the run store's
  `steps` table (`host/` run store) — what it keeps of a `source.read` call.
- `.github/workflows/ci.yml`, the per-platform Autoapp job and the comments that
  say why each file is in its list.
- `tests/.autoapp-run/byhand-14a.ts` (gitignored; on this machine).

## Fixed decisions

| Decision | Value |
|---|---|
| 1. The terminal copy is sanitised at the tee | Today `createEventLog` prints a warning or an error before it sanitises it, so the written copy is clean and the printed one is not; 14a wrapped three consumers and left the supervisor and every child's stderr raw. Move it to the source: every `tee?.warn` / `tee?.error` in `createEventLog` prints `sanitise(message)`. Then `sanitisedLogger` in `tab.ts` is redundant for anything that logs through the event log: remove the wrapper where the logger it wraps is the event log, keep it where it is not, and say which was which in the report. |
| The one exception | A launch address has to reach the terminal whole: its token is the query `sanitise` removes, and 14a's smoke failed on exactly that. `EventLog` gains `announce(message: string): void` — printed to the tee as given, written to the store sanitised, level `warn`, kind `log`. It is for an address a person must open and nothing else, and its doc comment says so. The line in `app.ts` uses it, and so does any other line your grep found. A test holds the callers: a source scan asserting `announce(` appears only in the files you list, so a later caller is a decision somebody made. |
| 2. CI runs the new file on every platform | Add `tests/autoapp-task-context.test.ts` to the per-platform Autoapp line in `ci.yml`, with a comment in the style of the ones there saying why only a platform can answer it: `fileKey` turns a back-slashed path into the same key as a forward-slashed one, and the file opens and closes both stores and a tab, which is where Windows has refused cleanup before (`EBUSY`, report 12j). If it fails on Windows, fix the cause, not the list. |
| 3. An attempt that changed nothing says what it read | 14a's only retry: attempt 1 made four reads and no edit and was ended by the idle limit; attempt 2 was told "Changed: nothing", read the same two files and went silent the same way. For an earlier attempt with no `edit` event, the block gains **Read:** the distinct paths of that run's `source.read` calls, at most 6, from the run store's steps for that run id; and the document ends with one sentence, once, when the newest earlier attempt changed nothing: "The last attempt read these and changed nothing. Do not read them again: make the first edit the plan calls for, then use candidate.cycle." If the run store does not keep a read's path, do not add a second record of reads: write the sentence without the list and say so in the report. The 1,500-character cap, the cut order and "how the turn ended comes first" all stand. This is the one line in the document that tells a builder what to do; it is there because the evidence is one failure of exactly this shape, and the measurement below says whether it earns its place. |
| 4. The measurement starts from a recorded failure | Do not wait for attempt 1 to fail. Make one failed first attempt, keep it, and replay only the retry. **Seed:** 14a's planned root (the "Mark done … Done at column" backlog), task `0002-record-done-at` or whichever first touches host and contract; run it with `turnTimeoutMs` of 6 minutes and `maxAttempts` 1, so attempt 1 is cut with edits made and a build not yet passing — the shape 13c's by-hand run had. If it completes inside 6 minutes, halve the limit once; if it still completes, take the next task; say what you used. When it has failed with at least one `edit` event and at least one build problem, stop the launcher and copy the whole root (workspace, `knowledge.sqlite`, `intents.sqlite`, the run store) as the snapshot. **Replay:** from a fresh copy of the snapshot each time, press Run with default limits and let exactly one more attempt happen (`maxAttempts` 1 for the resumed run): three times with `documents.attempts` and `corpus.related` on, three with both off. Pass the switch as its own quoted argument and print it at the top of each run's output; a run whose printed switch is not what you meant is discarded, not reinterpreted. |
| A second seed, for the silent shape | Repeat the replay, 2 with and 2 without, from a snapshot whose attempt 1 changed nothing. 14a's run 3 is that case: if its root is still on disk use it, otherwise make one with a 3-minute idle limit. This is the only test decision 3 gets. |
| What is recorded | Per replay: completed or not; tool calls; minutes; tokens (from `usage` events — a turn ended by the idle limit records none, so say "unknown", do not estimate); reads of a file attempt 1 had already read or edited; edits that repeat one attempt 1 made; whether the first call was a read or an edit; delivered documents with `why`, and how many you judge irrelevant. Ten runs is few: say what the table can and cannot support. No verdict word. |
| The machine | No other session, no `knowledge evaluate`, no launcher build while a run is going: a build replaces `dist/broapp-autoapp` under the run (memory of 0.4.3, report 12d). Build once before the seed and not again. |
| Not in scope | `locks` written by planners (14a found every task has `locks: []`, so `task planned file` is empty — a backlog row, with that count); distillation's yield on this model (why `lesson distilled_from case` is 0); any change to tiers, `links`, ranking, the executor's limits or the builder's message; a no-progress limit on ordinary turns; putting the intent tests on the per-platform line. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-knowledge.test.ts tests/autoapp-task-context.test.ts tests/autoapp-intent-run.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests:

1. `createEventLog` with a recording tee: `warn`, `error`, a child's `warn` and
   `error`, and the write-failure line each print a line with a 64-hex id and a
   URL query removed; the stored row is the same text.
2. `announce` prints `http://127.0.0.1:1/?bt=abc` whole and stores it without
   the query.
3. The source scan: `announce(` only where listed.
4. The smoke's "panel link" step passes — this is the step that caught 14a's
   first cut.
5. `attemptsDocument`: an attempt with reads and no edits has **Read:** with at
   most 6 paths and "and <k> more"; the closing sentence appears once, only when
   the newest earlier attempt changed nothing, and survives the 1,500 cut; an
   attempt with edits has no **Read:** line and the document no closing sentence.

Then the ten runs by hand.

## Acceptance criteria

- Nothing the event log prints carries what it redacts when it writes, for any
  caller, and a launch address still prints whole.
- `tests/autoapp-task-context.test.ts` runs on all three platforms in CI, green.
- A retry after an attempt that changed nothing is told what was read and to
  start from an edit.
- The report has a with/without table from fixed snapshots, six runs from a
  failed-with-edits seed and four from a changed-nothing seed, each run's switch
  printed and matching.
- `tests/ai-chat.test.ts` unchanged; no change to `packages/broapp`;
  `bun run check` green.

## Report

`prompts/autoapp/reports/14b-task-context-fixups.md`: which `sanitisedLogger`
wrappers went and which stayed; every `announce` caller; whether the run store
keeps read paths; how each seed was made and what attempt 1 left; the table,
with what it can and cannot support; and whether decision 3's sentence should
stay, in your judgement, with the runs that say so.

## Commit

```
Sanitise what the log prints, and tell a retry what was only read

The event log sanitises the copy it prints as it does the copy it writes,
for every caller; a launch address goes through announce, the one line that
prints whole. The task-context tests run on every platform. An attempt that
changed nothing now says what it read, and the retry is told to start from
an edit. The report measures a retry with and without its documents from
fixed snapshots of a failed first attempt.
```

End the commit with the co-author trailer your session's rules give you.
