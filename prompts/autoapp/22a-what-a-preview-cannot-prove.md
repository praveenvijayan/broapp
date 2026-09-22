# 22a — What a preview cannot prove

## Goal

On 2026-09-22 the `news` application's intent 5 — "search the web for the
latest AI news, curate it, refresh every five minutes" — ran to the end, every
task completed, seventeen checks green, and was activated. The activated
release does nothing. Three holes in the harness let it through, each on its
own enough:

- **A gate refusal satisfied `fails`.** Six of the intent's examples begin with
  `news.search` and `fails: {}`, four of them followed by `stories.list`
  matching the five sample stories. `news.search` is `external`; a preview
  refuses it before the route sees it (`decide` in
  `packages/broapp/src/host/gate.ts`), and `refusalMismatch` in
  `src/engineer/check.ts` accepted the gate's own refusal as the route's. The
  examples asserted nothing about the application and could not fail on any
  build. `verdictOf` completed the tasks on them.
- **The planner wrote criteria only activation could prove.** Task 0005's
  criteria said "start registers a `Bun.cron` job", "checked after activation,
  not in a preview", "if a scheduled run cannot reach the web". `runbookProblems`
  refuses a *runbook* line that sends the person to a preview for an
  `external` route; nothing looks at the criteria, and every criterion becomes an
  example the preview has to pass. The plan itself listed the cron and the fetch
  under `out_of_reach` and then made tasks of them.
- **An `external` route with no capability.** The contract declares
  `news.search` as `external`, the manifest's `capabilities` is `[]`, and the
  validator accepts both. `capabilityDiff` was empty, `candidate.explain` had
  nothing to say, activation asked nothing, and the person was never told the
  application reaches the web. The engineer invented `NEWS_SEARCH_ENDPOINT` and
  `NEWS_SEARCH_API_KEY` for it, which nothing in Autoapp can set.

What the engineer then did with the room — `globalThis.cron` behind a
`typeof` guard, where the task said `Bun.cron` and Bun 1.4 has it — is not a
rule the harness can write. What it can do is leave no way to pass a check
without the application doing something, tell the planner what a preview
cannot show, and make an `external` route cost a named capability. After this
prompt:

- A build refuses an acceptance step that names an `external` route, with the
  reason and what to write instead. A `fails` step on such a route is not a
  test of the route; there is no step on such a route that is.
- A plan refuses a criterion that names an `external` route the contract
  already has, or says "after activating" or "not in a preview", the way the
  runbook rule does today. What only the activated application can show goes in
  the runbook, in the words the rule names.
- A build refuses a contract with an `external` route and a manifest that asks
  for no capability, and says which kinds there are. The route is what the
  person is told about at `candidate.explain` and asked about at activation;
  the capability is how.
- The engineer is told, in the reference, that host code runs when a route is
  called and at no other time: there is no timer, no cron, no scheduled
  channel, and a call the host makes on its own clock passes no gate and is
  recorded nowhere. Work on a schedule is `out_of_reach`, said so, never
  stubbed.

Releases already built keep their examples, and activation still runs them as
it does today: `parseSpec` reads stored releases back, so neither new rule may
live in it. Both are build problems, on the specification the build has just
assembled.

## Read first

- `prompts/autoapp/00-common-rules.md`: *Effect classification*, *Policy, v1*,
  *Release identity*. The three-row policy is not reopened; a preview refusing
  `external` for everyone is the reason for this prompt, not its subject.
- `docs/autoapp/design.md` "What a check proves" and `docs/autoapp/intents.md`
  "Acceptance criteria", "What the host checks and what the model decides".
- `src/engineer/check.ts`: `stepFailure`, `refusalMismatch`, `caughtFailure`,
  `coverage`, `UNVERIFIED_BY_CHECKS`. Note the paused-child branch: a refusal
  that is not the route's already has a sentence of its own there.
- `src/intent/plan.ts`: `externalRoutes`, `routesNamedIn`, `runbookProblems`
  and the planning-problem function above them; `src/engineer/intent-tools.ts`
  `knownExternal` and where `runbookProblems` is called. The external list is
  the contract *as it stands*, so a route the plan itself introduces is not on
  it; the words are what catch that case, and the build catches the rest.
- `src/intent/executor.ts`: `verdictOf`, and the `required` examples of
  finished tasks near the end of the file.
- `src/launcher/candidate.ts`: `BuildProblem`, the `spec` stage where `draft`
  is parsed, and `failed(problems)`. `src/spec/validate.ts`: `capabilityIssues`
  and `crossCheck`, which stay as they are.
- `src/spec/capabilities.ts` and `src/launcher/activate.ts` step 1: what a
  capability does at activation, and that it does nothing at run time. A
  release is trusted local code; the capability is what the person is told,
  not a fence, and every sentence written here says so.
- `src/engineer/reference.ts`: `EXTERNAL_IN_PREVIEW`, the `acceptance` and
  `intents` topics, the `workspace` topic's `capabilities` line.
- The `news` application's release `d684241439d8e179751ce585e95eae2e` under
  the default root, `spec.json`: the examples `0003-add-search-route-c1`,
  `c2`, `0004-feed-store-and-search-c3`, `0005-schedule-feed-c1` to `c3`, and
  the manifest. Read, not copied: it is the person's data.

## Build

### `src/spec/release-problems.ts`

- `releaseProblems(spec: AppSpec): BuildProblem[]`, pure, every problem at
  stage `spec`. Two rules:
  - **A step on an `external` route.** For each acceptance example, each route
    step whose route the contract marks `external`: "example `<id>` step `<n>`
    calls `<route>`, an `external` route, which a preview refuses before the
    route sees it; no step can test it. Assert what the preview can show — the
    page, the form, a route that is not `external` — and put trying `<route>`
    in the runbook, after activating." One problem per step, in example order.
  - **An `external` route with no capability.** When any operation or stream is
    `external` and `manifest.capabilities` is empty: "the contract has
    `<route>` (and *n* more) as `external`, but `autoapp.json` asks for no
    capability. An `external` route reaches outside this machine or the data
    directory; say what it reaches — `network` with the hosts it will call,
    `files` with the paths, or `spawn` — with one sentence of reason, so the
    person is told and asked." One problem, naming every such route, sorted.
  A route on the manifest's capabilities that is not `external` is not a
  problem: asking for more than is used is the person's to notice at the grant.
- `BuildProblem` moves to `src/spec/types.ts` or this file imports it from
  `candidate.ts` without a cycle; whichever, one definition.

### `src/launcher/candidate.ts`

- After `draft` parses and before the identity is computed:
  `const problems = releaseProblems(draft); if (problems.length > 0) return
  failed(problems);`. A refused build has no `releaseId`, so nothing downstream
  sees it. `stagesRun` still says `spec` ran.

### `src/intent/plan.ts`

- `criteriaProblems(criteria, external): PlanProblem[]`, field `criteria`,
  beside `runbookProblems` and reusing `routesNamedIn`. Refused: a criterion
  that names a route in `external`, or matches the words `after activat`, `not
  in a preview`, `only after`, or `in the activated` — case-insensitive, whole
  words where the phrase has them. The message: "criterion *n* can only be
  shown by the activated application (`<route>`, an external route, which a
  preview refuses for everyone / the words "<match>"). A criterion is an
  example the preview passes. Say what the preview can show, and put the rest
  in the runbook as "after activating, …"." The one existing rule about
  runbook lines is unchanged.
- Called wherever `runbookProblems` is: `intent-tools.ts` and any other site,
  with the same `knownExternal` list. A plan problem is `ok: false` with the
  field named, as today.

### `src/intent/executor.ts`

- An example that `releaseProblems` would refuse is no longer `required` of a
  later task. Where `required` is built from finished tasks' criteria, drop an
  example whose steps name a route the release's contract marks `external`;
  `readRelease` is already in hand there. Otherwise every later task on `news`
  fails with "The example `0005-schedule-feed-c1`, from a finished task, is
  gone." the first time the builder does what the new build rule tells it.
- `verdictOf` is unchanged. A task whose criteria the planner should have
  refused, and did not because the route was new, fails honestly on "No
  example named … was run" and gets the advice turn.

### `src/engineer/reference.ts`

- `acceptance` topic: one paragraph after `EXTERNAL_IN_PREVIEW`: a step on an
  `external` route is refused by the build; what to write instead, in the
  build problem's words.
- `intents` topic: the bullet that carries `EXTERNAL_IN_PREVIEW` now says the
  same of a *criterion*, and the words the rule refuses.
- `workspace` topic, after the `capabilities` line: an `external` route needs a
  capability, the three kinds, one sentence each, and that it is what the
  person is told and asked, not what the child enforces. Then the paragraph on
  time: host code runs when a route is called and at no other time; no timer,
  no cron, no scheduled channel; a call the host makes on its own clock passes
  no gate, is recorded in no run, and cannot be checked; a request for work on
  a schedule is `out_of_reach`, said so in `intent.open`, and never a task
  that ships a guard around it. Name `Bun.cron` as the thing not to reach for.
- `contract` topic: one line, `external` means a capability in `autoapp.json`.

### `src/engineer/instructions.ts`

- One bullet under *What you may not do*: "Do not guard a call on an API with
  `typeof` so that a feature silently does nothing. An API the runtime has is
  called; one it lacks is a build problem, or out of reach — say which." Stay
  at seventy-two lines: rewrap, do not cut what was measured.

### `src/engineer/tools.ts`

- `candidate.explain`: when the built contract has `external` routes, name
  them in the same breath as the capabilities they cost — "`news.search` is
  external and asks for `network: api.example.com`" — so the two paragraphs the
  engineer writes carry both. No new field on the result if the existing ones
  can say it; otherwise one, `externalRoutes`, documented.

### Tests

- `tests/autoapp-spec.test.ts`: `releaseProblems` — a step on an `external`
  route, one per step, in order; a `fails` step is not exempt; a view step is
  never a problem; an `external` route with no capability, every route named;
  a `write` route with no capability is fine; a manifest with a capability and
  no `external` route is fine; `parseSpec` still reads the `news` release's
  shape with those examples in it (a fixture built from the shape, not the
  file).
- `tests/autoapp-intent.test.ts`: `criteriaProblems` — a route known
  `external`; each phrase; `image.remove` not found in `image.removeAll`; a
  criterion that names a `read` route and the word "preview" is fine; the
  runbook rule unchanged.
- `tests/autoapp-intent-run.test.ts`: a finished task's example on an
  `external` route is not required of the next task; one that is not `external`
  still is.
- `tests/autoapp-engineer.test.ts`: `candidate.cycle` on a workspace whose
  `autoapp.json` has a step on an `external` route reports the `spec` problem
  and builds nothing; the same for the capability; the instructions at
  seventy-two lines; the reference topics carry the new sentences by a fixed
  fragment each.
- The existing candidate, activation and recover suites unedited and green: a
  stored release with such examples still reads, activates and rolls back.

### Documents

`docs/autoapp/design.md` "What a check proves": the paragraph on `external`
routes and the build. `docs/autoapp/intents.md` "Acceptance criteria" and "What
the host checks and what the model decides": the criteria rule beside the
runbook rule. `docs/autoapp/security.md`: under "The one door" or "Approvals",
that an `external` route costs a named capability, and that the capability is
told and asked, not enforced. `docs/autoapp/backlog.md`: one row, **A
scheduled channel** — a fourth channel in the gate policy (`confirm` for `write`
and `external`, like `workflow`), a cadence the person sets and sees, runs
recorded like any other, and no timer inside `start` until then; and one row,
**A criterion the plan itself makes `external`**, on the gap between
`knownExternal` and a route a task declares. `docs/troubleshooting.md`: the two
build problems, in their own words. `prompts/autoapp/README.md`: the 22a row.

## Not in scope

- Enforcing a capability at run time. The child is trusted local code; a fence
  is a different design and a different prompt.
- A scheduled channel. The backlog row says what it would take.
- Any change to `packages/broapp`: the gate's sentence is not matched by text
  anywhere, because the build refuses the step before the gate could.
- Repairing the `news` application. Its next build will report six refused
  steps and one missing capability, and its engineer will be told what to do;
  the report records what it says, and nothing under the default root is
  edited by hand.

## Report

`prompts/autoapp/reports/22a-what-a-preview-cannot-prove.md`: the exact
problems a build of the `news` workspace at `8e90a79` reports, verbatim; what
`intent.task` says to task 0005's three criteria as they were written, and to
0004's third; the instructions' line count and where the bullet went; how
`required` was filtered and why in the executor and not the verdict; anything
in *Fixed decisions* found wrong, with what was done instead.

## Commit

```
Refuse a check that cannot fail, and name what an external route costs

An acceptance step on an external route was satisfied by the preview's
own refusal, so five examples on the news application asserted nothing
and completed three tasks. The build now refuses such a step and says
what to assert instead; a plan refuses a criterion that only the
activated application could show, as it already refused a runbook line;
a finished task's example on such a route is no longer required of the
next. A contract with an external route and no capability is refused
too, naming the kinds, so the person is told and asked at activation.
The reference says host code runs when a route is called and at no
other time, and that work on a schedule is out of reach. Releases
already built read, activate and roll back as before.
```

End the commit with the co-author trailer your session's rules give you.
