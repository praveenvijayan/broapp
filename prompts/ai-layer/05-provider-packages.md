# 05 — Provider packages: Anthropic and OpenAI-compatible

## Goal

Two workspace packages, each wrapping one `@ai-sdk/*` provider behind the
`ProviderAdapter` interface from prompt 03. Together they cover Anthropic,
OpenAI, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter and any other server
that speaks the OpenAI chat API. No network in tests: every adapter takes
`fetch` from `AdapterConfig`.

## Read first

- `prompts/ai-layer/00-common-rules.md` and reports 01–04.
- `packages/broapp/src/ai/host/adapter.ts` and `fake.ts`.
- `packages/broapp/package.json` and `packages/create-broapp/package.json` — copy the metadata style (license, repository with `directory`, `files`, `publishConfig`, `engines`).
- `node_modules/@ai-sdk/anthropic/dist/index.d.ts` — `createAnthropic` options (`apiKey`, `baseURL`, `fetch`) and how to get a model.
- `node_modules/@ai-sdk/openai-compatible/dist/index.d.ts` — `createOpenAICompatible` options (`name`, `baseURL`, `apiKey`, `fetch`, headers) and how to get a chat model.
- `reports/01-spike.md` — the constructor names you already confirmed.

## Package 1 — `packages/broapp-ai-anthropic`

`package.json`: name `broapp-ai-anthropic`, version `0.1.0`, `"type": "module"`,
`exports: { ".": "./src/index.ts" }`, `dependencies: { "@ai-sdk/anthropic": "4.0.49", "ai": "7.0.93" }`,
`peerDependencies: { "broapp": ">=0.1.0" }`, `devDependencies: { "broapp": "workspace:*", "@types/bun": "^1.2.0", "typescript": "^5.7.2" }`.

`src/index.ts` exports `anthropic(): ProviderAdapter` with:

| Field | Value |
|---|---|
| `id` | `'anthropic'` |
| `label` | `'Anthropic'` |
| `needs` | `{ apiKey: true, baseUrl: 'optional' }` |
| `defaultBaseUrl` | `'https://api.anthropic.com'` |
| `local(config)` | `isLoopbackUrl(config.baseUrl ?? defaultBaseUrl)` |

`models(config, signal)`: `GET <baseUrl>/v1/models?limit=100` with headers
`x-api-key: <key>` and `anthropic-version: 2023-06-01`, using `config.fetch`.
Follow `has_more` / `after_id` pagination up to 5 pages. Map each entry to a
`BroappModel` with `label = display_name ?? id` and capabilities all
`true`. Sort so ids containing `opus` come first, then `sonnet`, then
`haiku`, then the rest, each group newest first by `created_at`.

Response status mapping, in `toAdapterError(status, bodyText)`:

| Status | `AdapterError` |
|---|---|
| 401, 403 | `auth`, `'Anthropic rejected the API key.'` |
| 404 | `not_found`, `'That model was not found.'` |
| 429 | `rate_limited`, `'Anthropic is rate limiting requests. Try again shortly.'` |
| 5xx | `provider`, `'Anthropic returned a server error.'` |
| fetch threw | `network`, `'Could not reach Anthropic. Check your connection and the server URL.'` |
| other | `provider`, `'Anthropic returned an unexpected response (<status>).'` |

Never put the body text in the message. Attach it as `cause`.

`test(config, signal)`: call `models()` and discard the result. Listing
models costs no tokens and proves the key.

`model(config, modelId)`: `createAnthropic({ apiKey, baseURL, fetch })`
then the model for `modelId`. If `config.apiKey` is null throw
`AdapterError('auth', 'An API key is required for Anthropic.')`.

Do not add prompt caching, effort or thinking options here. A later prompt
may pass `providerOptions`; keep the surface minimal.

## Package 2 — `packages/broapp-ai-compatible`

`package.json` like the first, name `broapp-ai-compatible`, dependency
`"@ai-sdk/openai-compatible": "3.0.44"`.

`src/index.ts` exports a factory and three presets:

```ts
export interface CompatibleOptions {
  readonly id: string;
  readonly label: string;
  readonly needs: { apiKey: boolean; baseUrl: 'required' | 'optional' };
  readonly defaultBaseUrl: string | null;
  /** Sent as the OpenAI-compatible provider `name`. Default: `id`. */
  readonly name?: string;
}
export function openaiCompatible(options: CompatibleOptions): ProviderAdapter;

export const ollama = (): ProviderAdapter =>
  openaiCompatible({ id: 'ollama', label: 'Ollama (local)', needs: { apiKey: false, baseUrl: 'optional' }, defaultBaseUrl: 'http://127.0.0.1:11434/v1' });

export const openai = (): ProviderAdapter =>
  openaiCompatible({ id: 'openai', label: 'OpenAI', needs: { apiKey: true, baseUrl: 'optional' }, defaultBaseUrl: 'https://api.openai.com/v1' });

export const customServer = (): ProviderAdapter =>
  openaiCompatible({ id: 'openai-compatible', label: 'OpenAI-compatible server', needs: { apiKey: false, baseUrl: 'required' }, defaultBaseUrl: null });
```

`local(config)`: `isLoopbackUrl(baseUrl)` where baseUrl is
`config.baseUrl ?? defaultBaseUrl ?? ''`.

`models`: `GET <baseUrl>/models` with `Authorization: Bearer <key>` when a
key is set. Body `{ data: [{ id, ... }] }`. Label is `id`. Capabilities:
`tools: true, vision: false, structuredOutput: false` — conservative, the
server does not say. Sort by id. Same status mapping as above with the
label substituted for "Anthropic". Ollama's endpoint returns the same
shape, which is why one adapter covers it.

`test`: `models()`.

`model`: `createOpenAICompatible({ name, baseURL, apiKey, fetch })` then
the chat model for `modelId`. Throw `AdapterError('auth', …)` if a key is
required and missing; throw `AdapterError('provider', 'A server URL is required.')`
if `needs.baseUrl === 'required'` and none is set.

## Tests

`tests/ai-providers.test.ts`. Build a `fetch` stub per test:

```ts
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch
```

Cases for each adapter:

1. `models()` sends the right URL, headers and returns mapped models in the specified order (Anthropic: give three entries with opus/haiku/sonnet ids out of order; assert the order).
2. Anthropic pagination: first page `has_more: true`, second page `has_more: false` → both pages' models returned, second request carries `after_id`.
3. Status → `AdapterError` code for 401, 404, 429, 500, and a thrown fetch. Assert the message does **not** contain the body text (`'super-secret-body'`).
4. `local()` for loopback vs remote base URLs, and for the null baseUrl default.
5. `model()` without a required key throws `AdapterError('auth')`; compatible without a required URL throws `AdapterError('provider')`.
6. Ollama preset: `models()` hits `http://127.0.0.1:11434/v1/models` with no `Authorization` header.

Then one real-bridge test in the same file: `createAi` with
`providers: [anthropic(), ollama()]` and `fetch: stubFetch(...)` — set
provider `anthropic`, set a key, `ai.models.list` returns the stubbed
models, `ai.connection.test` returns `ok: true`, and `ai.providers.list`
reports Anthropic `local: false` and Ollama `local: true`.

## Workspace wiring

- Root `tsconfig.json` `include` already has `packages/*/src/**`; confirm both packages typecheck under `bun run typecheck`.
- Root `package.json` `workspaces` already has `packages/*`. Run `bun install` and commit `bun.lock`.
- Add both packages to whatever list `scripts/release-dry-run.ts` and `scripts/pack-local.ts` iterate over, if they enumerate packages explicitly. Read those scripts; if they hardcode `broapp` and `create-broapp`, add the two new names. Run `bun run dryrun` and make sure it still passes. Do not publish.

## Verify

```bash
bun install
bun run check
bun run dryrun
```

## Report

`prompts/ai-layer/reports/05-providers.md`.

Commit:

```
Add the Anthropic and OpenAI-compatible provider packages
```
