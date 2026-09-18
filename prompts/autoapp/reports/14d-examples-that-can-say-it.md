# 14d — An example can say "some number" and "this is refused"

The code is commit `705c5e7`. Another session on this machine committed it at 18:08 UTC, while
the first replay was running from this tree. That commit used the prompt's message, amended to
name the dead child and the paused gate, with a Fable 5.1 trailer and a note that the report would
follow. Its contents are this work, and there is no diff since. I have not rewritten it. That
session then committed `3fc3d87`, `e42a487` and `7dc704f` (prompts 14e and 15a–15f, prompt files
only) and left edits to four prompt files in the working tree. None of that is in this commit.
This report is the follow-up commit.

## What was built

- **Matchers.** `spec/types.ts`: `MATCHER_KINDS` (`string number boolean array object null any`),
  `isMatcher`, `hasKind` (`number` is finite; `any` needs the key, takes `null`). `contains` checks
  a matcher before its array and object branches; `divergence` reports a miss as
  `<path>: expected a number, got "2026-09-18"`, cut at 80. `expect` never reads `$is`.
  `validate.ts` `matcherIssues` walks every `match` (route and view steps) and refuses, with the
  path: `$is` beside another key, a kind outside the list, any other `$` key.
- **Refusals.** `RouteStep.fails: { code?, message? }` (a closed object; `message` 1–200).
  `specIssues` refuses `fails` beside `expect`/`match`, on a view step, and a code outside
  `REFUSAL_CODES`. `REFUSAL_CODES` is read at runtime from `broapp/shared`'s own `publicError`
  constructors (every public code but `internal`), not typed out: `PUBLIC_CODES` is not exported
  and `packages/broapp` could not change. `check.ts`: `stepFailure` fails a `fails` step that
  succeeded ("`items.list` succeeded with …, but the example says it is refused");
  `caughtFailure` judges a caught error; `runAcceptance` catches per step, so a passing `fails`
  step does not stop the example. `preview.try` takes `fails` and judges with the same functions.
- **The engineer is told.** `acceptance` topic: the "cannot know" clause is now "leave its key
  out of `match`, or say its kind", plus two paragraphs with an example each. `SPLIT_RULES` gains
  the two sentences. `checkbox` renders `- [ ] (when it goes wrong) <text>` (`FAILURE_MARK`);
  `builderMessage` carries `FAILURE_SENTENCE` after the ids.
- **Out:** `START_FROM_AN_EDIT` and its reserved budget. `Read:` stays.
- **Switches.** `knowledge/task-context.ts`: `task-context.json` in the launcher's data directory
  (beside `intent-models.json`), `readTaskContext`, missing/unreadable/not-`false` means on.
  `createServe({ taskContext })` reads it once per task turn; a value in `documents.attempts` or
  `corpus.related` wins. `tab.ts` passes the reader.
- Docs: `design.md` (what a check proves), `intents.md` (plan format, what a retry is told),
  `learning.md` ("Turning them off", linking 14a's and 14b's tables), three `backlog.md` rows
  (more matchers, schema-derived matchers, fuzzy time), each with the task that would justify it.

## How a refusal reaches `runAcceptance`, and what it carries

A route throws `PublicError(code, message)` in the child → `HostApp.invoke` → `run-child.ts`
reduces it with `fromTransportError` to `{ code, message }` and replies `invoke { ok: false, code,
message }` (a thrown non-public error arrives as `internal` with the fixed internal message) →
`ChildHandle.invoke` throws a `PublicError` again. Three other things also arrive as errors and are
not the route refusing: a timeout (plain `Error`), a child that died (`PublicError('unavailable',
'the application stopped …')`, thrown by the supervisor), and a paused gate. So:

1. `supervisor.ts` marks the error it builds from a reply (`refusedByRoute`); `routeRefusal`
   returns `{ code, message }` only for a marked one. A dead child or a timeout never satisfies
   `fails` ("failed with an internal error, which is not a refusal").
2. `internal` never satisfies `fails`, and `fails.code: "internal"` is refused when read.
3. **Found while writing test 7:** activation checks the candidate with its gate **paused**
   (`run-child.ts`), so every write is refused `unavailable` before the route runs. A `fails: {}`
   on a write would have passed activation because nothing could write. The pause reason is now
   `CHECKING_PAUSE_REASON` in `ipc/messages.ts`, and a refusal carrying it fails a `fails` step:
   "was not run: activation checks a paused candidate…".

**Pre-existing, not changed:** for the same reason, any example with a write step passes a preview
check and fails activation. 13c's builders write such examples; nothing has activated one yet.
`design.md` now says so. That breaks "one definition of passed" for writes, and fixing it means
deciding whether activation should run writes on the copy it is about to make live. That is not
14d's call to make.

## Format version, and an older launcher

`autoapp.json` has no version; a release's `manifest.specVersion` is always 1 and was not bumped.
- **`fails` in a workspace:** the acceptance step schema is `s.object`, which drops unknown keys.
  An older launcher builds the example without `fails`, so the step must succeed, and the refusal
  fails it. It fails. It does not pass.
- **`fails` in a release built here:** an older launcher parses it, drops `fails`, recomputes the
  identity and gets a mismatch. It refuses the release as stale, "built by an earlier version".
  That is a refusal, but the sentence has the direction wrong.
- **`$is`:** kept by `s.unknown()`. An older launcher compares it literally and the example fails
  there. As the prompt allows.

## Existing examples and templates

None changed: starter, blank, Notes and the fixture all still pass (`bun test tests` green). Two
existing assertions changed: 13a's byte-for-byte plan now shows `(when it goes wrong)` on its
failure criterion, and 14b's three `START_FROM_AN_EDIT` tests now hold the absence of any
closing instruction, with `Read:` kept.

## 13c Step 0.4's sentence

It needed rewording and was reworded. "What a route returns, or what a page declares" became
"what a route returns or refuses, or what a page declares", in both lines of `SPLIT_RULES`. The
13c test that pins "never how the code is written" still holds.

## Tests

- `autoapp-verify`: `$is` per kind × every other kind, `any`/`null` presence, NaN and Infinity,
  nesting and array length (1); `expect` literal (2); divergence text (4); `fails` pass,
  succeeded, wrong code, words, internal, dead child (5); two steps (6).
- `autoapp-spec`: matcher refusals with paths under `match` and not under `expect`/`input` (3);
  `fails` placement, codes, unknown field (5); `REFUSAL_CODES` from `broapp/shared`.
- `autoapp-activation`: the preview check and activation agree on `$is` and `fails`, passing and
  failing, including a write asserted refused on a paused candidate (7).
- `autoapp-intent-run`: mark, sentence placement, split rules (8). `autoapp-task-context`:
  no closing sentence (9); the file, read per turn, off/on/unreadable, code wins (10).

## Commands

```
bun run typecheck                                                  exit 0
bun test tests/autoapp-{spec,engineer,activation}.test.ts           pass
bun test tests/autoapp-{intent,intent-run,task-context}.test.ts     pass
bun test tests                                                     948 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher               dist/broapp-autoapp 77.7 MB
bun run scripts/autoapp-smoke.ts                                   every step passed
bun install && bun run check                                       exit 0
git diff --stat tests/ai-chat.test.ts packages/broapp              (nothing)
```

## The replays

Local Ollama `qwen3.8:27b-mlx`. Nothing left the machine and no key was entered. The script is
`tests/.autoapp-run/byhand-14d.ts`, which is 14b's harness plus three columns, and is gitignored.
The seed is 14b's `edits` snapshot, copied first to `byhand-14d/seeds/edits`: task
`0002-record-done-at`, with the person's answer about c2/c4 already in it. Runs were 18:04–18:54
UTC, in order on, off, on, off. Each printed `argv` and `switch:`, and all four matched. The
launcher was not rebuilt. No evaluation ran. The only other activity was that session writing prompt files and commits, and nothing else built or tested. So minutes are close to clean, but not certified clean. The person's
own launcher (pid 50151) sat idle on another root throughout, as in 14b.

"On" means the attempts document and tier 2 are on; "off" means both are off. The builder's
message is the same in every run, so every run got the new mark and sentence.

| run | outcome | calls | min | tokens in/out | first call | files re-read | edits repeated | docs | `$is` for `doneAt` | `fails` step | asked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| on 1 | **completed** | 10 | 9.1 | 115,630 / 13,571 | read | 3 | 0 | digest, attempts, intent, evidence | yes | no | no |
| off 1 | failed: c1–c4 failed, then idle 8 min | 10 | 18.7 | unknown | read | 4 | 0 | digest, intent, evidence | no ¹ | no | no |
| on 2 | **completed** | 8 | 12.5 | 103,511 / 14,521 | read | 3 | 0 | as on 1 | yes | no | no |
| off 2 | asked the person | 14 | 8.7 | unknown | read | 4 | 0 | as off 1 | no | no ² | yes |

¹ It tried a `$is` in `preview.try` and did not write one into `autoapp.json`. Its examples are
still the seed's literal `doneAt: 1`. ² It named `fails` in its question and wrote none.

Both completions rewrote c1–c3 with `"doneAt": {"$is": "number"}`. They wrote c4 ("a note set back
to not done does not keep an old doneAt") as an ordinary step matching `doneAt: null`. That is
right: **c4 is a failure criterion that no route refuses**. It is a bug the task must not have.
Off 2 asked exactly that: *"no route refuses this; notes.update succeeds and clears doneAt to null.
Write c4 as (a) asserting doneAt=null after done:false, or (b) a fails step on a route that refuses
it, and which route/code?"* The fixed `FAILURE_SENTENCE` says a failure criterion's example "is a
step with `fails`", which is false for this kind of criterion, and one run of four stopped on it.
14b's three "off" retries stopped to ask how to assert a number. None did here.

**What four runs can support.** One model, one seed, one task, two runs a switch.
- They **can** say that an example which says a number's kind got written. Three runs wrote or
  tried `$is` without being shown one outside the topic. Neither completed run failed on a literal
  timestamp, where all six of 14b's edits replays did.
- They **can** say that the plan's failure mark did not make any builder write a `fails` step for a
  criterion that is not a refusal. It made one of them ask whether to.
- They **cannot** say whether the task context helps. Both "on" runs completed and neither "off"
  run did, but two against two on a 27B model is variance until shown otherwise. The switch also
  moves two documents at once.
- Every retry began by reading and re-read three or four earlier files, with or without the
  closing sentence gone. That is the same as 14b.

**For a later prompt:** `FAILURE_SENTENCE` and the `SPLIT_RULES` failure line assume a failure
criterion is a refusal. 13b's rule ("what the person sees when it goes wrong") admits criteria like
this seed's c4. Either the sentence says "when a route refuses it, a step with `fails`; when it is
something that must not happen, a step showing it does not", or the split rules require a failure
criterion to name a refusal. The prompt fixed the sentence's words, so I did not change them.

## Acceptance criteria

| Criterion | Result |
|---|---|
| A kind under `match` only, closed list, misspelt refused on read | pass (1, 2, 3) |
| A route refuses by code and words; a crash is not a refusal | pass (5, 6; plus a dead child and a paused gate) |
| Every place that decides "passed" agrees on both | pass (7; `preview.try` too). Writes still differ between preview and activation, as before, see above |
| The plan marks the failure criterion; the message says how | pass (8) |
| The attempts document says what happened, not what to do | pass (9) |
| Both halves can be turned off from a file, on by default | pass (10) |
| Existing examples unchanged; `ai-chat` unchanged; no `packages/broapp` change; check green | pass |

## Decisions I made

- **The `fails` code list** comes from `publicError`'s constructors. That is the one runtime list
  `broapp/shared` exports.
- **The marker for a route's refusal** is a property on the thrown `PublicError`, read by shape.
  It is not a class, because of the boundary test.
- **The pause guard** applies to `fails` steps only. A plain step that the pause refuses reads as
  before.
- **Switch precedence** is per switch: code, then the file, then on.
- Commit trailer names Claude Opus 5, per this session's attribution rule. The report runs past
  100 lines because of the replay table and the refusal path the prompt asks for, as 12h and
  13b–14c did.
