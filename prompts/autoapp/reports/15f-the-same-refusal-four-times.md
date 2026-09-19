# 15f — A turn that is refused the same way four times is ended

## What was built

- `intent/executor.ts`:
  - `MAX_SAME_REFUSALS = 4`, exported. Its doc comment says it is a choice and not a
    measurement, and that the paper's five and eight say nothing about Autoapp.
  - `stuckSentence(count, group)`: `The turn was refused <n> times for the same reason:
    <tool>: <reason>.`, with the reason from 14c's `refusalError`, cut at 160.
  - `TurnEnding.stuck`. `verdictOf` adds the sentence where it adds the idle and time sentences,
    and drops the stuck group from 14c's refusal sentences, so the refusal is said once.
  - Per turn, `Active` carries `refusals` (by route and kind: the first refusal of each group,
    its count, and how many edits had landed when it began), `landed`, `turnRev` (the revision
    `runTask` already reads before the turn) and `stuck`.
  - `countRefusal`, called by `followerFor` on every `tool-result`. At the limit it writes one
    `note` with the tool and the count, and aborts the turn's controller, as the idle clock does.
  - `refusalOf` and `landedEdit` read a tool result: what is a refusal, and what is an edit
    that landed.
- The idle clock, `createInputMemory`, the repair limit, the time limit and interactive turns
  are unchanged.
- Docs: `intents.md` (step 6: the new ending, its sentence, that four is a choice, that it costs
  an attempt); `backlog.md`, one row (a turn that repeats a successful call).
- Tests: nine in `tests/autoapp-intent-run.test.ts` under "15f", the prompt's 1–9 (1 and 2 in
  one test). With the limit disabled, tests 1 and 8 fail; restored.

## How a refusal is recognised, and how it is grouped

From the `tool-result` event the executor already follows. A result is a **refusal** when it is
not `denied` and its output is `{ error: <string> }`, and the string is not the AI layer's
fixed `The tool failed.` (a failure it reduced because it names nothing the builder could fix).
That is what the tools return for a malformed input, a hunk that matched nothing, and a path
outside the workspace. It is not what they return for a person's or the standing answer's no
(`denied: true`), or for a build that failed or a check that did not pass (ordinary results with
`build.ok: false` or failed checks), so neither counts.

It is **grouped** by passing the one result through 14c's own `refusalsOf`. That gives the same
route, the same kind (`input`, `no-match`, `other`, read from the error's opening words) and the
same sanitised, cut error, so "the same refusal" means one thing in the verdict, the advice and
here. The group keeps its **first** error. From the second identical input refusal on, the event
carries the valid example appended by `createInputMemory`; the first carries the tool's own
words, which is what the run store records and what the sentence should quote.

**Progress.** A group's count starts again when an edit has landed since its first refusal. That
is a `source.edit` or `source.change` that succeeded, or a cycle whose output shows files its
patch changed: 15d's definition. Each landed edit is a commit in a git workspace, so this is the
revision moving, seen from the results without calling git per event. The revision is read
**once, at the limit**. If no edit was seen landing all turn but the revision differs from the
one at the turn's start, something moved the workspace that no result reported. The group
starts again instead of ending the turn. See decision 1.

## What 13d's rule does with a stuck attempt

The stuck ending goes to the verdict like any other, and the verdict's `passed` criteria decide
13d's rule as before. The first attempt of a run always counts. A later stuck attempt that
passed **more** criteria than every earlier attempt of the run is not counted against
`maxAttempts`, and earns another turn, up to `TASK_MAX_TURNS`. In practice a stuck attempt was
refused before building, passed none, and is counted. Edits it had made stay in the workspace;
the turn was aborted, so 14c's host build does not run, as for an idle ending.

## Deviations, and decisions I made

1. **How "the revision has moved since the group's first refusal" is seen, reading the
   revision only at the limit.** A revision read only at the limit has nothing from the first
   refusal to compare with, and an edit's result carries no commit id. Reading git at each
   group's first refusal would break "read the revision only when a count reaches the limit".
   So the move is seen as the thing that makes it: a landed edit in a result. The one read at
   the limit catches a move no result showed (in a turn where none showed one), and treats it as
   progress. Either way a turn whose workspace moved is not ended. In a workspace without git
   the revision never moves, and landed edits still restart the count. That is the safer reading
   of "a turn that is making progress between refusals is never ended". **The owner should
   confirm this reading of the fixed decision.** The behaviour it asks for is met, and the
   revision is read only at the limit.
2. **The kind is 14c's, so "reason" means route and kind, not the exact message.** Four input
   refusals of `candidate.cycle` for four different fields are one group. Test 5's "four
   different reasons" therefore uses four route-and-kind groups.
3. **The duplicate rule drops the stuck group before 14c's sentences are made.** If the stuck
   group is `source.edit` or `source.change`, 14c's single edits sentence is made from the other
   edit groups, and says nothing when there are none.
4. **The by-hand replay was not run.** It needs a live model, and this chain makes no live-model
   runs. The copy of the root it would replay does not survive either: 14c ran in the worktree
   `/Users/pv/works/broapp-14c`, which is gone. Deferred to the measurement that follows this
   series.
5. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Plainly

**Four is a choice nobody has measured.** Nothing about how often a builder recovers on its
third or fifth identical refusal is known, and no run here says anything about completion.

## Commands run

```
bun run typecheck                                                        exit 0
bun test tests/autoapp-intent-run.test.ts -t 15f (limit disabled)        6 pass, 2 fail
bun test tests/autoapp-intent-run.test.ts tests/autoapp-engineer.test.ts \
  tests/autoapp-task-context.test.ts                                     148 pass, 0 fail
bun test tests                                                           1005 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                     dist/broapp-autoapp 77.8 MB, exit 0
bun run scripts/autoapp-smoke.ts                                         every step passed
bun run check                                                            exit 0, 1005 pass, 0 fail
git diff --stat tests/ai-chat.test.ts packages/broapp                    (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| A backlog turn cannot spend its whole time limit refused the same way with nothing changing | pass (test 1: ended after the fourth result, the fifth never asked for) |
| A turn making progress between refusals is never ended by this | pass (tests 3, 4; and the revision guard at the limit, decision 1) |
| The person, the advice and the next attempt are each told once, in the same words | pass (test 8: once in the reasons, the advice prompt and "The last attempt ended with:"; 14c's sentence for the group dropped) |
| Nothing about an interactive turn, the idle limit or the repair limit changes | pass (tests 6, 7, 9; the idle clock and `createInputMemory` untouched) |
| No change to `packages/broapp`; `ai-chat` unchanged; `bun run check` green | pass |
