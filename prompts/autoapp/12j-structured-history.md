# 12j — Structured history, and a second turn that can be measured

## Goal

The model has no memory of its own tool calls between turns. `toModelMessages`
in `packages/broapp/src/ai/host/run.ts` sends every earlier turn as a role and a
string; the tool calls and results of the previous turn are gone. On 2026-09-12 the
engineer, told "continue" three times on one task, re-read the same eight files
and five reference topics each time — seventeen to twenty calls before it did
anything new — and then described the previous turn's work from its own prose
summary, because that was all it had.

The material is not lost. `threads.sqlite` already stores every assistant message
with its tool parts, and the AI SDK hands the run its own model-form transcript at
the end of every turn (`result.responseMessages`). What is missing is the host
keeping that transcript and giving it back.

After this prompt: the host writes each turn's transcript under its run id before
the turn's `done` event; a history turn may name the run it came from; the host
expands a named turn into its tool calls and results, bounded, and uses the text
for the rest; the two clients name the run; the harness takes the same path; and
`knowledge evaluate` has a two-turn task shape and a table that says whether any
of this helped.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far; 12d's for how the
  evaluation counts calls and what its table holds.
- `packages/broapp/src/ai/host/run.ts` in full: `RunDeps`, `toModelMessages`,
  `runChat`, the `finish` case of the stream loop, `end`.
- `packages/broapp/src/ai/host/threads.ts` in full: `MIGRATIONS`, `openThreads`,
  `ThreadStore`, `toStored`, `MAX_SAVE_CHARS`.
- `packages/broapp/src/ai/host/create-ai.ts`: `runDeps` (line ~295), `threadStore`
  (line ~322), `InProcessTurn` and `Ai.turn` (line ~395, `history: []`).
- `packages/broapp/src/ai/shared/contract.ts`: `chatTurn` (line ~53), the
  `ai.chat` params (line ~228), `storedMessage` (line ~100).
- `packages/broapp/src/ai/react/use-ai-chat.ts`: `ChatMessage`, `toHistory`, where
  `runId.current` is set.
- `packages/broapp-ai-elements/src/transport.ts`: `BroappMessageMetadata`,
  `toHistory`, `makeRunId`, the `usage` case that writes `message-metadata`.
- `packages/broapp-ai-elements/src/use-broapp-chat.ts`: `persist`.
- `packages/broapp-autoapp/src/knowledge/harness.ts`: `turn`.
- `packages/broapp-autoapp/src/knowledge/evaluate.ts`: `EvaluationTask`,
  `EVALUATION_TASKS`, `CONDITIONS`, the run loop (line ~450), `callsOf`,
  `editedBy`, the markdown table.
- `node_modules/ai/dist/index.d.ts`: `StreamTextResult.responseMessages`
  (line ~2770, `PromiseLike<Array<ResponseMessage>>`), `ResponseMessage`
  (line ~176: `AssistantModelMessage | ToolModelMessage`), `ToolResultPart`.
- `tests/ai-threads.test.ts`, `tests/ai-host.test.ts`, `tests/autoapp-evaluate.test.ts`
  and `tests/autoapp-evaluate-child.ts`.
- `docs/ai.md` ("Conversations", "What leaves the machine"),
  `docs/autoapp/learning.md` ("Evaluation").

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Who writes the transcript | The host, from `result.responseMessages` after the stream loop's `finish`, **before** `sink.emit({ type: 'done' })`. Nothing the browser saved is ever read back into a prompt. The browser only names the run. |
| Where | A `transcripts` table in `threads.sqlite`, by a new entry appended to `MIGRATIONS` (never edit an existing one): `run_id TEXT PRIMARY KEY, messages TEXT NOT NULL, chars INTEGER NOT NULL, created_at INTEGER NOT NULL` plus an index on `created_at`. `ThreadStore` gains `saveTranscript(runId, messages)`, `transcript(runId)` and the retention below. `RunDeps` gains an optional `transcripts?: { save(runId: string, messages: readonly ResponseMessage[]): void; read(runId: string): readonly ResponseMessage[] \| null }`; `create-ai.ts` wires the thread store's pair. |
| What is written | The turn's `ResponseMessage[]` as the SDK gave them, with two edits at write: a tool call with no matching result (a turn stopped mid-call) is removed, and a message left empty by that is removed. Serialised with `canonicalJson`-style stable JSON; provider-specific metadata fields are dropped. A transcript over **200,000** characters is not written (logged at `warn`); the turn stays text. |
| The wire | `chatTurn` gains `runId: s.optional(s.string({ pattern: /^[A-Za-z0-9_-]{8,64}$/ }))` (the same shape `ai.chat` already requires of `runId`). Additive: a client that never sends it changes nothing. |
| Naming the run | `BroappMessageMetadata` gains `runId?: string`; the transport writes it in the same `message-metadata` chunk as `usage`, and additionally at `text-start`/first `tool-input-start` so a turn that never reaches `usage` still carries it. `toHistory` in the transport puts it on the assistant turn. Stored messages keep `metadata` already, so it survives reload. `use-ai-chat.ts`: `ChatMessage`'s assistant variant gains `readonly runId: string`, set from `runId.current` where the message is created; `toHistory` passes it on. |
| Expansion | `toModelMessages` becomes `toModelMessages(params, transcripts)`. Walking history from the newest turn backwards: an assistant turn with a `runId` the store holds, while fewer than **6** assistant turns have been expanded and the running total is under the cap, is replaced by its transcript messages; every other turn is `{ role, content }` as today. A turn expands whole or not at all. The user turns keep their place, so the sequence stays `user, assistant[, tool, assistant…], user, …`. |
| Bounds at expansion | Each tool call's `input` is cut to **1,000** characters of its JSON, each tool result's `output` to **2,000**, replaced by the head plus `<omitted N chars>`; `toolCallId`, `toolName` and any `error` field of a result are always kept whole. Expanded history in total ≤ **60,000** characters (`JSON.stringify` length); when the next expansion would cross it, that turn and every older one stay text. Nothing is summarised; nothing is invented. |
| Trust | A `runId` names a transcript the host itself wrote. A run id the host does not hold is text. A `system` role in stored messages is never read (nothing reads stored messages for this). The history `content` strings are as untrusted as today. |
| Failure | `saveTranscript` failing (disk, closed store) is logged at `error` and the turn still emits `done`; the next turn's history for it is text. `transcript()` failing is logged and treated as absent. Neither ever fails a turn. |
| Retention | Transcripts older than **30 days**, or beyond the newest **2,000**, are deleted on `openThreads` and on every `saveTranscript`, in one transaction. Deleting a thread does not delete transcripts (the host does not know the thread at run time); the age and count cap are the bound. |
| The harness | `InProcessTurn` gains `history?: readonly ChatTurn[]`; `Ai.turn` passes it instead of `[]`. `harness.ts` `turn(runId, message, timeoutMs, history?)` passes it through. The harness's `Ai` is built with the same `dataDir` its thread store uses, so a transcript written in turn one is read in turn two through the same `ThreadStore` the tab uses. |
| Two-turn tasks | `EvaluationTask` gains `turns?: 2` and `between?: 'none' \| 'touch-file'`. A two-turn run: turn one runs with the task's request and a call budget of the first edit — the harness stops the turn (aborts its signal) as soon as `editedBy(call)` is true for a completed call; then turn two runs with the message `continue` and the history `[{ role: 'user', content: request }, { role: 'assistant', content: <turn one's text>, runId: <turn one's run id> }]` under the condition's history mode. `between: 'touch-file'` appends one comment line to `src/shared/contract.ts` between the turns and commits it, so turn two's `source.read` sees a revision turn one never saw. |
| Conditions | `CONDITIONS` gains a second axis: `history: 'text' \| 'structured'`. For the existing single-turn tasks the axis is irrelevant and only `text` runs. For two-turn tasks every existing condition runs twice, once per history mode; under `text` turn two's history carries no `runId`. |
| What the table adds | For two-turn tasks, per condition and history mode: reads in turn two before its first edit; repeated reads (a `source.read`/`spec.read`/`spec.reference` in turn two of a path or topic turn one already read); repeated actions (a hunk in turn two whose `find` turn one already applied, or an `apps.create`/`candidate.cycle` create of a path that exists); tokens for turn two; working code and workflow completed as today; and for `touch-file` tasks whether turn two read the changed file before editing it. |
| Restart | One two-turn cell per task also runs turn two on a **fresh** harness over the same root and the same `dataDir` (the launcher restarted between turns). The table marks it. |
| Not in scope | Summarising old turns; a scratchpad or `task.note` tool; sending stored browser parts to the model; per-thread deletion of transcripts; changes to the knowledge layer's documents, hints or lessons; the AI Elements panel rendering anything new. |

## Step 1 — the store

`threads.ts`: the migration, `saveTranscript`, `transcript`, `retainTranscripts`.
Bound and validate on read as well as write: a stored row that does not parse as
an array of messages with `role` in `assistant`/`tool` is treated as absent and
logged once.

## Step 2 — the run

`run.ts`: `RunDeps.transcripts`; the write in the `finish` case (await
`result.responseMessages`, prune unpaired calls, save, then `done`); the expansion
in `toModelMessages` with the bounds above in one exported pure function
`expandHistory(history, read, limits)` so a test can drive it without a model.
`safeToolMessage` and the tool result shape are unchanged.

## Step 3 — the clients

`contract.ts` `chatTurn.runId`; `transport.ts` metadata and `toHistory`;
`use-ai-chat.ts` `ChatMessage.runId` and `toHistory`. `use-broapp-chat.ts` is
unchanged: the race the reviewer named no longer matters, because the host wrote
the transcript before `done` and the browser's save carries only the id.

## Step 4 — the harness and the evaluation

`create-ai.ts` `InProcessTurn.history`; `harness.ts` `turn(..., history)`;
`evaluate.ts` the two-turn shape, the history axis, the restart cell, the new
columns, the markdown. Add one two-turn task on the starter (`between:
'touch-file'`) and mark the existing "add tags" Notes task `turns: 2` as well.

## Step 5 — docs

`docs/ai.md`: "Conversations" gains a paragraph on what the host keeps per run and
for how long; the "What leaves the machine" row gains "and the tool calls and
results of the last six turns". `docs/autoapp/learning.md` "Evaluation" gains the
two-turn shape and the columns. `docs/autoapp/backlog.md`: a row for the scratchpad,
deferred until this table says it is needed.

## Verification

```bash
bun run typecheck
bun test tests/ai-threads.test.ts tests/ai-host.test.ts tests/ai-history.test.ts
bun test tests/ai-chat.test.ts tests/ai-elements-transport.test.ts
bun test tests/autoapp-knowledge.test.ts tests/autoapp-evaluate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run dryrun
bun run dryrun:autoapp
bun run check
```

`tests/ai-chat.test.ts` is untouchable and must stay green. New file
`tests/ai-history.test.ts`:

1. A fake-adapter turn with two tool calls writes one transcript row under its run
   id before the client sees `done` (assert the row exists inside the `done`
   event's handler); the row holds assistant tool-call parts and tool results with
   matching ids.
2. A turn stopped between a call and its result writes a transcript without the
   unpaired call.
3. `expandHistory`: a history of three turns where the middle one names a held run
   yields `user, assistant(text), user, assistant(tool-calls), tool(results), user`
   in that order; an unknown run id stays text; the seventh-newest named turn stays
   text; an input over 1,000 and an output over 2,000 characters carry the head and
   `<omitted N chars>` with `toolCallId` and `toolName` intact; a result's `error`
   survives whole; crossing 60,000 leaves that turn and every older one as text.
4. A second fake-adapter turn whose history names the first run: `adapter.calls[1]`'s
   prompt contains the first turn's tool names and result text; the same with
   `history: 'text'` does not.
5. A save failure (close the store first) logs an error, the turn still ends
   `succeeded`, and the next turn gets text for it.
6. Retention: 2,001 rows leave 2,000; a row older than 30 days goes.
7. The transport: a finished assistant message carries `metadata.runId` equal to
   the run id sent; `toHistory` puts it on the turn; a stored-and-reloaded thread
   keeps it (through `toStored` and `ai.threadsGet`).
8. `use-ai-chat.ts`: same, through the core hook's `toHistory`.

`tests/autoapp-evaluate.test.ts` (offline, fake adapter, existing child helper):

9. A two-turn task stops turn one at the first edit and passes turn two a history
   naming turn one's run; under `structured` the second turn's prompt (from the
   fake adapter's calls) carries turn one's tool results; under `text` it does not.
10. The repeated-read and repeated-action counters: a scripted turn two that
    re-reads a path turn one read counts one repeated read; one that re-applies a
    hunk counts one repeated action.
11. `touch-file`: the file changed between turns has a new revision in turn two's
    `source.read` result, and the "read the changed file before editing" column is
    true only when it did.

## Evaluation run

After the tests, run on the configured local model:

```bash
bun run packages/broapp-autoapp/src/launcher/main.ts knowledge evaluate --runs 3 --out .broapp-tmp/eval-12j
```

No other session on this machine while it runs (every session rebuilds
`dist/broapp-autoapp`). Record the two-turn table in the report and in
`docs/autoapp/backlog.md` "What was measured", beside the 12d numbers, with the
contamination note if anything else ran.

## Acceptance criteria

- The host writes every turn's transcript before `done`, and a "continue" turn
  whose history names that run receives the turn's tool calls and results, bounded
  as decided, on every client and in the harness.
- A client that sends no `runId` gets exactly today's behaviour; `tests/ai-chat.test.ts`
  is unchanged and green.
- Nothing the browser saved is read into a prompt.
- `knowledge evaluate` runs the two-turn tasks under both history modes and prints
  the columns above; the three-run table is in the report.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12j-structured-history.md`. Include: the transcript size
of a real turn (chars, before and after bounds); the two-turn table with both
history modes and the restart cell; what the numbers say about the "seventeen
calls of rediscovery" claim; whether the scratchpad row stays deferred.

## Commit

```
Keep each turn's transcript, and give it back on the next

The host writes the model's own tool calls and results under the run id
before the turn ends; a history turn may name that run, and the host expands
it, bounded, in place of the text. Both clients name the run, the harness
takes the same path, and knowledge evaluate has a two-turn task under text
and structured history to say whether it helped.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

Versioning for the release that follows (not part of this prompt): additive
contract field, so a patch — `broapp` 0.4.2, `broapp-ai-elements` 0.4.4,
`broapp-autoapp` 0.3.7 on `broapp ^0.4.2`, root 0.4.8.
