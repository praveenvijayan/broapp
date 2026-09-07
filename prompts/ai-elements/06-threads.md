# 06 — Threads: conversations that persist, each with its own model

## Goal

A conversation is a **thread** the host keeps in SQLite under the data
directory. A thread has a title, a model of its own, and its messages.
`useBroappChat({ threadId })` loads a thread, saves after every turn, and
sends the thread's model with each `ai.chat`. No visual change yet; prompt
07 builds the workspace on top. This is the "Threads persistence" item
from `prompts/ai-layer/08-phase-2-backlog.md`, done.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–04d.
- `packages/broapp/src/ai/shared/{contract,types}.ts`.
- `packages/broapp/src/ai/host/registry.ts` — `resolve()`, `ResolvedModel`,
  how `settings.modelId` reaches `runChat`. `create-ai.ts` lines ~140–215.
- `packages/broapp/src/ai/host/run.ts` — where the resolved model is
  used; the vision check from prompt 02 (it lists models; reuse it).
- `examples/notes/src/host/db.ts` and `app.ts` lines 110–140 — the
  `bun:sqlite` migration pattern (`PRAGMA user_version`, migrations in
  order, one `Database`). Copy the shape, not the file.
- `packages/broapp/src/ai/host/settings.ts` — how `<dataDir>/ai/` is
  created and files under it are owned.
- `packages/broapp-ai-elements/src/{transport,use-broapp-chat}.ts`.
- `node_modules/@ai-sdk/react/dist/index.d.ts` — `useChat`'s `messages`
  init option and `setMessages`; `onFinish` callback shape.
- `tests/ai-host.test.ts` — how settings routes are tested over the
  harness.

Lifted for this prompt only: `registry.ts` may gain a `modelId` override
on `resolve()`; `create-ai.ts` may mount the thread routes; `settings.ts`
is still off limits.

## Step 1 — the contract

Route group `ai`, added to `aiContract`:

```ts
const threadId = s.string({ pattern: /[A-Za-z0-9_-]{8,64}/ });
const thread = s.object({
  id: threadId,
  title: s.string({ max: 120 }),
  /** Null means "whatever Settings says". */
  modelId: s.nullable(s.string({ max: 200 })),
  createdAt: s.number(),
  updatedAt: s.number(),
  messageCount: s.number({ int: true, min: 0 }),
});
/** One stored UI message. Parts are the AI SDK's; the host stores, never interprets. */
const storedMessage = s.object({
  id: s.string({ max: 200 }),
  role: s.enum(['user', 'assistant', 'system']),
  parts: s.array(s.unknown(), { max: 200 }),
  metadata: s.optional(s.unknown()),
});
```

Operations:

| Route | Input | Output |
|---|---|---|
| `ai.threadsList` | `void` | `{ threads: thread[] }` newest `updatedAt` first, max 500 |
| `ai.threadsCreate` | `{ title?: string(≤120), modelId?: string\|null }` | `thread` |
| `ai.threadsGet` | `{ id }` | `{ thread, messages: storedMessage[] }` |
| `ai.threadsSave` | `{ id, messages: storedMessage[] (≤200), title?: string }` | `thread` — replaces the messages whole |
| `ai.threadsUpdate` | `{ id, title?: string, modelId?: string\|null }` | `thread` |
| `ai.threadsDelete` | `{ id }` | `{ deleted: boolean }` |
| `ai.threadsClear` | `void` | `{ deleted: number }` — every thread |

`ai.chat` params gain `modelId: s.optional(s.string({ max: 200 }))`. When
present it overrides the configured model for that turn only, **within
the configured provider**. The provider is never overridden per turn: a
different provider means a different key and a different "does this leave
my computer" answer, and that stays a Settings decision.

Types for all of it in `types.ts`, re-exported from `broapp/ai` and the
type list in `broapp/ai/react/index.tsx` (types only, as prompt 02 did).

## Step 2 — the host

`packages/broapp/src/ai/host/threads.ts`:

- `openThreads(dataDir)` → `ThreadStore` over `<dataDir>/ai/threads.sqlite`
  with migrations in the notes example's shape. Tables `threads(id, title,
  model_id, created_at, updated_at)` and `messages(thread_id, position,
  json)`, `messages` cascading on thread delete. One `Database`, WAL on.
- Messages are stored as JSON text. **Before storing, every `file` part is
  replaced** by `{ type: 'text', text: '[image: <filename or mediaType>]' }`
  and the `metadata` is kept. A data URL in SQLite is a copy of the image
  nobody asked to keep, and the history the model sees already uses that
  placeholder (prompt 02). Say so in a comment and in `docs/ai.md`.
- A stored message must never carry a secret: assert in a test that the
  JSON of a saved thread does not contain a configured key.
- Title: `ai.threadsCreate` without `title` → `'New conversation'`.
  `ai.threadsSave` with `title` sets it; without, and while the title is
  still the default, the store derives one from the first user message's
  text (first 60 characters, whitespace collapsed).
- `ai.threadsSave` bumps `updatedAt`; `ai.threadsUpdate` does too.
- `ai.threadsGet` on an unknown id → `publicError.notFound('That conversation is gone.')`.
- Every route answers even when no provider is configured: threads are the
  user's data, not the provider's.

`registry.ts`: `resolve(override?: { modelId?: string })`. An override
replaces `settings.modelId` **after** the provider and key checks, so
"AI is not set up yet" still comes first. `run.ts` / `create-ai.ts` pass
`params.modelId` through. The vision check from prompt 02 uses the
resolved id, so it follows automatically; confirm with a test.

`create-ai.ts`: `createAi` opens the store lazily on first thread route,
closes it on `shutdown` (find how the host app closes things; the notes
example's `db.close()` is the model). Mount the seven routes.

## Step 3 — the browser

`transport.ts`: `BroappChatTransportOptions.modelId?(): string | null`;
sent as `modelId` when non-null.

`use-broapp-chat.ts`:

```ts
export interface BroappChatOptions {
  // existing…
  /** Load this thread on mount and save it after every turn. Null: in-memory only, as today. */
  readonly threadId?: string | null;
  /** Sent with every turn. Null: the configured model. */
  readonly modelId?: string | null;
}
export interface BroappChatHook {
  // existing…
  /** True while a thread is loading; the panel shows a quiet state, not "empty". */
  readonly loading: boolean;
}
```

- On mount and whenever `threadId` changes: `stop()`, `setMessages([])`,
  then `ai.threadsGet` and `setMessages(messages)`; a `notFound` clears
  and reports `error`. Guard against a late load replacing a newer
  thread's messages (generation counter, as `use-ai-models.ts` does).
- After every turn ends (`onFinish`, and also after `stop()` and after an
  `error`, since text so far is kept): `ai.threadsSave({ id, messages })`
  with the current messages. Save failures are reported through `error`
  and do not block the next send.
- `clear()` with a thread: `ai.threadsSave({ id, messages: [] })` then
  `setMessages([])`.

Also export from the package root: `useAiThreads()` — a small hook over
the seven routes: `{ threads, loading, error, create(title?, modelId?),
rename(id, title), setModel(id, modelId), remove(id), clearAll(), refresh() }`.
Optimistic updates are not required; refetch after each write is fine.

## Step 4 — tests

`tests/ai-threads.test.ts` over the harness with the fake adapter:

1. Create, list, get, save, update, delete, clear — round trip, ordering
   by `updatedAt`, `messageCount`.
2. A `file` part in saved messages comes back as the placeholder text
   part; the SQLite file does not contain the data URL.
3. Title derived from the first user message; explicit title wins;
   renaming sticks across saves.
4. Unknown id → `not_found` with the sentence.
5. Works with no provider configured.
6. A saved thread's JSON does not contain the configured API key
   (configure the fake with a key first).
7. `ai.chat` with `modelId` reaches the adapter with that id
   (`adapter.modelCalls`), and without it uses Settings'.
8. `modelId` on a turn while nothing is configured still says
   "AI is not set up yet…".
9. The store survives a restart: stop the harness, start another on the
   same `dataDir`, list again.

`tests/ai-elements-transport.test.ts`: `modelId()` is sent when set.
`tests/ai-contract.test.ts`: the new schemas validate and refuse.
`tests/ai-chat.test.ts` unchanged.

## Docs

`docs/ai.md`: a "Conversations" section — where they live, what is
stored, images become placeholders, the per-thread model within the
configured provider, `useAiThreads`, and a "Clear all conversations" note
for prompt 07's settings drawer. "Limitations": remove "No persisted
conversations"; add "images are not stored".

## Verify

```bash
bun run typecheck
bun test tests/ai-threads.test.ts tests/ai-contract.test.ts tests/ai-elements-transport.test.ts tests/ai-chat.test.ts
bun run check
cd examples/notes && bun run build && cd ../..
```

## Report

`prompts/ai-elements/reports/06-threads.md`: the schema, where `resolve`
takes the override and why there, how the store is closed on shutdown,
the size of `threads.sqlite` after test 2.

Commit:

```
Keep conversations in SQLite, each with its own model, and load them into useChat
```
