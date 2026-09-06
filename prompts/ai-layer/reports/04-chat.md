# 04 — The chat run loop

`bun run check` exit 0. `bun test tests` → `192 pass, 0 fail` across 17 files,
`tests/ai-chat.test.ts` contributing 15.

## What was built

- `ai/host/tool.ts` — `AiTool`, `AiContextProviders`, `ContextRef`,
  `ContextDocument`, and `createConfirmations()`. Split out so `run.ts` and
  `from-contract.ts` share them without importing each other.
- `ai/host/from-contract.ts` — `fromContract(contract, app, { read, confirm })`.
- `ai/host/run.ts` — `runChat`, context assembly, the system prompt, the tool
  wrapper and the `fullStream` loop. `ai/host/run-types.ts` derives
  `StreamChatParams` and `ChatEvent` from the contract.
- `create-ai.ts` — the new options, the tool-name check, and the real `ai.chat`
  and `ai.chatConfirm` handlers replacing the prompt-03 placeholders.
- `fake.ts` — scripted turns, `calls`, `modelCalls`, `aborted`, `chunkDelayMs`.

## The `fullStream` part types actually seen from the mock

For a text step: `start`, `start-step`, `text-start`, `text-delta` (one per
chunk), `text-end`, `finish-step`, `finish`. For a tool step: `start`,
`start-step`, `tool-input-start`, `tool-input-delta`, `tool-input-end`,
`tool-call`, `tool-result`, `finish-step`, then the next step's parts.

Only `text-delta`, `finish`, `error`, `tool-error` and `abort` are acted on.
Two details differ from what a reading of the `.d.ts` suggests:

- The `ai`-level `text-delta` carries `text`; the *provider*-level part the
  mock emits carries `delta`. They are different types with the same name.
- `part.totalUsage` on the `finish` part is flat (`inputTokens: number`), while
  the provider-level `usage` the mock must emit is nested
  (`inputTokens: { total, noCache, cacheRead, cacheWrite }`). Report 03 gave
  the nested one; the run loop needs the flat one.

## How the fake builds a tool-call stream

The script is flattened depth-first — a `tool` step is followed by its `then`
steps — and a counter advances one entry per `doStream` call, because
`streamText` calls the model once per step of its agent loop. A tool step emits

```ts
{ type: 'tool-call', toolCallId: `call-${index}`, toolName, input: JSON.stringify(input) }
{ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
```

`input` must be a JSON *string*; the SDK parses it. A text step finishes with
`unified: 'stop'`. The returned stream is wrapped so an aborted `abortSignal`
closes it mid-flight, and `doStream` rejects with an `AbortError` if the signal
is already aborted when it is called.

## Decisions I made

- **`s.void()` inputs are normalised in `fromContract`.** A void input is
  described to the model as `{"type":"object","properties":{},...}` — a tool's
  arguments have to be an object — so the model sends `{}`, which `s.void()`
  refuses with `value: expected no value`. Any no-argument operation offered as
  a tool would have failed every call. `fromContract` passes `undefined` to
  `invoke` for those routes.
- **A tool's public message survives `invoke`.** `HostApp.invoke` hands back
  the marked bridge error the browser would have seen, not the original
  `PublicError`, so `safeToolMessage` reads the marker back with
  `fromTransportError`. Without it every deliberate `publicError.notFound(...)`
  from a tool became "The tool failed."
- `onError: () => undefined` is passed to `streamText`: its default handler
  prints the whole error, and this layer decides for itself what is safe to
  say.
- The cancel test asserts that the stream does not reach `done` and that
  `activeStreams` returns to 0, rather than pinning an exact event count — a
  couple of events are legitimately in flight when `CANCEL` is sent.

## Open questions

- `maxSteps` is enforced with `stopWhen: stepCountIs(n)`. When the model hits
  the limit the turn ends with `done` and no explanation; the browser cannot
  tell that from a finished answer. Prompt 06 may want a `finishReason` on the
  `usage` event.
