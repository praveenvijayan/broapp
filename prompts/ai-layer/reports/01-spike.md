# 01 — AI SDK compile spike

Verdict: **SPIKE PASSED**. Pinned in `.broapp-tmp/ai-spike/` (own `package.json`, own `bun install`):
`ai@7.0.93`, `@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai-compatible@3.0.44`.
Bun 1.4.0, macOS arm64. Nothing outside `.broapp-tmp/` and this report changed.

## API names, read from the installed `.d.ts` files

| What | Confirmed name / shape | Source line |
|---|---|---|
| Stream text | `streamText({ model, prompt \| messages, tools, abortSignal, maxRetries, stopWhen, onError, ... })` | `ai:3472` |
| Abort | `abortSignal?: AbortSignal` (a `timeout` option also exists) | `ai:650` |
| All parts | `result.fullStream: AsyncIterableStream<TextStreamPart<TOOLS>>` | `ai:2801` |
| Text delta | `{ type: 'text-delta'; id: string; text: string }`, bracketed by `text-start` / `text-end` (`{ id }`) | `ai:2884` |
| Finish / error | `{ type: 'finish'; finishReason; rawFinishReason; totalUsage }`, per step `'finish-step'`, cancellation `'abort'`; `{ type: 'error'; error: unknown }` | `ai:2986,2997` |
| Tool call / result | `{ type: 'tool-call' } & TypedToolCall`, `{ type: 'tool-result' } & TypedToolResult`; failures are a separate `'tool-error'` part | `ai:2955` |
| JSON schema / tool | `jsonSchema<OBJECT>(schema, { validate? }): Schema<OBJECT>`; `tool(...)` (five overloads), plus `dynamicTool(...)` | `provider-utils:849,2139` |
| Step limit | `stepCountIs` is an alias of `isStepCount(n): StopCondition`, passed as `stopWhen` | `ai:1800,9744` |
| Model type | `type LanguageModel = GlobalProviderModelId \| LanguageModelV4 \| V3 \| V2` | `ai:112` |
| Test doubles | `ai/test` exists, exports `MockLanguageModelV4` (and `V3`); `simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs })` is exported from both `ai` and `ai/test` (reviewer correction) | `ai/package.json:38`, `ai:7803` |
| Anthropic | `createAnthropic({ apiKey?, baseURL?, headers?, fetch? })`; provider callable — `anthropic('claude-opus-5')`, also `.languageModel/.chat/.messages` | `anthropic:1243,1268,1305` |
| Compatible | `createOpenAICompatible({ baseURL, name, apiKey?, headers?, queryParams?, fetch?, includeUsage? })` — `baseURL` and `name` required; callable, also `.chatModel` | `openai-compatible:310,322,384` |

Where the prompt's expectation differed: `stepCountIs` is an alias of
`isStepCount`; `jsonSchema` and `tool` are defined in
`@ai-sdk/provider-utils` and re-exported by `ai`, so importing from `ai` is
still correct; the useful mock is `MockLanguageModelV4`, not `V3`.

## Step 4 — `bun run spike.ts`, exit 0

```json
{ "seen": ["https://api.anthropic.com/v1/messages", "http://127.0.0.1:11434/v1/chat/completions"],
  "ok": true,
  "providerErrors": { "anthropic": "network disabled in spike", "compatible": "network disabled in spike" },
  "stringModelId": { "gatewaySeen": ["https://ai-gateway.vercel.sh/v4/ai/language-model"],
    "gatewayError": "AI Gateway authentication failed: No authentication provided.",
    "gatewayErrorWithKey": "Gateway request failed: network disabled in spike" } }
```

One request per provider, to the configured host only; no `vercel`, no
`gateway`. `maxRetries: 0`, so no retry can disguise a second host.

## Step 5 — six targets, `--compile --target=bun-<id> --minify --bytecode`

| Target | baseline | spike | delta |
|---|---:|---:|---:|
| darwin-arm64 | 63,910,514 | 70,845,554 | +6,935,040 |
| darwin-x64 | 70,704,544 | 77,585,824 | +6,881,280 |
| linux-x64 | 82,535,624 | 89,421,000 | +6,885,376 |
| linux-arm64 | 82,495,480 | 89,376,760 | +6,881,280 |
| linux-x64-musl | 76,281,304 | 83,166,680 | +6,885,376 |
| windows-x64 | 88,818,176 | 95,703,552 | +6,885,376 |

All twelve compiles succeeded; no `--external` was needed. ~6.88 MB in every
target. Native `./out/darwin-arm64/spike` exits 0 and prints the same `seen`
list as the interpreted run.

## The string-model-id trap

`streamText({ model: 'anthropic/claude-opus-5' })` ignores every configured
provider, goes to `https://ai-gateway.vercel.sh/v4/ai/language-model`, and
uses the **global** `fetch`, so an injected one never sees it. The AI layer
must always pass a provider *instance* as `model`, never a string, and a
later prompt should keep a test asserting that.

## Decisions I made

- `--bytecode`, which `build-binary.ts` passes by default, rejects
  **top-level `await`**: `error: "await" can only be used inside an "async"
  function`. The first six compiles failed on exactly that, so `spike.ts`
  wraps its awaits in `async function main()`. Any AI host entry point must
  do the same.
- `spike.ts` patches `globalThis.fetch` for the string-model call only,
  because the gateway accepts no injected `fetch`. It is a throwaway script
  under `.broapp-tmp/`, not a repository test; the rule still holds for
  `tests/`.

## Open questions

- ~6.9 MB per binary would be paid even by applications that never enable
  AI, so prompt 02 onward should keep `ai` an optional peer dependency.
