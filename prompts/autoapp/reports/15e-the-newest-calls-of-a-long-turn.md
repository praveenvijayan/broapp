# 15e — A long turn keeps its newest calls

## What was built

- `packages/broapp/src/ai/host/run.ts`, the only file changed in `packages/broapp`.
  `expandHistory` still walks history newest first. The first turn whose bounded transcript
  would cross `totalChars` is now given to `newestGroups(bounded, room)`, and a turn that fits
  still expands whole. `groupsOf` cuts a transcript into groups: an assistant message and the
  tool messages after it, complete only when every call has its result there and every result
  answers one of its calls. Walking back from the newest group, `newestGroups` keeps whole groups
  while the suffix, marker included, fits `room`. It stops at the first incomplete group, and it
  returns `null` unless the suffix holds at least one call, so the turn is then text as before.
  `withMarker` puts `[<n> earlier tool calls of this turn are not shown]` in as the first text
  part of the first kept assistant message (a string content becomes two text parts). A partial
  turn counts as one of `turns`, and its characters count toward `totalChars`. It sets `full`,
  so every older turn is text. `HISTORY_LIMITS` is unchanged. The doc comment on
  `expandHistory` says why the rule changed.
- `docs/ai.md` "What the host keeps per run" describes the partial turn. `docs/autoapp/backlog.md`
  gains four rows: the running turn's context and `source.read` line ranges (each citing the
  paper's finding), a suffix for `MAX_TRANSCRIPT_CHARS`, and reasoning parts that are never
  bounded (found below).
- `tests/ai-history.test.ts`: eight tests beside 12j's, the prompt's 1–8. Against the `run.ts`
  committed before this prompt, 1, 2, 5, 7 and 8 fail. 3, 4 and 6 pass on both, which is right:
  they state what must not change (the role sequence, a turn that fits, a turn too large for one
  group).

## What each adapter requires of a sequence, and where I read it

- **OpenAI-compatible** (`ollama`, `openai`, `customServer`, all over `@ai-sdk/openai-compatible`
  3.0.44). Its `convertToOpenAICompatibleChatMessages` (`dist/index.js`, `case "assistant"`,
  line ~243) concatenates every `text` part into `content` and every `tool-call` into
  `tool_calls` on **one** assistant message. A text part before calls is therefore accepted: it
  becomes `content` beside `tool_calls`. Each `tool-result` becomes its own `role: "tool"`
  message with `tool_call_id` (`case "tool"`). The wire format needs those tool messages
  straight after the assistant message whose `tool_calls` they answer. The converter does not
  merge adjacent assistant messages, so the expansion must not produce any. Every call's input is
  sent as `JSON.stringify(input)`, which is why 12j's deviation 3 (a cut input sent as a bare
  string) broke Ollama. 12j's `{ truncated }` object is unchanged here.
- **Anthropic** (`@ai-sdk/anthropic` 4.0.49). `groupIntoBlocks` (`dist/index.js` line ~3449)
  merges consecutive messages of one role into one block, and puts `tool` messages into a
  **user** block, so each group's results become the user message right after the assistant
  message that made the calls. The API needs every `tool_use` answered by a `tool_result` in the
  very next user message, and an assistant message's content may hold `text` blocks before
  `tool_use` blocks. A trailing tool message and the next user turn merge into one user block,
  with the results first.
- **Both, tested (test 8).** Test 1's sequence is sent through each adapter's real model
  instance (`streamText`, with a stubbed `fetch` answering a minimal stream). The OpenAI-shaped
  body carries the marker in an assistant `content`, and every `tool` message's `tool_call_id`
  belongs to the assistant message before it. The Anthropic body alternates roles, and every
  `tool_use` is answered in the next message. Both streams finish with the stub's text.

No adapter refused a text part before tool calls, so the marker's fixed placement stands.

## 12j's measured turns, re-run from their stored transcripts

The transcripts survive: `tests/.autoapp-run/demo-12d/autoapp/launcher/ai/threads.sqlite`,
47 rows. Each turn was read-only and put through the new `expandHistory` as the newest turn of a
one-turn history (script in the scratchpad):

| turn (run id) | stored chars | calls | old rule | messages kept | calls kept | calls omitted | chars given |
|---|---|---|---|---|---|---|---|
| orientation starter-done-filter (`…starter-done-filter-1-1b516r`) | 182,573 | 31 | text | 20 | 13 | 18 | 56,598 |
| orientation+facts notes-archive (`…notes-archive-1-1b516r`) | 174,649 | 19 | text | 9 | 4 | 15 | 14,859 |
| baseline notes-tags, turn one (`…notes-tags-s-1-1b516r-1`) | 100,659 | 15 | whole | 14 | 15 | 0 | 37,810 |
| baseline starter-priority, turn one (`…starter-priority-t-1-2m0pqo-1`) | 26,507 | 8 | whole | 8 | 8 | 0 | 16,457 |

The old-rule column agrees with 12j's table (yes, no, no, and yes for the fourth). Across all
47 transcripts, 15 were over the cap and came back as text under the old rule. **13 of them now
give their newest calls.**

**One finding.** The notes-archive turn kept only 4 of 19 calls in 14,859 characters, far under
the room left. The group before them is a `candidate.cycle` whose assistant message carries
**50,203 characters of reasoning**. 12j's bounds cut tool inputs and outputs only, and keep
`reasoning` and `text` parts whole, so that one group outgrew the room alone. Groups are whole
or dropped, so the suffix stops there. `HISTORY_LIMITS` is fixed by this prompt, so this is
recorded as a backlog row, not changed.

## What is not claimed

This gives the model its latest calls back. No run has measured what that does to completion,
and this prompt does not claim a number.

The by-hand run (12j's `starter-done-filter` two-turn cell on a local model) was **not done**,
per this chain's rule of no live-model runs. It is deferred to the measurement that follows this
series. Even done once, it would have shown no more than that it ran and the provider accepted
the history.

## Deviations, and decisions I made

1. **A group is complete only when its calls and results match exactly.** An incomplete one is
   not dropped and walked past; it ends the suffix. The kept messages must be contiguous and
   newest, and a gap would put a later group's results after an earlier assistant message.
   12j's `saveTranscript` already prunes unpaired calls, so this is a guard, not a path any
   stored transcript takes. None of the 47 hit it.
2. **"At least one group with a call" is checked, not "the closing text plus one group".** A
   transcript of a turn that was stopped has no closing words, and its last group is a call
   group. It is kept when that group fits. When the closing words exist they are always in the
   suffix, because they are its newest group.
3. **The marker is the fixed text even for one call** ("1 earlier tool calls…"). The decision
   gives its words, and I did not bend them for grammar.
4. **`total` counts the partial turn's own JSON length.** That is the convention 12j used for a
   whole turn, and the room is `totalChars` minus what newer turns used. Test 1 holds the
   expanded messages' JSON under the cap.
5. `docs/ai.md` was updated: its paragraph stated the old whole-or-nothing rule.
6. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Commands run

```
bun run typecheck                                                   exit 0
bun test tests/ai-history.test.ts -t 15e (run.ts before this prompt)  3 pass, 5 fail
bun test tests/ai-history.test.ts tests/ai-chat.test.ts             45 pass, 0 fail
bun test tests                                                      997 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 77.8 MB, exit 0
bun run scripts/autoapp-smoke.ts                                    every step passed
bun run check                                                       exit 0, 997 pass, 0 fail
git diff --stat tests/ai-chat.test.ts packages/broapp               run.ts only
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| A turn of twenty or more calls gives the next turn its newest calls rather than none | pass (test 1; the 31-call stored turn now gives 13, the 19-call one 4) |
| No expansion ever holds an unpaired call or result | pass (test 2, one and two calls a message; test 8 on the wire) |
| A turn that fitted before expands exactly as before | pass (test 4, byte for byte; passes on the previous `run.ts` too) |
| Both adapters accept a partial turn | pass (test 8) |
| Only `src/ai/host/run.ts` changed in `packages/broapp`; `ai-chat` unchanged; `bun run check` green | pass |
