# 01 — The Brobridge transport for `useChat`

## Goal

A new package, `broapp-ai-elements`, whose first export turns Broapp's
`ai.chat` stream into what the AI SDK's `useChat` expects. After this
prompt an application can write

```tsx
const chat = useBroappChat({ refs });
chat.sendMessage({ text: 'How many notes do I have?' });
```

and get standard `UIMessage`s with text parts, tool parts, approval state,
`status`, `stop()`, `error` — without touching the host. No visual change
yet; nothing adopts the hook until prompt 04.

## Read first

- `prompts/ai-elements/00-common-rules.md`, all of it.
- `packages/broapp/src/ai/react/use-ai-chat.ts` — the whole file. This is
  the behaviour you are re-expressing: history assembly, `runId`, the
  event switch, the `calls` ref, unmount handling, the guard on a second
  send. Copy the *decisions*; do not import the file.
- `packages/broapp/src/ai/react/provider.tsx` — `useAiContext().client()` is
  how the transport reaches the bridge.
- `packages/broapp/src/ai/shared/{contract,types}.ts`.
- `packages/broapp/src/client/client.ts` — `subscribe` and `Subscription`.
- `packages/broapp-ai-anthropic/package.json` — the package shape to copy.
- `tests/ai-chat.test.ts` lines 1–210 — the `start()` scaffold, the fake
  adapter scripts, and how a `confirm` is answered in a test.
- `tests/harness.ts` — `harness()`, `connect(contract)`, `until()`.
- `tests/build.test.ts` — the AI React bundle test near line 205.
- `node_modules/ai/dist/index.d.ts`: `ChatTransport`, `UIMessageChunk`,
  `UIMessage`, `ToolUIPart`, `readUIMessageStream`.
- `node_modules/ai/dist/index.js`: search `case "tool-approval-request"` and
  read the processor that follows (after line 7000), including how it looks
  up a part for `tool-approval-response`.
- After `bun install`: `node_modules/@ai-sdk/react/dist/index.d.ts` —
  `useChat`, its options and helpers type. Also find how `regenerate` trims
  messages before calling the transport (search `regenerate` in
  `node_modules/ai/dist/index.js`), so you know what `messages` contains for
  the `regenerate-message` trigger.

## Step 1 — the package

Create `packages/broapp-ai-elements/` with `package.json`, `tsconfig.json`,
`README.md` (ten lines: what it is, the two imports, a pointer to
`docs/ai.md`), `LICENSE` (copy), `src/index.ts`.

`package.json`, adjusted from the Anthropic package:

- `name: "broapp-ai-elements"`, `version: "0.2.1"`, description
  "The AI SDK transport and AI Elements chat panel for a Broapp application".
- `files: ["src", "styles.css", "README.md", "LICENSE"]`. `styles.css` does
  not exist until prompt 03. If `bun pm pack` refuses a missing listed file,
  leave it out and let prompt 03 add it; otherwise list it now.
- `exports`: `"."` → `./src/index.ts`, `"./package.json"`. (`./ui` and
  `./styles.css` arrive in prompt 03.)
- `dependencies`: `"ai": "7.0.93"`, `"@ai-sdk/react": "4.0.96"`.
- `peerDependencies`: `"broapp": ">=0.2.1"`, `"react": "^19.0.0"`,
  `"react-dom": "^19.0.0"`.
- `devDependencies`: `@types/bun`, `@types/react`, `@types/react-dom`,
  `broapp: workspace:*`, `react`, `react-dom`, `typescript` — versions as
  the workspace root has them.
- `keywords`: `broapp`, `ai`, `ai-sdk`, `ai-elements`, `chat`, `local-first`.

Wire it in everywhere the Anthropic package is wired in. Run
`grep -rn "broapp-ai-anthropic" --include='*.json' --include='*.ts' --include='*.yml' --include='*.md' . | grep -v node_modules`
and mirror every hit that is about *packaging or building* (root
`tsconfig.json` references, `scripts/pack-local.ts` `PUBLISHED`, CI
workflow matrices, `scripts/release-dry-run.ts` if it lists packages). Do
**not** mirror hits that are about *providers* (docs prose, the registry,
the notes example's host). Add `"broapp-ai-elements": "workspace:*"` and
`"@ai-sdk/react": "4.0.96"` to the root `devDependencies`. Run `bun install`.

Confirm the installed `react` satisfies `@ai-sdk/react`'s peer range (see
common rules §7). If it does not, raise `react`/`react-dom` at the root to
the lowest satisfying `^19.x` and record it.

Verify: `bun install` exit 0; `bun run typecheck` exit 0 with an empty
`src/index.ts` that exports nothing yet (add `export {};`).

## Step 2 — `src/transport.ts`

```ts
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { AiClient, ToolCallState } from 'broapp/ai/react';
import type { ChatEvent, ChatTurn } from 'broapp/ai';

/** Per-message metadata this transport writes. */
export interface BroappMessageMetadata {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type BroappUIMessage = UIMessage<BroappMessageMetadata>;

/** What the confirmation card needs, carried in `approvalDescriptor`. */
export interface BroappApprovalDescriptor {
  readonly tool: string;
  readonly expiresAt?: number;
}

export interface BroappChatTransportOptions {
  /** How to reach the bridge. `useAiContext().client` fits. */
  client(): Promise<AiClient>;
  /** Records the user is looking at, read when a turn starts. */
  refs?(): readonly string[];
  /** A tool call settled — done or denied. Called from the event, never from state. */
  onToolResult?(call: ToolCallState): void;
  /** How many calls are waiting for a person, whenever that changes. */
  onAwaiting?(pending: number): void;
  /** For tests. Default: `crypto.randomUUID().replace(/-/g, '')`. */
  runId?(): string;
}

export interface BroappChatTransport extends ChatTransport<BroappUIMessage> {
  /** Answer a `confirm`. Rejects with 'That request has expired.' when nobody is waiting. */
  confirm(callId: string, approve: boolean): Promise<void>;
  /** Cancel the running turn, if any. Text so far stays. */
  cancel(): void;
  /** True while a turn is running. */
  readonly active: boolean;
}

export function createBroappChatTransport(options: BroappChatTransportOptions): BroappChatTransport;
```

Importing *types* from `broapp/ai/react` is fine: the forbidden direction
is `broapp` importing the engine, not the other way round.

### `sendMessages`

1. If a turn is active, return a stream that emits one
   `{ type: 'error', errorText: 'A reply is still being written.' }` and
   closes. Do not start a second run.
2. Take the last element of `messages`. If its role is not `user`, emit
   `error` `'Nothing to send.'` and close. (For `regenerate-message`, the
   SDK has already removed the assistant reply; confirm this in
   `index.js` and note what you found.)
3. `message` = the user message's text parts joined with `'\n\n'`, trimmed.
   Empty → `error` `'Nothing to send.'`.
4. If the user message has any `file` part, emit `error`
   `'This version cannot send attachments yet.'` and close. Prompt 02
   replaces this branch. Do not silently drop the files.
5. `history` = every earlier message, in order, mapped to `ChatTurn`:
   - role `user` or `assistant` only; anything else skipped;
   - `content` = text parts joined with `'\n\n'`; for a `user` message,
     each `file` part appends `[image: <filename or mediaType>]` on its
     own line;
   - an assistant message whose content is empty is skipped (matches
     `toHistory` in `use-ai-chat.ts`);
   - tool parts, reasoning parts and data parts are not sent;
   - keep the last 100.
   Do not truncate `content` to 20,000 characters; let the contract refuse
   and let that surface as the `error` chunk, as it does today.
6. `runId` = `options.runId()`; `refs` = `[...options.refs()]`.
7. Build a `ReadableStream<UIMessageChunk>` with `start(controller)` that
   awaits `options.client()` and calls `subscribe('ai.chat', params, callbacks)`.
   Wire cancellation both ways: the stream's `cancel()` and
   `abortSignal` (`'abort'` listener, and check `aborted` before
   subscribing) both call `subscription.cancel()` and close the controller.
   A cancelled turn closes the stream **without** a `finish` chunk and
   without an `error` chunk; the SDK keeps the text so far and returns to
   `ready`.
8. First chunk: `{ type: 'start', messageId: `${runId}-assistant` }`.

### Event → chunk mapping

Keep an `open text id` (or null) and the current turn's `calls` map, as
`use-ai-chat.ts` does.

| `ChatEvent` | Emit |
|---|---|
| `text` | If no text part is open: `text-start` with id `${runId}-t${n}` (n counts up). Then `text-delta` with `delta: event.text`. |
| `tool-call` | If a text part is open: `text-end`, clear it. Then `tool-input-start { toolCallId: callId, toolName: tool }` and `tool-input-available { toolCallId, toolName, input }`. Record the call as `running`. |
| `confirm` | `tool-approval-request { approvalId: event.requestId ?? callId, toolCallId: callId, reason: `Allow ${tool}?`, approvalDescriptor: { tool, expiresAt } }`. Record `awaiting` with that `approvalId`; `onAwaiting(count)`. |
| `tool-result` | If this call was awaiting: `tool-approval-response { approvalId, approved: !denied }` first, and `onAwaiting(count)` after removing it. Then `denied ? tool-output-denied { toolCallId } : tool-output-available { toolCallId, output }`. Record the call `done`/`denied` and call `onToolResult` **from here**. |
| `usage` | `message-metadata { messageMetadata: { usage: { inputTokens, outputTokens } } }`. |
| `done` | If a text part is open: `text-end`. Then `finish`. Close the stream. `onAwaiting(0)` if it was not already 0. |
| `error` | If a text part is open: `text-end`. Then `error { errorText: event.message ?? 'The AI provider returned an error.' }`. Close the stream. No `finish`. `onAwaiting(0)`. |
| subscribe `onError(cause)` | Same as `error` with `cause.message`. |
| subscribe `onDone` without a `done` event | Treat as `done`. |

Only the fields the contract puts on each event are read; a `confirm`
without `requestId` falls back to `callId` for `approvalId` so the two
chunks always agree.

### `confirm(callId, approve)`

Needs an active run and a recorded awaiting call for `callId`; otherwise
reject with `Error('That request has expired.')`. Call
`ai.chatConfirm({ runId, callId, approve })`. `accepted: false` → the same
rejection. Do **not** emit any chunk from here; the host's `tool-result`
event does that.

### `reconnectToStream`

Returns `null`. There is nothing to resume: a turn belongs to the tab that
started it.

## Step 3 — `src/use-broapp-chat.ts`

```ts
export interface BroappChatOptions {
  readonly refs?: readonly string[];
  readonly onToolResult?: BroappChatTransportOptions['onToolResult'];
  readonly onAwaiting?: BroappChatTransportOptions['onAwaiting'];
  /** Stable chat id. Default: one per hook instance. */
  readonly id?: string;
}

export interface BroappChatHook extends UseChatHelpers<BroappUIMessage> {
  confirm(callId: string, approve: boolean): Promise<void>;
  /** Set when `confirm` was refused; cleared on the next send. */
  readonly confirmError: string | null;
  /** From the last assistant message's metadata. */
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  /** Calls waiting for a person, right now. */
  readonly awaiting: number;
  clear(): void;
}

export function useBroappChat(options?: BroappChatOptions): BroappChatHook;
```

Use the exact helpers type name `@ai-sdk/react` exports (check the
`.d.ts`; it may not be `UseChatHelpers`). Build the transport once in a
`useRef`; read `refs`, `onToolResult` and `onAwaiting` through refs updated
every render, the way `use-ai-chat.ts` does with `refsRef`. On unmount call
`transport.cancel()`. `clear()` = `stop()` then `setMessages([])`.
`awaiting` is state driven by the transport's `onAwaiting` before the
user's own callback is called.

`src/index.ts` exports `createBroappChatTransport`, `useBroappChat`, and
the types above.

Verify: `bun run typecheck` exit 0.

## Step 4 — tests

### `tests/ai-elements-transport.test.ts`

Copy the `start()` scaffold, `appContract`, `LIBRARY` and `noNetwork` from
`tests/ai-chat.test.ts` (do not refactor that file). Get a client with
`started.harness.connect(merged)` and build the transport with
`client: () => Promise.resolve(client)` and `runId: () => 'run-' + n`.

Two helpers: `chunks(stream)` collects every chunk into an array;
`fold(stream)` runs `readUIMessageStream({ stream })` from `ai` and returns
the last snapshot. Every case that asserts on parts uses `fold`, so the
SDK's own processor validates the sequence.

Cases:

1. **A plain reply.** Chunk types are exactly
   `start, text-start, text-delta, text-delta, message-metadata, text-end, finish`
   for a two-chunk script (`usage` arrives before `done`, so
   `message-metadata` precedes `text-end` — assert what you observe and
   explain the order in a comment). Folded: one text part `'Hello'`,
   `metadata.usage.inputTokens` is a number.
2. **History.** Send three messages (user, assistant, user) and assert the
   fake adapter's first call carries both earlier turns and the new
   message, in order, and no tool parts. An empty assistant message is not
   sent.
3. **A read tool** (`notes.list` under `read`). Folded: a tool part with
   `state === 'output-available'` and `output.titles`, then a text part.
   `onToolResult` was called once with `status: 'done'`.
4. **A confirm tool, approved.** Script `notes.create` under `confirm`.
   Start folding in the background; `until()` the transport reports
   `onAwaiting(1)`; call `transport.confirm(callId, true)`; then the folded
   message has the tool part `state === 'output-available'` and
   `approval.approved === true`, the operation ran once, `onAwaiting` ended
   at 0, `onToolResult` got `done`.
5. **Declined.** Same, `confirm(callId, false)`: `state === 'output-denied'`,
   `approval.approved === false`, the operation did not run,
   `onToolResult` got `denied`.
6. **Expired.** `confirm('nobody', true)` rejects with
   `'That request has expired.'`; a real awaiting call answered twice
   rejects the second time.
7. **Cancel.** `chunkDelayMs: 50`, abort the `AbortSignal` after the first
   `text-delta`. The stream closes without `finish`; the folded text is
   non-empty and shorter than the script; `until(() => ai.activeStreams() === 0)`
   (use whatever `tests/ai-chat.test.ts` uses for this).
8. **Two sends.** A second `sendMessages` while the first runs yields
   exactly one `error` chunk with `'A reply is still being written.'` and
   starts no second run (`adapter.modelCalls` unchanged).
9. **Attachments refused.** A user message with a `file` part yields one
   `error` chunk `'This version cannot send attachments yet.'` and never
   subscribes.
10. **Not set up.** `skipSetup: true`: the folded result carries the host's
    sentence in an `error` chunk (assert the chunk, since `readUIMessageStream`
    may throw on `error`; use `terminateOnError` as the `.d.ts` describes).
11. **Regenerate.** `trigger: 'regenerate-message'` with `messages` ending
    in a user message behaves as case 1.

### `tests/build.test.ts`

Add a case like the `broapp/ai/react` one: a browser bundle importing
`createBroappChatTransport` and `useBroappChat` from `broapp-ai-elements`
builds, and the HTML contains none of `node:fs`, `streamText`, `createAi`,
`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`. Do **not** forbid the
bare string `@ai-sdk/` here — `@ai-sdk/react` and `@ai-sdk/provider-utils`
are legitimately in this bundle — and say so in a comment. Run the same
off-origin check.

### `tests/ai-engine-boundary.test.ts`

Unchanged. Must still pass.

## Verify

```bash
bun install
bun run typecheck
bun test tests/ai-elements-transport.test.ts
bun test tests/build.test.ts
bun run check
```

All exit 0.

## Report

`prompts/ai-elements/reports/01-transport.md`. Include: the exact chunk
order you observed for cases 1, 4 and 5; what `messages` contains on
`regenerate-message`; the helpers type name in `@ai-sdk/react`; any
`.d.ts` name that differed from this prompt; the bundle size of the new
browser bundle in KiB.

Commit:

```
Add broapp-ai-elements with a Brobridge transport for the AI SDK's useChat
```
