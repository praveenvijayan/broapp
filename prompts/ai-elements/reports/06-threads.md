# 06 — Threads: conversations that persist, each with its own model

## What was built

- **Contract**: `thread`, `storedMessage` and seven `ai.threads*` operations in
  `contract.ts`; `modelId` on `ai.chat`. `Thread` and `StoredMessage` in
  `types.ts`, pinned by two new `types.check.ts` assertions and re-exported
  from `broapp/ai` and `broapp/ai/react`.
- **Host**: `packages/broapp/src/ai/host/threads.ts` — `openThreads(dataDir)`
  over `<dataDir>/ai/threads.sqlite`, migrations in the notes example's shape,
  `threads` + `messages` with `ON DELETE CASCADE` and `PRAGMA foreign_keys`.
  Exported from `broapp/ai/host` as `openThreads` / `ThreadStore` /
  `DEFAULT_THREAD_TITLE`.
- **`registry.resolve(override?)`**, `run.ts` passing `params.modelId`,
  `create-ai.ts` mounting the seven routes and gaining `Ai.close()`;
  `examples/notes/src/host/app.ts` calls it in `shutdown`.
- **Browser**: `BroappChatTransportOptions.modelId?()`; `useBroappChat`
  gains `threadId`, `modelId` and `loading`; new `use-ai-threads.ts` exporting
  `useAiThreads`, both from the package root.
- **Tests**: `tests/ai-threads.test.ts` (9), five more in `ai-contract.test.ts`,
  one more in `ai-elements-transport.test.ts`. `ai-chat.test.ts` untouched.
- **Docs**: a "Conversations" section in `docs/ai.md`; "No persisted
  conversations" in Limitations replaced by "Images are not stored".

## The schema

```sql
threads  (id TEXT PK, title TEXT NOT NULL, model_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
messages (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          position INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (thread_id, position))
```

`messageCount` is a correlated `COUNT(*)`, so it cannot drift from the rows.
One migration, `user_version = 1`. Ids are `crypto.randomUUID()` without its
dashes — 32 characters, inside the contract's `[A-Za-z0-9_-]{8,64}`.

**`threads.sqlite` after test 2 is 24,576 bytes** — three 8 KiB pages, the
empty-schema size. The one-pixel PNG contributes nothing, which is the point:
the row holds `[image: shot.png]`, and the test reads the file back to prove
the base64 is not in it.

## Where `resolve` takes the override, and why there

`resolve(override?: { modelId?: string })` applies it *after* the provider, the
key and the base-URL checks and *before* the "choose a model" check. Earlier
would let a per-turn model paper over "AI is not set up yet" — the first thing
somebody has to fix is the first thing they should be told. Later would be a
second place that decides what the model is. Because `run.ts` resolves once,
the vision check from prompt 02 and the `adapter.model(...)` instance both
follow the override with no second code path; the new test proves the id
reaches `model()` and that the next turn is back on Settings'.

## How the store is closed

`Ai` gained `close()`, called from `examples/notes/src/host/app.ts`'s
`shutdown` beside `abortAll`. `abortAll` was not overloaded to do it: its
contract is "abort every open stream", and a future caller using it to stop
work without shutting down would silently close the database.
`packages/broapp-autoapp/src/launcher/tab.ts` also builds an `Ai` and is off
limits under common-rules §6 and regression guard 14, so the launcher's store
is left to process exit — a missed WAL checkpoint, not lost data. Prompt 07
touches the launcher and can add the one line.

## Decisions I made

- **`s.unknown()` on an input**, against its own doc comment. Nothing on the
  host reads inside a part, so there is no shape to validate; what is bounded
  is the amount — 200 parts, 200 messages, and a new `MAX_SAVE_CHARS`
  (4,000,000) in `threads.ts`, because the contract bounds the count and not
  the size. Said so in a comment at the schema.
- **Thread errors are reported through `error`.** `UseChatHelpers.error` is the
  SDK's and read-only, so the hook returns `chat.error ?? threadError`: a panel
  learns about a failed load or save without a second field.
- **Saving happens in `onFinish` only.** `ai/dist/index.js` calls it from a
  `finally`, so a finished turn, a stopped one (`isAbort`) and a failed one all
  reach it — the three cases the prompt lists, in one place. `useChat` reads
  `onFinish` off a live ref each call, so a fresh closure per render works.
- **The test records model ids in its own adapter**, wrapping
  `createFakeAdapter`: `FakeAdapter.modelCalls` is a count, and `fake.ts` is
  not this prompt's to change.
- **`clear()` saves the empty list.** Otherwise the next load brings back
  everything the person just cleared.

## `.d.ts` differences

None. Every name used — `ChatOnFinishCallback`, `UseChatHelpers.setMessages`
(a `useCallback` over a ref, so stable), `ChatInit.messages` — matches
`ai@7.0.93` and `@ai-sdk/react@4.0.96`.

## Commands run

```
bun run typecheck                                            # exit 0
bun test tests/ai-threads.test.ts                            # 9 pass, 0 fail
bun test tests/ai-contract.test.ts                           # 16 pass, 0 fail
bun test tests/ai-elements-transport.test.ts                 # 20 pass, 0 fail
bun test tests/ai-chat.test.ts                               # unchanged, passing
bun install && bun run check                                 # 564 pass, 0 fail, 37 files
cd examples/notes && bun run build                           # exit 0, 72.5 MiB
```

## Open questions

- **No panel uses a thread yet.** `BroappChat` does not take `threadId`, and
  nothing mounts `useAiThreads` — that is prompt 07's workspace. The hooks are
  covered by the host tests and the typechecker; neither has a DOM test, as in
  every earlier prompt in this series.
- **`ai.threadsSave` replaces the messages whole**, so a 200-message
  conversation rewrites 200 rows after every turn. Correct and simple at this
  size; if a conversation ever grows past the contract's bound it wants an
  append instead.
