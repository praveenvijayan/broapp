# 22a — What a preview cannot prove

## What was built

- `src/spec/release-problems.ts`: `releaseProblems(spec)`, which is pure. Every
  problem it returns is at stage `spec`. It holds two rules. First, one problem
  for each route step on an `external` route, in example order, with `fails`
  steps counted and view steps never counted. Second, one problem when a
  contract has an `external` route and the manifest's `capabilities` is empty.
  That problem names every such route, sorted. `externalRoutes` moved into the
  same file, so it has one definition, and `intent/plan.ts` re-exports it.
  `examplesOnExternal(spec)` gives the ids of the examples the first rule
  refuses, for the executor.
- `BuildProblem` now lives in `src/spec/types.ts`, and `candidate.ts`
  re-exports it. That leaves one definition and no import cycle.
- `buildCandidate` calls `releaseProblems(draft)` after the specification
  parses and before the release gets an identity. A refused build has no
  `releaseId`, and `stagesRun` still includes `spec`. `parseSpec` did not
  change.
- `criteriaProblems(criteria, external)` in `src/intent/plan.ts` sits beside
  `runbookProblems` and uses `routesNamedIn`. `intent.task` calls it with the
  same `knownExternal` list, which it now reads once per call. That was the
  only place `runbookProblems` was called.
- `finishedExamples` in the executor drops an example that has a step on an
  `external` route of the release its task completed at (`task.releaseId`). It
  reads each release once and keeps it in a cache.
- `candidate.explain` gained one field, `externalRoutes`. It holds one sentence
  per `external` route, for example "`items.ping` is external and asks for
  network: example.com". The tool description tells the engineer to say it in
  the same breath as the permissions.
- `reference.ts` gained three new constants: `EXTERNAL_STEP` (in the
  `acceptance` topic, after `EXTERNAL_IN_PREVIEW`), `EXTERNAL_CRITERION` (a
  bullet in `SPLIT_RULES`, so the `intents` topic and the `intent.task`
  description both carry it) and `HOST_TIME` (in the `workspace` topic, after
  the capability kinds). The `contract` topic gained one line.
- The docs, the backlog rows and the README row are as the prompt lists them.

## A build of `news` at `8e90a79`

The build ran on a copy made with `git archive` in the session's scratch
directory. Its `node_modules` was a symlink to the workspace's own, and the
launcher root was a throwaway one. Nothing under the default root was touched.
All five stages ran, and the build returned these problems, verbatim:

```
spec: example `0003-add-search-route-c1` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: example `0003-add-search-route-c2` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: example `0004-feed-store-and-search-c3` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: example `0005-schedule-feed-c1` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: example `0005-schedule-feed-c2` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: example `0005-schedule-feed-c3` step 1 calls `news.search`, an `external` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not `external` — and put trying `news.search` in the runbook, after activating.
spec: the contract has `news.search` as `external`, but `autoapp.json` asks for no capability. An `external` route reaches outside this machine or the data directory; say what it reaches — `network` with the hosts it will call, `files` with the paths, or `spawn` — with one sentence of reason, so the person is told and asked.
```

That is six refused steps and one missing capability, which is what the prompt
predicted. The stored release `d684241…` still reads. The tests hold this with
a fixture of the same shape, not with the release file itself.

## What `intent.task` says to the criteria as they were written

The criteria were read from `launcher/intents.sqlite` through a read-only
connection. Intent 5 added `news.search` in its own task 0003. So when 0004 and
0005 were planned, `knownExternal` (the serving contract) did not include the
route. Only the words could catch those criteria. Both lists are shown below.

**As planned, `knownExternal = []`:**

- 0004 c3 ("…in a preview news.search is refused as external, so the list is
  unchanged and the person is told it runs after activation."):
  > criterion 3 can only be shown by the activated application (the words
  > "after activation"). A criterion is an example the preview passes. Say what
  > the preview can show, and put the rest in the runbook as "after
  > activating, …".
- 0005 c1 ("start registers a Bun.cron('*/5 * * * *') job…"): **no
  problem.**
- 0005 c2 ("…checked after activation, not in a preview."):
  > criterion 2 can only be shown by the activated application (the words
  > "after activation"). …
  (The same sentence as above. The first phrase matched is the one quoted.)
- 0005 c3 ("If a scheduled run cannot reach the web, it leaves the stored feed
  unchanged…"): **no problem.**
- Also, 0003 c2 ("…the person is told it runs only after the release is
  activated") was refused on the words "only after".

**With the contract as it stands now, `knownExternal = ["news.search"]`:**
0004 c3 is refused on `news.search`, and 0003 c1 and c2 are refused on
`news.search`. 0005 c2 is refused on the words, as before. 0005 c1 and c3 still
pass.

The criteria rule does not catch 0005 c1 or c3, and nothing short of guessing
could. "Registers a Bun.cron job" and "if a scheduled run cannot reach the web"
name no route and use none of the phrases. Three other things hold that task:

- The reference now says that work on a schedule is `outOfReach` and never a
  task, and it names `Bun.cron`.
- The build refuses the steps those criteria's examples actually took, which
  were on `news.search`.
- If a builder obeys the build and drops those examples, the task fails with
  "No example named 0005-schedule-feed-c1 was run." It does not pass on
  nothing.

The remaining gap is a builder that writes a passing `stories.list` example
under the id `0005-schedule-feed-c1`. That is the room the prompt says no rule
can close.

## The instructions

The instructions are 72 lines, and their longest line is 112 characters (it
was 109). The new bullet is in *What you may not do*, directly after "Do not
remove or edit an existing migration…". It is two lines, as the prompt gives
it. To make room without cutting anything:

- The *What you are* paragraph and the *How to describe a change* paragraph
  were each rewrapped from four lines to three, at 112 columns.
- The `contract.ts` bullet was rejoined into two lines, and it now also says
  that an `external` route needs a capability in `autoapp.json`.

Every sentence that was there before is unchanged. The tests compare
whitespace-flattened text, and they all pass.

## How `required` was filtered, and why in the executor

`finishedExamples(appId)` builds the list of examples that a later task has to
keep. For each completed task, it now reads the release at that task's
`releaseId` and asks `examplesOnExternal` which of the task's examples step on
an `external` route of that release's contract. Those examples are left out.
Each release is read once. A task with no release id, or a release that cannot
be read, keeps every example.

The filter is in the executor, not in `verdictOf`, for two reasons:

- `verdictOf` is a pure judgement over what it is given. What a later task owes
  depends on stored releases, and the executor already reads those.
- If `verdictOf` dropped the "is gone" sentence, it would also forgive removing
  an example that is not refused.

The new test marks the first task completed at a stored release made before
22a, in which c1 steps on `items.ping` and c2 on `items.list`. The second task
removes both examples. The only reason given is "The example 0001-first-part-c2,
from a finished task, is gone." With the filter commented out, the test fails
on the extra c1 sentence.

## Fixed decisions found wrong, and what was done instead

- **"The existing candidate, activation and recover suites unedited."** This
  could not hold. The shared fixture `tests/fixtures/autoapp-app` has
  `items.ping`, which is `external`, and its `capabilities` was `[]`. That is
  exactly what the new rule refuses, so every build of the fixture in every
  suite failed (25 tests). Changes made:
  - The fixture now asks for `network: example.com`, with a reason saying the
    ping never calls it.
  - Activation then refuses an ungranted capability. So `grantAll` in
    `autoapp-activation.test.ts` now grants what the fixture asks for by
    default. Its own comment already said "Grant whatever the release asks
    for".
  - Three `writeGrants` calls in `autoapp-engineer.test.ts` now grant
    `built.spec.manifest.capabilities` instead of `[]`.
  - One activation test, "a route that reaches outside is refused the same way,
    with the same words, in both places", built exactly the examples the build
    now refuses. It now writes those releases the way a release from before 22a
    exists: the fixture's own build with its examples replaced and its identity
    recomputed (`storedWithAcceptance`). Its assertions are unchanged, and it
    is now also the proof that a stored release with such an example still
    checks and activates.
  - No recover test was edited apart from the helper they share.
- **"(and *n* more)" against "naming every such route".** The capability
  problem names every route, joined as "`a`, `b` and `c`". A count would hide
  the names the person has to be told.
- **`out_of_reach`.** The field the engineer writes is `outOfReach` on
  `intent.open`, so the reference uses that name.
- **"after activat".** The prefix still matches "activating" and "activation",
  but the problem quotes the whole word ("after activation") rather than the
  fragment.
- **The `acceptance` topic** did not carry `EXTERNAL_IN_PREVIEW` before. The
  new paragraph starts with it and follows it with `EXTERNAL_STEP`, so "after
  `EXTERNAL_IN_PREVIEW`" is true in that topic.
- **`candidate.explain`.** No existing field could say this, because
  `capabilitiesAdded` is a diff against what was granted and names no route. So
  the tool gained `externalRoutes`, documented in the tool description. It
  lists the whole manifest's capabilities with each route, because which
  capability serves which route is not written down anywhere.
- **The workspace topic** also names `setInterval` and "a loop in `start`" next
  to `Bun.cron`. A model told only about cron would reach for the next timer.
- `check.ts` did not change. The paused-child sentence still stands, and
  nothing reaches the gate's refusal text now, because the build refuses the
  step first.

## Tests

`bun run check`: typecheck clean, 1233 pass, 0 fail. The new tests are in
`autoapp-spec` (5), `autoapp-intent` (5), `autoapp-intent-run` (1) and
`autoapp-engineer` (5):

- Both `candidate.cycle` refusals report the `spec` problem, write no release
  and start no preview.
- `candidate.explain` names `items.ping` with `network: example.com`.
- The instructions are at 72 lines and contain the bullet.
- Each reference topic is checked for one fixed fragment.
