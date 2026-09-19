# 15a — A step refuses a field it does not know

## Goal

14d gave a route step `fails` and gave `match` the `$is` matcher, and its
Compatibility row rested on a condition it did not check: "If the acceptance
schema is strict (unknown keys refused), that already holds for `fails`". It is
not strict. The step in `spec/validate.ts` is an `s.object`, and `s.object`
drops every key it was not told about. A probe on 2026-09-18:

```ts
s.object({ route: s.optional(s.string()) }).parse({ route: 'a.b', bogus: { x: 1 } })
// → {"route":"a.b"}
```

So a step written `{"route": "items.add", "input": {…}, "fail": {"code": "invalid_input"}}`
— one letter short — parses to a step with no assertion at all, runs the route,
and passes when the route succeeds. 14d closed the object *inside* `fails`; the
step around it, the `view` object and the example itself are still open. An
example that asserts nothing and passes is the worst thing this file can let
through, because the verdict in `intent/executor.ts` counts it as a criterion
met.

After this prompt an acceptance example, each of its steps and a step's `view`
refuse a key they do not know, with the key and its path.

Run this after 14e is merged: both are held by `tests/autoapp-activation.test.ts`,
and 14e changes where activation reads and runs the examples.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 12d (decision 6), 14d in full —
  above all what it found about a specification's format version — and 14e
  (where activation now runs the examples).
- `packages/broapp-autoapp/src/spec/validate.ts` in full: `closed` (line ~131),
  how `capability` uses it, the `acceptance` schema (line ~196), `crossCheck`,
  `parseSpec`, and whatever produces the JSON schema the engineer is shown.
- `packages/broapp-autoapp/src/spec/types.ts`: `AcceptanceExample`, `RouteStep`,
  `ViewStep`, `SPEC_VERSION`.
- Every caller of `parseSpec` and of the acceptance schema. For each, what a
  refusal does there: a build problem, an activation refusal, a launcher that
  cannot list an application, a release that is already running.
- `packages/broapp-autoapp/src/engineer/reference.ts`: the `ACCEPTANCE` topic.

## Step 0 — before any change

1. List every `autoapp.json` the repository holds (templates, examples, test
   fixtures, `tests/.autoapp-run` roots that still exist) and every key their
   acceptance examples, steps and `view` objects use. Any key outside the lists
   below is a finding: report it, do not widen the list to admit it.
2. For each `parseSpec` caller, write down what the person sees when the
   specification is refused. If any caller reads the specification of a release
   that is **already activated** and a refusal there would stop that application
   from starting or listing, stop and report it as a deviation before going on:
   an application somebody is using must not stop working because its example
   has a stray key.
3. The other side of that: a candidate **built before this prompt** with a stray
   key in a step, and activated after it. 14e runs its examples on `data-check`
   before the switch. Say what the person is told and confirm the previous
   release is still serving. 14e's report says a throw while starting that
   child reads "the candidate would not run the acceptance examples: …"; find
   out whether the refusal arrives there or earlier. Refusing it is right; it
   must be said in a sentence that names the key, not as a failed example.

## Fixed decisions

| Decision | Value |
|---|---|
| What is closed | Three objects, with `closed`: the example (`id`, `title`, `steps`); the step (`route`, `input`, `expect`, `match`, `fails`, `view`); the step's `view` (`page`, `component`, `exists`, `match`). `fails` is already closed. The allowed lists are constants beside the schema, as `CAPABILITY_FIELDS` is, not retyped at the call. |
| What stays open | `input`, `expect` and `match` are the application's own values: whatever keys they hold are theirs. `matcherIssues` already polices `$` keys inside `match`. |
| The sentence | `unknown field "fail"` at the step's path is what `closed` says today. Add the nearest allowed key when one is within an edit distance of 2: `unknown field "fail"; did you mean "fails"?`. One helper, used by `closed` for every caller, capability included. No suggestion when nothing is near. |
| Where it is refused | When the specification is read, by `parseSpec`, so a build reports it as a problem with the lines it points at, as it does every other specification issue. Not at check time: by then the key is already gone. |
| The JSON schema the engineer sees | `closed` keeps `inner.toJsonSchema()`. If that schema can say `additionalProperties: false` for these three objects without changing any other object's, say it; if it cannot without touching `packages/broapp`, leave it and say so in the report. No change to `packages/broapp`. |
| Compatibility | No format version bump: every example that was valid and meant something is still valid and means the same. An example that carried a stray key was already being read wrongly; it is now refused with a sentence. An older launcher still drops unknown keys, which no change here can reach — restate 14d's finding in one paragraph of the report, with what an older launcher does with `fails` given this. |
| The reference topic | One sentence in `ACCEPTANCE`: a step holds only the keys listed; a key it does not know is refused when the specification is read. The engineer's instructions are capped by a test: add nothing there. |
| Not in scope | Closing any other object in the specification (list the open ones in the report, with a row in `docs/autoapp/backlog.md`); a format version; migrating anybody's `autoapp.json`; any change to `check.ts`. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-spec.test.ts tests/autoapp-engineer.test.ts tests/autoapp-activation.test.ts tests/autoapp-verify.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside the ones 14d added to `tests/autoapp-spec.test.ts`:

1. A step with `fail`, with `expects`, with `matches` and with `bogus` is each
   refused, the issue's path is the step's, and the first three name the key
   that was meant.
2. An example with a key beside `id`, `title`, `steps` is refused; a `view`
   with `components` is refused and names `component`.
3. Keys inside `input`, `expect` and `match` are never refused by this rule.
4. The probe above, as a test: a step with a misspelt `fails` against a route
   that succeeds no longer parses, so it can no longer pass.
5. Every `autoapp.json` in the templates and the examples still parses.
6. A capability with a stray key still says what it said, plus the suggestion
   when one is near.

## Acceptance criteria

- No acceptance example, step or `view` parses with a key outside its list.
- The refusal names the key, its path, and the key that was probably meant.
- Every existing specification in the repository parses unchanged.
- No application that is already activated stops working because of this.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/15a-a-step-refuses-what-it-does-not-know.md`: Step 0's
three findings; every `parseSpec` caller and what a refusal does there; whether the
JSON schema now says the objects are closed; which other specification objects
are still open; what an older launcher does with a new field.

## Commit

```
Refuse a field an acceptance step does not know

The step's object parser dropped unknown keys, so a step with a misspelt
fails or match parsed to a step that asserts nothing and passed whenever
its route succeeded. An example, a step and a step's view are now closed,
as a capability already was, and the refusal names the key that was
probably meant.
```

End the commit with the co-author trailer your session's rules give you.
