# 15f — A turn that is refused the same way four times is ended

## Goal

A backlog turn has three things that end it when it is going nowhere. Three
cycles ending in the same build failure are refused a fourth
(`MAX_REPAIR_ATTEMPTS`). Eight minutes of silence end it
(`TASK_IDLE_TIMEOUT_MS`). The turn's time limit ends it. A builder that sends
the same malformed input again and again slips past the first two: it never
reaches a build, and `followerFor` in `intent/executor.ts` re-arms the idle
clock on every tool call and every tool result (lines ~691 and ~694), so a
refusal every few seconds is, to the clock, a busy turn. `createInputMemory`
(`engineer/tools.ts`, line ~519) answers the second identical refusal with a
valid input and then has nothing more to say. 14c's hosted model sent `create`
as a string three times running; nothing but the time limit would have stopped
a thirtieth.

After this prompt a backlog turn refused four times for the same reason, with
the workspace unchanged, is ended, and says so.

Run this after 15c is merged: the example shown at the second refusal must be
one that works before the fourth ends the turn.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13d (the idle limit and why),
  14c in full — `RefusalGroup`, `refusedIn`, `refusalSentences`, how refusals
  reach the verdict, the advice and the next attempt.
- `packages/broapp-autoapp/src/intent/executor.ts`: `followerFor`, `idleClock`,
  the turn block (line ~840), `TurnEnding`, `verdictOf`'s closing reasons,
  `idleSentence`, how an ended turn is counted against `maxAttempts` and
  13d's "an attempt that got further earns another".
- `packages/broapp-autoapp/src/engineer/tools.ts`: `createInputMemory`,
  `INPUT_REFUSAL`, `NO_MATCH`, `withExample`, `READ_AGAIN`, and what a refused
  tool's result event carries.
- `sourceRevision` and what it costs to call.

## Fixed decisions

| Decision | Value |
|---|---|
| What is counted | In the executor, per turn: refusals by tool and reason, using the same grouping 14c's `RefusalGroup` uses, so "the same refusal" means one thing in the verdict, the advice and here. A refusal is a tool result the tools refused — a malformed input, a hunk that matched nothing, a path outside the workspace. A person's *no* to an approval is not a refusal, and neither is a build problem or a failed check: those have their own limits. |
| The limit | `MAX_SAME_REFUSALS = 4`, exported, with a doc comment saying it is a choice and not a measurement: the second shows a valid input, the third is the builder's try at it, the fourth says it is not going to. The paper that prompted this used five and eight for its own loop detector and did not vary them; nothing about Autoapp is known from that. |
| Progress resets it | The count for a group starts again when the workspace revision has moved since that group's first refusal. A turn that is refused, edits, and is refused again the same way later is not stuck. Read the revision only when a count reaches the limit, not on every event. |
| What happens | At the limit the executor aborts the turn, as the idle limit does, with `The turn was refused <n> times for the same reason: <tool>: <reason>.` — the reason cut at 160. `TurnEnding` gains `stuck`; `verdictOf` adds the sentence where it adds the idle and time sentences. 14c's refusal sentences already follow; do not say the same thing twice — if the group is named by both, keep this one. |
| What it costs the task | An attempt, exactly as an idle ending does. Edits already made stay in the workspace; 14c's host build of unbuilt edits does not run after an abort, as today. 13d's "got further" rule is unchanged: read it and say in the report what it does with a stuck attempt. |
| The idle clock | Unchanged. It is right that a running tool is not silence; it was never meant to catch this. |
| Turns outside a backlog | Unchanged: a person is there and can stop. `createInputMemory` is unchanged. |
| The event log | One `note`, as the executor writes for its other endings, with the tool and the count. |
| Not in scope | A supervisor model; detecting repeated *successful* calls (the same read over and over — `noteRead` in `engineer/tools.ts` already answers a repeated read in its result); semantic similarity between refusals; changing `MAX_REPAIR_ATTEMPTS` or either time limit; ablating the limit. A row in `docs/autoapp/backlog.md` for the repeated-read case, with what would justify it. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent-run.test.ts tests/autoapp-engineer.test.ts tests/autoapp-task-context.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests in `tests/autoapp-intent-run.test.ts`, with the scripted builder the
idle-limit tests use:

1. Four identical malformed `candidate.cycle` inputs: the turn is aborted after
   the fourth result, the task's reasons hold the sentence with the tool and the
   reason, and the attempt is counted.
2. The second of them was answered with the valid input, as today.
3. Three identical refusals, then a good cycle: not ended.
4. Two refusals, an edit that lands, two more of the same refusal: not ended —
   the revision moved.
5. Four refusals of four different reasons: not ended.
6. Four declined approvals: not ended by this rule.
7. Three cycles with the same build failure: still `MAX_REPAIR_ATTEMPTS`'s
   sentence, not this one.
8. The sentence appears once in the reasons, the advice prompt and the next
   attempt's "The last attempt ended with:", not twice.
9. An interactive turn outside a backlog, refused six times: not ended.

By hand: 14c's `background-remove` replay on a copy of its root, if the copy
survives, with the model that failed it. Record whether the limit was reached,
at which call, and how long the turn ran against how long it ran in 14c. If the
root is gone, say so.

## Acceptance criteria

- A backlog turn cannot spend its whole time limit being refused the same way
  with nothing changing.
- A turn that is making progress between refusals is never ended by this.
- The person, the advice and the next attempt are each told once, in the same
  words.
- Nothing about an interactive turn, the idle limit or the repair limit
  changes.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/15f-the-same-refusal-four-times.md`: how a refusal is
recognised from a tool result and how it is grouped; what 13d's rule does with a
stuck attempt; the replay, or that it could not be run; and, plainly, that four
is a choice nobody has measured.

## Commit

```
End a backlog turn refused four times for the same reason

Every tool call and result re-arms the idle clock, and the repair limit
only counts builds, so a builder sending the same malformed input again
and again was stopped by nothing but the turn's time limit. The executor
now counts refusals by tool and reason, as the verdict already groups
them, and ends the turn at the fourth with the workspace unchanged,
saying which call and why.
```

End the commit with the co-author trailer your session's rules give you.
