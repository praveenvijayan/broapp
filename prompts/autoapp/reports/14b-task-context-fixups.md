# 14b — Fix-ups to 14a, and the measurement it could not make

## What was built

The code is commit `9ff7604`. Another session on this machine committed it at 19:14, while the replays were
running from this tree. It used the prompt's message, with a Fable 5.1 trailer and a note that the report
would follow. I have not rewritten it. This report is the follow-up commit.

- **The terminal copy is sanitised at the tee.** In `createEventLog`, every `tee?.warn` / `tee?.error` now
  prints `sanitise(message)`: `warn`, `error`, a child's two, and the write-failure line.
- **`EventLog.announce(message)`.** Prints the message to the tee as given. Stores it sanitised, as a `warn`
  of kind `log`. The doc comment says it is for a launch address a person must open, and nothing else.
- **`sanitisedLogger`.** In `tab.ts` the wrapper **went** where the logger is the event log (`logger ===
  options.knowledge.log`, which is how `main.ts` wires it). It **stayed** for any other logger, which is the
  console when nothing is written down. The launcher's routes get the unwrapped logger either way.
  `sanitisedLogger` is still exported and still tested (`autoapp-intent-run`).
- **`announce` callers.** The grep found one line printing a `?bt=` address through a logger:
  `launcher/app.ts` `openTab`, "could not open a browser; open this address yourself". It uses `announce`
  when an event log is present, and plain `logger.warn` when not. `main.ts`'s four address lines go to
  `console.log` directly, never through the log, so they are unchanged. A source scan asserts `announce(`
  appears only in `knowledge/log.ts` and `launcher/app.ts`.
- **CI.** `tests/autoapp-task-context.test.ts` is added to the per-platform Autoapp line in `ci.yml`, with
  the comment the prompt asks for (`fileKey` on back-slashed paths, and `EBUSY` from report 12j).
- **`attempts.ts`.**
  - `AttemptRecord.read?` holds a run's distinct `source.read` paths.
  - A block with no edits gains `Read:`: at most 6 paths, then "and <k> more".
  - `START_FROM_AN_EDIT` closes the document, once, when the newest earlier attempt changed nothing. Its
    length is reserved before the 1,500 budget is shared, so it is never cut.
  - `sourceReads(store, runId)` and an optional `reads` on `attemptsInput`, `CreateServeInput` and the tab
    (over its run store).
- **Docs.** `intents.md` ("What a retry is told") and `security.md` (what the log prints).
- **Tests.** Three in `autoapp-knowledge.test.ts` (the prompt's 1–3; the write-failure line is forced with a
  trigger that `RAISE`s both shapes) and four in `autoapp-task-context.test.ts` (5, plus `sourceReads`).
  The smoke's "panel link" step (4) passes.

**Does the run store keep a read's path?** Yes. `steps.input_json` holds `{appId, path}` for every gated
`source.read`, keyed by the run id the executor sets. So no second record of reads was added.

## Commands

```
bun run typecheck                                                exit 0
bun test tests/autoapp-knowledge.test.ts tests/autoapp-task-context.test.ts tests/autoapp-intent-run.test.ts   131 pass, 0 fail
bun test tests                                                   912 pass, 0 fail (53 files)
bun run --cwd packages/broapp-autoapp build:launcher             dist/broapp-autoapp 77.6 MB (once, before the seeds)
bun run scripts/autoapp-smoke.ts                                 every step passed, "panel link" included
bun install && bun run check                                     exit 0, 912 pass (rerun after the replays, on 9ff7604)
git diff --stat tests/ai-chat.test.ts packages/broapp            (nothing)
```

## The measurement

Local Ollama, `qwen3.8:27b-mlx`: nothing left the machine and no key was entered. The script is
`tests/.autoapp-run/byhand-14b.ts` (gitignored). It drives the launcher tab in-process, as 14a's did. Each
run's `ai` directory is inside its root, so no two runs share one.

**Seeds.**
- **Edits seed.** 14a's run-1 root (`runs/on-1 on`), where `0001` had completed. Task `0002-record-done-at`
  (labels host, contract), turn limit 6 min, `maxAttempts` 1. Four tries:
  1. Edited `db.ts` and `contract.ts`; one build **passed** (7 of 7 old examples); cut at 6 min.
  2. The builder used `intent.ask` at 2.5 min and edited nothing.
  3. Same as 2. Both times it said c2 and c4 contradict. They do not: c4 is marked `failure: true`.
  4. I answered once, as the person, in try 3's copy: "c4 is a failure case…; build c2". Then the attempt
     ran from there. It edited `db.ts`, `contract.ts` and `autoapp.json` (new examples), built twice and
     both builds **passed**, then was cut at 6m31s before any check of its examples. Verdict: out of time,
     no example of the task run.
  
  **Deviation:** the prompt asks for at least one build problem. Two attempts produced edits and neither
  build failed, so I took try 4 rather than re-roll for an error. Its attempts document also carries 14a's
  zero-step stopped turn as "Attempt 1" and the asking turn as "Attempt 2 … Read:". The newest earlier
  attempt (3) edited, so the edits seed never gets the closing sentence.
- **Changed-nothing seed.** 14a's run-3 root (`runs/on-2 on`), still on disk. `0001` there had two
  attempts, both reads only and both ended by the idle limit. The retry is attempt 3. Its document lists
  both attempts' reads and ends with the sentence. I confirmed this from the delivered `contexts` blob.

**Switches.** Each run printed `argv` and `switch:` first. All ten match what was meant, and none was
discarded. The launcher was not rebuilt, and no `knowledge evaluate` ran. The person's own launcher (pid
7814, from 17:27) served two applications on another root throughout. At about 19:14 another session
committed this code, and by its message ran typecheck and three test files. That overlaps "edits off 3"
(19:07–19:15) and "silent on 1" (19:15–19:25), so their minutes are not clean. Outcomes stand.

**Replays** (fresh copy of the snapshot each time, Run pressed with default limits, `maxAttempts` 1):

| seed | switch | outcome | calls | min | tokens in/out | first call | files re-read (of earlier reads or edits) | edits repeated | docs (why) · irrelevant |
|---|---|---|---|---|---|---|---|---|---|
| edits | on | failed: examples c1–c4 failed, then idle 8 min | 6 | 12.2 | unknown | read | 3: autoapp.json, db.ts, contract.ts | 0 | digest, attempts, intent, evidence · 0 |
| edits | off | asked the person | 14 | 9.4 | unknown | read | 3: db.ts, contract.ts, operations.ts | 0 | digest, intent, evidence · 0 |
| edits | on | failed: c1–c4 failed, then idle 8 min | 10 | 15.9 | unknown | read | 3 | 0 | as above · 0 |
| edits | off | asked the person | 18 | 12.9 | unknown | read | 4 | 0 | as above · 0 |
| edits | on | failed: c1–c4 failed, then idle 8 min | 13 | 19.2 | unknown | read | 3 | 0 | as above · 0 |
| edits | off | asked the person | 15 | 8.1 | unknown | read | 4 | 0 | as above · 0 |
| silent | on | failed: examples not run on the preview | 11 | 8.6 | 133,550 / 9,652 | read | 4 of 4 | 0 | + lesson:4 (words) · 0 |
| silent | off | **completed** | 9 | 10.2 | 99,245 / 11,575 | read | 2 (each read twice) | 0 | digest, intent, evidence, lesson:4 · 0 |
| silent | on | asked the person | 9 | 4.2 | unknown | read | 3 | 0 | + lesson:4 · 0 |
| silent | off | **completed** | 8 | 8.4 | 64,989 / 9,479 | read | 4 | 0 | as above · 0 |

"Unknown" tokens: the turn was ended by the idle limit or by `intent.ask`, and neither records a `usage`
event. `lesson:4` is the migration seed, served for a migration task, so I judge it relevant. No document
in any run struck me as irrelevant.

**What the three "asked" runs asked, all edits/off:** how to assert that `doneAt` is a number of
unknown value, since a `match` is exact. The "on" arm met the same wall (c1–c4 failed on a literal
timestamp) and went silent instead. That is a real limit of acceptance examples (below), not of the task
context.

**What the table can support.** Ten runs, one model, two seeds, one task each.
- It **can** say that every retry, with or without the documents, began by reading, and re-read three or
  four files the attempt before it had read or edited.
- It **can** say the closing sentence, delivered twice, was not followed either time: both runs'
  first calls were `source.read` of files it named.
- It **can** say that on the silent seed both "off" runs completed and neither "on" run did. Two against
  two cannot separate a document's effect from a 27B model's variance. 14a's own seed shows this model
  completes `0001` first time in two runs of three.
- On the edits seed the arms ended differently: three verdicts after silence with the documents, three
  questions without. This is a difference in shape, three against three, and not a result.
- It **cannot** say whether the attempts document or tier-2 lessons help a retry, and it gives no reason
  to believe they do on this model.

**Decision 3's sentence, in my judgement, should not stay as written.** It was delivered in both silent/on
runs, and both disobeyed it on the first call. Those two are also the silent seed's only failures (one
failed verdict, one question), against two completions without it. Two runs cannot convict it. But the
one line whose job is to change behaviour changed none it could be seen to, and so far the evidence is
against it. I would take it out, or measure it alone (sentence on, everything else fixed) before keeping
it. `Read:` costs one line and is informational. I would keep that.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Nothing the event log prints carries what it redacts, for any caller; a launch address still prints whole | pass (tests 1–3; smoke "panel link") |
| `autoapp-task-context.test.ts` on all three platforms in CI, green | on the line in `ci.yml`; **CI not run by me**. `9ff7604` is pushed, and no run was dispatched from here |
| A retry after an attempt that changed nothing is told what was read and to start from an edit | pass (test 5; delivered blobs above) |
| Table from fixed snapshots, 6 + 4, switch printed and matching | pass, with the seed deviation above |
| `ai-chat.test.ts` unchanged; no change to `packages/broapp`; `check` green | pass |

## Open questions

- **Acceptance cannot assert a value it cannot predict.** A timestamp is the plainest case. Every "off"
  retry on the edits seed stopped to ask for a type or presence matcher, and every "on" retry failed on
  the same line. This is a backlog row: "A verdict as strong as its examples" is the nearest one.
- **The edits seed's first two tries asked about criteria that do not conflict.** The builder read
  `failure: true` as a contradiction. How a failure criterion reads in the builder's message may want a
  word.
- A turn ended by `intent.ask` records no `usage`, as the idle limit does not. Five of ten rows have no
  token count for that reason.
- CI has not run on `9ff7604`, so the Windows answer for `autoapp-task-context` is still to come.
