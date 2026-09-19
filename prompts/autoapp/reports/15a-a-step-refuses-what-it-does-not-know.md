# 15a — A step refuses a field it does not know

## Step 0 — before any change

Written before any code changed.

### 1. Every `autoapp.json`, and the keys its examples use

Scanned with a script (scratchpad, not committed) over every `**/autoapp.json` and every
`**/releases/*/spec.json` under `templates/`, `examples/`, `tests/` (the fixture and every
`tests/.autoapp-run` root still on disk), the real launcher root
(`~/Library/Application Support/broapp-autoapp`, read only) and the one other root on this
machine (`~/works/autonewsapp/run/autoapp`, read only).

| where | files | examples | steps | example keys | step keys | `view` keys |
|---|---|---|---|---|---|---|
| repository | 879 | 2,921 | 4,183 | `id` `title` `steps`, **`failure` ×10** | `route` `input` `expect` `match` `view` | `page` `component` `match` `exists` |
| real root | 47 | 173 | 225 | `id` `title` `steps` | `route` `input` `expect` `match` `view` | `page` `component` `match` |
| autonewsapp root | 9 | 30 | 32 | `id` `title` `steps` | `route` `input` `expect`, **`expectError` ×1** | — |

Two findings; the lists were not widened for either.

- **`failure: true` on an example**, ten times, all in the source workspaces of the 14b and
  14d by-hand roots (`byhand-14b/{seeds,runs/*}/…/notes/source/autoapp.json`,
  `byhand-14d/{seeds,runs/edits-off-*}/…`), example `0002-record-done-at-c4`. A builder copied
  the plan's `failure` flag from the criterion onto the example. It meant nothing: the step it
  sits beside matches `doneAt: 1`, and the flag was dropped when read.
- **`expectError` on a step**, once: `autonewsapp/run/autoapp/apps/notes/source/autoapp.json`,
  example `rejects-bad-url`, written before `fails` existed. Read today, the step asserts
  nothing and passes whenever `notes.create` succeeds — exactly the fault this prompt is about.
  It never reached a release: none of that application's eight releases holds the example.
  After this prompt a build of that workspace is refused at `spec` with
  `acceptance[3].steps[0]: unknown field "expectError"` (no suggestion: `expect` is five edits
  away, `fails` further).

Neither is in a template, an example application or a test fixture. No release `spec.json`
anywhere carries a key outside the lists.

### 2. Every `parseSpec` caller, and what a refusal does there

| caller | reads | a refusal there |
|---|---|---|
| `launcher/candidate.ts` `buildCandidate` | the workspace's `autoapp.json`, assembled | a build problem at stage `spec`, `acceptance[<i>].steps[<j>]: unknown field "…"; did you mean "…"?`, shown by `candidate.build`/`cycle`, the panel and `build` |
| `spec/store.ts` `writeRelease` (read-back) | the file it has just written | cannot happen: it writes the draft `buildCandidate` already parsed |
| `spec/store.ts` `readSpecFile` → `readRelease`, `listReleases` | a stored release's `spec.json` | `readRelease` throws (child start, keepalive, activation, control, tools); `listReleases` skips the release |

The third row is the one Step 0.2 asks about, since it reads **activated** releases. It
cannot refuse one a launcher wrote. `writeRelease` has one production caller,
`buildCandidate`, which writes the output of `parseSpec`; `s.object` had already dropped every
unknown key, and the identity is computed over that output. So no stored `spec.json` can hold a
stray acceptance key, and the scan above confirms it for all 926 on this machine. The only way
one appears is by hand-editing a release directory, which the design already treats as not a
release (a hand edit that changes the hash reads `stale` and is refused). **Not a stop.** The
report says so under "Deviations" as well.

### 3. A candidate built before this prompt, with a stray key, activated after it

It is not refused at activation, and nothing is said. The key never reached the release: the
build that made the candidate parsed `autoapp.json`, dropped the key, hashed and stored what
was left. Activation reads the stored `spec.json` (`readRelease` in `activate.ts`), which parses
cleanly, and 14e runs the example on `data-check` without the assertion. So the refusal arrives
neither at the examples' child ("the candidate would not run the acceptance examples: …") nor
earlier; it cannot arrive at all, because the thing to refuse is not in the release. The
previous release keeps serving until the switch, as always, and the switch happens if the
weakened example passes.

The refusal happens at the next **build** of that workspace, in a sentence naming the key. That
is where the fixed decisions put it ("When the specification is read, by `parseSpec` … Not at
check time: by then the key is already gone"), and the prompt's own reason applies one step
further out: by activation the key is gone too. Rebuilding is the remedy: the same workspace now
fails at `spec`, names the key, and cannot become a candidate until it is fixed.

## What was built

- `spec/validate.ts`: `editDistance` and `unknownField`, the one helper `closed` uses for
  every caller. A key within two edits of an allowed one gets `; did you mean "<key>"?`; ties go
  to the first allowed key in list order; nothing is suggested past two. `EXAMPLE_FIELDS`,
  `STEP_FIELDS`, `VIEW_STEP_FIELDS` and `FAILS_FIELDS` are constants beside the schema, as
  `CAPABILITY_FIELDS` is. The example, the step and the step's `view` are wrapped in `closed`;
  `input`, `expect` and `match` stay `s.unknown()`.
- `engineer/reference.ts`: one sentence in `ACCEPTANCE`, after the `fails` paragraph: an
  example holds only `id`, `title` and `steps`, a step only the keys named above, and a key it
  does not know is refused when the specification is read. `instructions.ts` untouched.
- `docs/autoapp/backlog.md`: one row listing what is still open.
- Tests: six in `tests/autoapp-spec.test.ts` (the prompt's 1–6), one in
  `tests/autoapp-verify.test.ts` (the reference sentence). Run on the code as it stood, 1, 2, 4
  and 6 failed and 3 and 5 passed, which is right: 3 and 5 say what must not change.

A refusal reads, through `ValidationError`'s own formatting:
`acceptance[0].steps[0]: unknown field "fail"; did you mean "fails"?`, and a build shows it as a
`spec` problem with that text.

## Every `parseSpec` caller

The table under Step 0.2 is the answer; nothing changed it. The build is the only place a
person will meet the new refusal. Every reader of a stored release (`readRelease`: the child's
start, keepalive, activation, control, the engineer's tools, the knowledge path, the harness;
`listReleases`: the panel and `releases`) would refuse or skip a release whose `spec.json` held
a stray acceptance key, and none on this machine does or can, because each was written from a
parsed draft.

## Is the JSON schema closed

It already said so, and was wrong until now. `s.object`'s `toJsonSchema` emits
`additionalProperties: false` for every object, and `closed` passes the inner schema through
unchanged, so the three objects' schemas are what they were; the difference is that parsing now
agrees with them. No other object's schema changed, and nothing in `packages/broapp` changed.
The one place an engineer is handed this shape as a JSON schema is `preview.try`, whose step is
its own `s.object` in `engineer/tools.ts`: its schema says closed and its parse still drops. It
is a tool input rather than a specification, so it is listed in the backlog row, not changed.

## Still open in the specification

The top level; `manifest`, `runtime`, `entry`; `contract` and each exported route; each
migration; each `workflows` entry; the grants file; every object of the view specification
(page, source, component, column, field, action); and `preview.try`'s step. One backlog row,
"Most of a specification still drops a key it does not know", with the view specification
first, since the engineer writes it by hand.

## An older launcher and a new field

14d's finding stands and nothing here can reach it: a launcher built before this prompt still
reads acceptance through an `s.object` that drops unknown keys. Given a workspace with `fails`
it builds the example without it, so the step must succeed and the route's refusal fails it:
the example fails rather than passing. Given a release built here that carries `fails`, it drops
the key, recomputes the identity, gets a mismatch and refuses the release as stale, "built by
an earlier version", which is a refusal with its direction wrong. And given a misspelt key, an
older launcher still drops it silently. What this prompt changes is only that a launcher from
now on refuses such a key with a sentence rather than dropping it; there is no format version,
because every example that was valid and meant something still parses to the same thing.

## Deviations, and decisions I made

1. **Step 0.2 is not a stop, though a reader of activated releases does call `parseSpec`.**
   `readSpecFile` parses every stored `spec.json`, including the one an application is running,
   and a refusal there would stop it from starting or listing. It cannot happen for a release
   any launcher wrote: the only writer stores the parsed draft, with unknown keys already
   dropped. The scan of 926 release and workspace files on this machine found none. A release
   directory edited by hand could now be refused where it was quietly read before; the design
   already treats a hand-edited release as not a release.
2. **Step 0.3: nothing refuses a candidate built before this prompt.** Its stray key was dropped
   when it was built, so activation never sees it and says nothing; the previous release serves
   until the switch as always. A rebuild of the workspace is refused with the key named. This is
   where the fixed decisions put the refusal, not a substitute for it.
3. **Two Step 0 findings outside the test tree's templates**, not admitted to any list:
   `failure` on ten by-hand examples (14b and 14d roots), and `expectError` on one example in
   `~/works/autonewsapp/run/autoapp/apps/notes/source`. The second is an example that has been
   asserting nothing; its next build will say so. Neither was edited.
4. **Test 5 stands in a contract and pages for each `autoapp.json`.** A workspace manifest is
   half a specification; the build supplies the rest. The test adds every route and page the
   examples name, so it checks the examples, the migrations and the capabilities of the four
   files through the real `parseSpec`. The starter, blank, Notes and fixture builds in the rest
   of the suite and the smoke are the full-build evidence.
5. **Test 4 shows both halves of the probe**: the misspelt step no longer parses, and the step
   the old parser handed on (key dropped) passes `runAcceptance` against a route that succeeds.
6. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Commands run

```
bun run typecheck                                                   exit 0
bun test tests/autoapp-spec.test.ts (before the change)             48 pass, 4 fail (tests 1, 2, 4, 6)
bun test tests/autoapp-spec.test.ts tests/autoapp-engineer.test.ts \
  tests/autoapp-activation.test.ts tests/autoapp-verify.test.ts     165 pass, 0 fail
bun test tests                                                      965 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 77.7 MB, exit 0
bun run scripts/autoapp-smoke.ts                                    every step passed
bun run check                                                       exit 0, 965 pass, 0 fail
git diff --stat tests/ai-chat.test.ts packages/broapp               (nothing)
```

Nothing was running from `dist/broapp-autoapp` before the first build (`ps` found no launcher,
child or evaluation).

## Acceptance criteria

| Criterion | Result |
|---|---|
| No acceptance example, step or `view` parses with a key outside its list | pass (tests 1, 2, 4) |
| The refusal names the key, its path, and the key probably meant | pass (tests 1, 2, 6) |
| Every existing specification in the repository parses unchanged | pass (test 5; suite and smoke build the starter, blank, Notes and fixture) |
| No application already activated stops working because of this | pass (Step 0.2: no stored release can carry the key; none on this machine does) |
| No change to `packages/broapp`; `ai-chat` unchanged; `bun run check` green | pass |
