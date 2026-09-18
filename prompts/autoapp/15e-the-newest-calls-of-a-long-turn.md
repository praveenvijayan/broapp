# 15e — A long turn keeps its newest calls

## Goal

12j gave the next turn the last turn's own tool calls and results, bounded, and
fixed one rule it then measured against itself: "A turn expands whole or not at
all." Its report's table:

| turn | calls | after bounds | expands under the 60,000 cap |
|---|---|---|---|
| baseline notes-tags, turn one | 15 | 37,810 | yes |
| orientation+facts notes-archive | 19 | 99,030 | **no** |
| orientation starter-done-filter | 31 | 144,630 | **no** |

and its finding: "The long turns the prompt's anecdote is about (17–20 calls of
rediscovery) are the ones least likely to expand. … expanding the newest calls
of a turn would change that; both reopen fixed decisions, so neither is done
here." A probe on 2026-09-18 with thirty read/result pairs reproduced it: the
turn fell back to its text and the model was given none of its tool messages.

This prompt reopens that one decision. After it, the first turn that does not
fit gives its newest complete calls instead of nothing.

Run this after 15d is merged: both change `run.ts`.

## Read first

- `prompts/autoapp/00-common-rules.md` (section 3); prompt 12j's Fixed decisions
  and report 12j in full — the table above, deviation 3 (the provider error in
  turn two of a structured cell) and how unpaired calls are pruned before
  saving.
- `packages/broapp/src/ai/host/run.ts`: `HISTORY_LIMITS`, `cut`, `boundMessage`,
  `expandHistory` (line ~324), `toModelMessages`. This prompt names this file:
  it may change. No other file in `packages/broapp` does, except a type it
  exports if one must.
- `tests/ai-history.test.ts` in full.
- What the two provider adapters require of a message sequence: whether a tool
  result must directly follow the assistant message that called it, whether an
  assistant message may open the expanded part, whether two assistant messages
  may be adjacent. Verify against the installed SDK and the adapters; 12j's
  deviation 3 is what getting this wrong looks like.

## Fixed decisions

| Decision | Value |
|---|---|
| The rule that changes | Walking history newest first, the first turn whose bounded transcript would cross `totalChars` is no longer all text. It gives the longest **suffix of complete groups** that fits what is left of the cap. Every turn older than it stays text, as today (`full`). A turn that fits still expands whole. |
| A group | One assistant message together with the tool-result message or messages that answer every call in it. A group is kept whole or dropped whole: never a call without its result, never a result without its call. The turn's closing assistant text, which has no calls, is a group of one and is always the last. |
| The least that is worth it | If not even the closing text plus one group with a call fits, the turn is text, as today. |
| The marker | The partial turn says what is missing: `[<n> earlier tool calls of this turn are not shown]`, as the first text part of the first kept assistant message — not a message of its own, so no two assistant messages become adjacent and no role is invented. If Step "Read first" finds an adapter that refuses a text part before tool calls in one assistant message, stop and report it as a deviation with what the adapter does accept. |
| The count | A partial turn counts as one of `limits.turns`, and its characters, marker included, count toward `totalChars`. |
| The limits | `HISTORY_LIMITS` is unchanged: 6 turns, 1,000 and 2,000 characters a part, 60,000 in all. Changing them is a different experiment. |
| What is not claimed | This gives the model its latest calls back. No run has measured what that does to completion, and this prompt does not claim a number. Say so in the report in those words. |
| Not in scope | Bounding the context of the turn that is *running* (per-step preparation, eliding older tool results as a turn grows); line ranges on `source.read`; summarising anything with a model; a recall tool; `MAX_TRANSCRIPT_CHARS` (12j's largest stored turn was 182,573, under the 200,000 cap — it has not been hit; a row in `docs/autoapp/backlog.md` for keeping a suffix when it is). One backlog row for each of the first two, citing the paper finding that managing a long turn's context mainly prevents overflow. |

## Verification

```bash
bun run typecheck
bun test tests/ai-history.test.ts tests/ai-chat.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests in `tests/ai-history.test.ts`, beside 12j's:

1. The probe: one turn of thirty read/result pairs, over the cap after bounds —
   the expansion holds the closing text, the newest groups that fit, the marker
   with the right count, and its JSON is within `totalChars`.
2. Every tool call in the output has its result and every result its call, for
   that turn and for a turn whose assistant messages each make two calls.
3. No two assistant messages are adjacent, and the sequence is `user,
   assistant[, tool, assistant…], user` as 12j fixed it.
4. A turn that fits expands whole, byte for byte as before this prompt.
5. Two long turns: the newer is partial, the older is text.
6. A turn too large for even one group is text.
7. A partial turn counts toward `turns`.
8. Each adapter, with the scripted provider used by 12j's tests, accepts the
   sequence from test 1 — the test that would have caught deviation 3.

By hand, only if a local model is to hand and the machine is otherwise idle:
12j's `starter-done-filter` two-turn cell once, recording whether turn two
re-read a file turn one had read in its last kept calls. One run supports
nothing beyond "it ran and the provider accepted the history"; say that.

## Acceptance criteria

- A turn of twenty or more calls gives the next turn its newest calls rather
  than none.
- No expansion ever holds an unpaired call or result.
- A turn that fitted before expands exactly as before.
- Both adapters accept a partial turn.
- The only file changed in `packages/broapp` is `src/ai/host/run.ts`;
  `tests/ai-chat.test.ts` unchanged; `bun run check` green.

## Report

`prompts/autoapp/reports/15e-the-newest-calls-of-a-long-turn.md`: what each
adapter requires of a sequence, with where you read it; 12j's three measured
turns re-run through the new expansion from their stored transcripts if those
survive (groups kept, characters, calls omitted), or the same for synthetic
turns of those sizes if they do not; the sentence on what is not claimed.

## Commit

```
Give the next turn the newest calls of a turn too long to expand

A turn expanded whole or not at all, and 12j measured that a turn of
about twenty calls is 60,000 to 145,000 characters after bounds: the long
turns were the ones that came back as text alone. The first turn that
does not fit now gives its newest complete calls, each with its result,
under a line that says how many earlier ones are not shown.
```

End the commit with the co-author trailer your session's rules give you.
