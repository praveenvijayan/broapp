# 01 — The Brobridge transport for `useChat`

## What was built

`packages/broapp-ai-elements` (`broapp-ai-elements@0.2.1`), exporting
`createBroappChatTransport` and `useBroappChat` from `.`:
- `src/transport.ts` — a `ChatTransport<BroappUIMessage>` over `ai.chat`: it
  assembles history, refuses a second turn and an attachment, maps every
  `ChatEvent` to `UIMessageChunk`s, answers a confirmation with
  `ai.chatConfirm`, and cancels the host on abort or reader cancel.
  `reconnectToStream` returns `null`.
- `src/use-broapp-chat.ts` — `useChat` with that transport, plus `confirm`,
  `confirmError`, `usage`, `awaiting`, `clear`.
- `tests/ai-elements-transport.test.ts` — 14 cases over a real bridge and the
  fake adapter; every part assertion folds with `readUIMessageStream`.
- `tests/build.test.ts` — one case more: the browser bundle builds clean.

Wired in: root `package.json`, `scripts/pack-local.ts` `PUBLISHED`,
`.github/workflows/publish.yml` (matrix option and publish step). The root
`tsconfig.json` uses `packages/*/src` globs, so it needed nothing. Docs and
package tables are prompt 04's; the provider hits were left alone.

## Observed chunk order

1. **A plain reply** — `start, text-start, text-delta, text-delta,
   message-metadata, text-end, finish`. The host emits `usage` before `done`,
   and `done` closes the text part, so `message-metadata` precedes `text-end`.
   The SDK attaches metadata to the message, not to the open part.
4. **A confirm tool, approved** — `start, tool-input-start,
   tool-input-available, tool-approval-request, tool-approval-response,
   tool-output-available, text-start, text-delta, message-metadata, text-end,
   finish`.
5. **Declined** — the same, with `tool-output-denied` for `-available`.

## Answers the prompt asked for

- **`regenerate-message`**: `Chat.regenerate` (`ai/dist/index.js` ~18957)
  slices `state.messages` to `messageIndex` when that message is an assistant
  one, so `messages` always ends in the user message — as a submit does.
- **Helpers type name**: `UseChatHelpers<UI_MESSAGE>`, exported from
  `@ai-sdk/react` — as the prompt guessed.
- **`.d.ts` differences**: none; every name the prompt uses is `ai@7.0.93`'s.
- **Bundle size**: a page importing both exports builds to **223.1 KiB**.
- **`react`**: 19.2.8 satisfies `@ai-sdk/react`'s peer range
  (`^18 || ~19.0.1 || ~19.1.2 || ^19.2.1`), so nothing was raised.

## Decisions I made

- **The turn is owned before the subscription opens**: `client()` and
  `subscribe` both await, and a second send in that window would start a
  second run.
- **The stream closes on `cancel()`, not only the subscription.** A stream that
  never ends leaves `useChat` streaming for ever, so cancelling closes the
  controller too — with no `finish` and no `error`, so the text so far stays
  and the SDK returns to `ready`.
- **`emit`/`close` are guarded** (a reader that let go first makes `enqueue`
  throw) and **`aborted` is read through a function** (TypeScript keeps its
  first narrowing across the `await` where the value changes).
- **`confirm` rejects rather than setting an error.** The transport has no
  state a panel reads; `useBroappChat` catches it into `confirmError`.
- **The confirm cases read the call id off the stream.** A `watch()` helper
  records every chunk, so a test answers the call the host actually asked
  about rather than guessing an id.

## Commands run

```
bun install                                   # 6 packages installed
bun run typecheck                             # exit 0
bun test tests/ai-elements-transport.test.ts  # 14 pass, 0 fail
bun test tests/build.test.ts                  # 18 pass, 0 fail
bun run check                                 # 484 pass, 0 fail, 32 files
```

## Open questions

- `styles.css` is listed in `files` but does not exist until prompt 03.
  `bun pm pack --dry-run` accepts that; `npm publish` may warn.
- `useBroappChat` has no DOM test, by design: the tests are non-DOM, nothing
  adopts the hook until prompt 04, and the transport it wraps is covered.
