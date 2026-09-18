# 14d — An example can say "some number" and "this is refused"

## Goal

14b's ten replays found that the task it measured could not pass, with or
without the task context, for a reason nobody had looked at. The task records a
`doneAt` time. An acceptance step's `match` lets an example leave a key out, but
it cannot say "this key is there and is a number": a value is compared exactly
or not at all. All three retries without the documents stopped to ask how to
assert a number of unknown value; all three with them wrote a literal timestamp,
failed on it, and went silent.

Reading the step schema for this prompt found the second half. A route step
"must succeed": there is no way for an example to assert that a route *refuses*.
Yet `validateTask` requires every task to carry a criterion with `failure: true`
(or a `no_failure_path`), and the verdict requires a passing example named
`<slug>-c<n>` for every criterion. So a failure criterion that means "an empty
title is refused" has no honest example at all. 14b's seed shows what a builder
does with that: twice it stopped to say criteria c2 and c4 contradict each
other. They do not; it had no way to write c4.

After this prompt an example can assert the kind of a value it cannot predict,
and can assert that a route refuses and with what. The builder is told what a
failure criterion is and how to write its example. And the one sentence 14b
measured and found ignored comes out.

Run this after 14c is merged: both touch `attempts.ts` and `builderMessage`.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 12d (decision 6, one definition
  of "passed"), 13c (Step 0.4, what a criterion may be), 14b in full, 14c.
- `packages/broapp-autoapp/src/engineer/check.ts` in full: `contains`,
  `stepFailure`, `divergence`, `viewFailure`, `runAcceptance`. Every caller that
  decides "passed" comes through here; keep it that way.
- `packages/broapp-autoapp/src/spec/validate.ts` around the acceptance schema
  (line ~196) and `specIssues`, which already refuses a step that is both a
  route step and a view step; `spec/index.ts` for `AcceptanceExample`,
  `RouteStep`.
- How a route's refusal reaches `runAcceptance` today: what the child returns
  for a `PublicError` (code and message), and the list of public error codes in
  `packages/broapp/src/shared`. Read, do not change.
- `packages/broapp-autoapp/src/engineer/reference.ts`: the `ACCEPTANCE` topic.
- `packages/broapp-autoapp/src/intent/plan.ts`: `validateTask`'s failure rule
  (line ~179), `checkbox`, `renderPlan`, `SPLIT_RULES`; `intent/executor.ts`
  `builderMessage`; `engineer/intent-tools.ts` where the `intent.task`
  description is assembled.
- `packages/broapp-autoapp/src/knowledge/attempts.ts`: `START_FROM_AN_EDIT`.
- The starter and blank templates' `autoapp.json` acceptance examples, and the
  Notes example's.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. A value's kind, under `match` only | Inside a `match` (route step or view step), a value that is an object with exactly one key, `$is`, is a matcher, not a literal. `$is` is one of a closed list: `string`, `number`, `boolean`, `array`, `object`, `null`, `any` (`any`: the key is present, whatever it holds, `null` included). `number` means a finite number. Nothing else: no ranges, no patterns, no lengths, no "non-empty" — each of those is a way for an example to pass on the wrong output, and the list can grow when a real task needs it. `contains` handles it in one place, before its array and object branches. `expect` stays a literal deep-equal and never reads `$is`: an example that wants exactness keeps it. |
| A matcher that is misspelt is refused, not ignored | `specIssues` walks every `match` and refuses, with the step's path: an object with a `$is` key and any other key; a `$is` value outside the list; any other key starting with `$` (reserved, so a later matcher cannot change the meaning of an example already written). A real output that holds a literal `{"$is": …}` cannot be matched literally under `match`; use `expect`. Say so in the reference topic, in one sentence. |
| The failure message | `divergence` reports a matcher miss as `<path>: expected a number, got "2026-09-18"` — the kind wanted and the value got, cut at 80. This is the line a builder repairs from. |
| 2. A route step may assert a refusal | New optional field on a route step: `fails: { code?: string, message?: string }`. With `fails`, the step passes only if the route refuses: a success is the failure "`items.add` succeeded with …, but the example says it is refused". `code`, when given, must equal the public error's code, and must be one of the public codes (validated by `specIssues` against the real list, imported, not retyped). `message`, when given, must be contained in the refusal's message, case-sensitive, 1–200 characters. `fails: {}` asserts only that it refuses. A step with `fails` may not carry `expect` or `match`; a view step may not carry `fails`. An internal error (not a `PublicError`) never satisfies `fails`: a crash is not a refusal, and the message says "failed with an internal error, which is not a refusal". |
| Steps after a refusal | An example's steps run in order as today; a `fails` step that passes does not stop the example, so "refused, and the list is unchanged" is two steps. |
| One definition of passed | `candidate.check`, activation, replay and evaluate all reach this through `runAcceptance`, so they all get both changes at once. Add the assertion to the existing test that holds them to one definition rather than writing a second. |
| Compatibility | Additive: every example that exists today means what it meant. Check whether `autoapp.json` or a release carries a format version that an older launcher reads; an older launcher given `fails` or `$is` must refuse the specification with a sentence, not pass the example by ignoring the field. If the acceptance schema is strict (unknown keys refused), that already holds for `fails`; `$is` inside `match` is `unknown` to the schema, so an older launcher would compare it literally and the example would simply fail there — acceptable, and say so in the report. |
| 3. The engineer is told | `ACCEPTANCE` topic: two short paragraphs with one example each — a `match` with `"doneAt": {"$is": "number"}`, and a two-step refusal example (`fails` with a code, then a list step showing nothing changed). Replace the clause "for outputs with ids and timestamps an example cannot know" with the two choices: leave the key out, or say its kind. The engineer's instructions are capped by a test: add nothing there; the topic is where this lives. |
| 4. A failure criterion says what it is | `checkbox` renders a criterion with `failure: true` as `- [ ] (when it goes wrong) <text>`. `builderMessage` gains one sentence after the ids: "A criterion marked (when it goes wrong) is not in conflict with the others: its example is a step with `fails`, showing the route refuses, and the others show what happens when it does not." `SPLIT_RULES` (and so the `intents` topic and the `intent.task` description) gains: a failure criterion names the route that refuses and what the person is told; a criterion about a value nobody can know in advance (a time, an id) says what kind of value it is, not what it equals. No new host check on criterion text: it is not checkable. |
| 5. The closing sentence comes out | Remove `START_FROM_AN_EDIT` and everything that reserves room for it. 14b delivered it twice; both times the first call was a read of a file it named, and those were the silent seed's only two failures. `Read:` stays: it is information, one line, and costs nothing. Update `intents.md` "What a retry is told" and the tests that hold the sentence. |
| 6. The task context can be turned off | 14a and 14b between them give no run in which the attempts document or the related-by-file lessons helped, on one local 27B model, and no measurement on any other. They stay on. But a person can turn each off without a rebuild: `task-context.json` in the launcher's data directory, `{ "attempts": boolean, "related": boolean }`, read as `intent-models.json` is (missing or unreadable means both `true`), applied where `tab.ts` builds `documents` and `corpus`, re-read per turn. A `serving` override given in code (replay, evaluate, the by-hand scripts) wins over the file. One paragraph in `learning.md` with the two measurements' tables linked, saying what is and is not known. No panel control. |
| Not in scope | Any other matcher; schema-derived matchers ("matches the route's output schema"); fuzzy time ("within a minute of now"); asserting logs or side effects; view steps that render; a panel control for decision 6; changing `validateTask`'s failure rule; changing the verdict. Rows in `docs/autoapp/backlog.md` for the first three, each with the task that would justify it. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-spec.test.ts tests/autoapp-engineer.test.ts tests/autoapp-activation.test.ts
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts tests/autoapp-task-context.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside the ones that already cover `contains` and `stepFailure`:

1. `contains` with `$is`: each kind against a value of that kind and of another;
   `any` against a present `null` and against a missing key; `number` against
   `NaN` and `Infinity`; nested inside an object and inside an array element;
   the array-length rule unchanged.
2. `expect` with a `{"$is":"number"}` value compares literally: it fails against
   `5` and passes against the literal object.
3. `specIssues`: `{"$is":"numbr"}`, `{"$is":"number","x":1}` and `{"$gt":3}`
   inside a `match` are each refused with the step's path; the same objects
   under `expect` and under `input` are not.
4. `divergence` names the path, the kind wanted and the value got.
5. `fails`: a refusing route passes; a succeeding route fails with the sentence;
   a wrong `code` fails naming both codes; a `message` not contained fails; an
   internal error fails as "not a refusal"; `fails` with `expect`, with `match`,
   and on a view step are refused by `specIssues`; an unknown `code` is refused.
6. Two steps: `fails`, then a list step that must still match — the example
   passes only when both hold.
7. The one-definition test: an example using `$is` and `fails` gets the same
   result from `candidate.check` and from activation's check.
8. `renderPlan` marks a failure criterion; `builderMessage` carries the
   sentence; `SPLIT_RULES` carries its two.
9. `attemptsDocument` never ends with a closing sentence; `Read:` still there.
10. `task-context.json`: missing means both on; `{"attempts":false}` withholds
    the `attempts:` ref from a retry; `{"related":false}` withholds tier 2; an
    unreadable file means both on; a `serving` override wins.

By hand, from 14b's **edits** snapshot (`tests/.autoapp-run/byhand-14b/seeds/edits`
— keep a copy; if it is gone, say so and remake it as 14b did), same local
model, machine otherwise idle, nothing else building the launcher: four
replays, two with the task context on and two with both off, switch printed and
checked as 14b did. Record 14b's columns, plus: whether the builder used `$is`
for `doneAt`, whether it wrote a `fails` step for the failure criterion, and
whether it asked the person anything. The question this answers is narrow:
with an example that *can* be written, does the retry complete. Four runs;
say what they can and cannot support.

## Acceptance criteria

- An example can assert that a value is present and of a kind without knowing
  it, under `match` only, from a closed list, and a misspelt matcher is refused
  when the specification is read.
- An example can assert that a route refuses, by code and by words, and a crash
  does not count as a refusal.
- Every place that decides "passed" agrees on both.
- A builder's plan marks which criterion is the failure path, and its message
  says how to write that example.
- The attempts document tells a retry what happened and no longer tells it what
  to do.
- The attempts document and the related lessons can each be turned off from a
  file, and are on by default.
- Every existing example passes unchanged. `tests/ai-chat.test.ts` unchanged;
  no change to `packages/broapp`; `bun run check` green.

## Report

`prompts/autoapp/reports/14d-examples-that-can-say-it.md`: how a refusal
reaches `runAcceptance` and what it carries; whether a specification has a
format version and what an older launcher does with each new field; every
existing example or template you changed to use the new forms (change none you
do not have to); the four replays with their caveats; and whether 13c's Step 0.4
sentence ("a criterion says what a route returns or what a page declares") now
needs rewording to admit what a route refuses.

## Commit

```
Let an example say "some number" and "this is refused"

Under match a value may be {"$is": "number"} and the like, from a closed
list, checked when the specification is read; a route step may carry fails,
passing only when the route refuses, by code and by words, and never on a
crash. A plan marks its failure criterion and the builder is told its
example is a step with fails. The attempts document no longer ends by
telling a retry what to do, which two retries ignored, and the task context
can be turned off from a file.
```

End the commit with the co-author trailer your session's rules give you.
