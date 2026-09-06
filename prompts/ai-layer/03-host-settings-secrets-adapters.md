# 03 — Host runtime: settings, secrets, adapter interface, `createAi`

## Goal

`broapp/ai/host` exists and an application can mount it beside its own
operations. After this prompt the settings, providers, models and
connection-test routes work end to end over a real bridge, against a fake
adapter. Chat comes in prompt 04.

## Read first

- `prompts/ai-layer/00-common-rules.md` and both reports so far.
- `packages/broapp/src/host/app.ts`, `runtime.ts`, `paths.ts`, `index.ts`.
- `packages/broapp/src/shared/errors.ts` — `PublicError`, `publicError`.
- `packages/broapp/src/ai/shared/*` — what prompt 02 produced.
- `tests/harness.ts`, `tests/bridge.test.ts`, `tests/lifecycle.test.ts`.
- `examples/notes/src/host/main.ts` — how an application composes `startApp`.
- `node_modules/ai/dist/index.d.ts` — only to confirm the `LanguageModel` type name and the `ai/test` mock exports named in `reports/01-spike.md`.

## Dependencies

Add to the workspace root `package.json` `devDependencies`:

```
"ai": "7.0.93"
```

Add to `packages/broapp/package.json`:

```
"peerDependencies": { "react": ">=18", "ai": "7.0.93" },
"peerDependenciesMeta": { "react": { "optional": true }, "ai": { "optional": true } }
```

Run `bun install`. Check `tests/dependencies.test.ts` still passes (it only
looks at Brobridge packages; confirm, do not modify it).

## Files to create

All under `packages/broapp/src/ai/host/`:

```
index.ts        public exports
adapter.ts      ProviderAdapter, AdapterConfig, AdapterError
settings.ts     SettingsStore: settings.json read/write
secrets.ts      SecretStore interface, FileSecretStore, MemorySecretStore
registry.ts     resolves settings + adapters into "the current model"
create-ai.ts    createAi(): routes for settings/providers/models/test, mount, abortAll, activeStreams
fake.ts         createFakeAdapter() for tests and for applications' own tests
```

## Step 1 — `adapter.ts`

```ts
import type { LanguageModel } from 'ai';   // confirm the name in the .d.ts
import type { BroappModel } from '../shared/types.ts';

export interface AdapterConfig {
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  /** Injected so tests never touch the network. Defaults to globalThis.fetch. */
  readonly fetch: typeof fetch;
}

export type AdapterErrorCode = 'auth' | 'network' | 'not_found' | 'rate_limited' | 'provider';

/**
 * A failure an adapter reports deliberately. `message` is shown to the
 * user, so it must name the problem in plain words and never include a
 * key, a URL with credentials, or a raw provider response body.
 */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown });
}

export interface ProviderAdapter {
  readonly id: string;                 // 'anthropic', 'ollama', 'openai-compatible', 'fake'
  readonly label: string;
  readonly needs: { readonly apiKey: boolean; readonly baseUrl: 'required' | 'optional' | 'none' };
  readonly defaultBaseUrl: string | null;
  /** Whether requests stay on this machine under this config. */
  local(config: AdapterConfig): boolean;
  /** List models. Must reject with AdapterError on failure. */
  models(config: AdapterConfig, signal: AbortSignal): Promise<BroappModel[]>;
  /** Cheapest possible proof the config works. Must reject with AdapterError on failure. */
  test(config: AdapterConfig, signal: AbortSignal): Promise<void>;
  /** The AI SDK model. Only `broapp/ai/host` calls this. */
  model(config: AdapterConfig, modelId: string): LanguageModel;
}
```

Also export a helper `isLoopbackUrl(url: string): boolean` that returns
true for hosts `127.0.0.1`, `localhost`, `::1`, `[::1]`, and false for
everything else or an unparsable URL. Test it.

Export `toPublicError(cause: unknown): PublicError` in the same file:

| `AdapterError.code` | `PublicError` |
|---|---|
| `auth` | `publicError.rejected(message)` |
| `not_found` | `publicError.notFound(message)` |
| `network`, `rate_limited`, `provider` | `publicError.unavailable(message)` |
| anything that is not an `AdapterError` | rethrow unchanged (so the existing boundary logs it and the browser gets the fixed sentence) |

## Step 2 — `settings.ts`

Persisted shape, file `<dataDir>/ai/settings.json`:

```ts
interface StoredSettings {
  version: 1;
  provider: string | null;
  modelId: string | null;
  baseUrl: string | null;
  remember: boolean;      // default true
}
```

`createSettingsStore(dataDir: string)` returns `{ read(): StoredSettings; write(next: StoredSettings): void }`.

Rules:
- Missing file → defaults. Unparsable file → defaults **and** a `console.warn`
  naming the path; do not throw, do not delete the file.
- Write atomically: write `settings.json.tmp` then `renameSync`.
- Create `<dataDir>/ai/` on first write with `mkdirSync({ recursive: true })`.
- Never store `apiKey` here. Add a test that writes settings then reads the
  raw file and asserts the string `apiKey` does not occur.

## Step 3 — `secrets.ts`

```ts
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
export function createMemorySecretStore(): SecretStore;
export function createFileSecretStore(dataDir: string): SecretStore;
```

`FileSecretStore` keeps `<dataDir>/ai/secrets.json` as `{ version: 1, secrets: Record<string, string> }`.

Rules:
- Write atomically (tmp + rename), then `chmodSync(path, 0o600)`. On
  Windows `chmod` is a no-op; call it anyway inside try/catch.
- Create the directory with mode `0o700`.
- `get` on a missing file returns `null`. An unparsable file returns
  `null` and warns once.
- Values are stored as-is. No encryption. The doc comment at the top of the
  file must say, in plain words: this is a file readable by the user's own
  account, the same posture as `~/.aws/credentials` and `~/.npmrc`; it is
  not protection against another process running as the same user.

Secret names used by the layer: `provider:<providerId>:apiKey`.

Tests (`tests/ai-secrets.test.ts`, temp directory per test like
`examples/notes/tests/db.test.ts`): set/get/delete round trip; file mode is
`0o600` on non-Windows (read `statSync(path).mode & 0o777`); memory store
forgets after a new instance; a corrupt file yields `null` and does not throw.

## Step 4 — `registry.ts`

```ts
export interface ResolvedModel {
  readonly adapter: ProviderAdapter;
  readonly config: AdapterConfig;
  readonly modelId: string;
}

export interface Registry {
  readonly adapters: readonly ProviderAdapter[];
  adapter(id: string): ProviderAdapter | null;
  /** Current settings plus the key, for adapter calls. */
  currentConfig(): Promise<{ adapter: ProviderAdapter; config: AdapterConfig } | null>;
  /** Everything needed to run a chat, or a PublicError explaining what is missing. */
  resolve(): Promise<ResolvedModel>;
  /** The public view: settings without the key. */
  settings(): Promise<AiSettings>;
  update(patch: UpdatePatch): Promise<AiSettings>;
}
```

`resolve()` throws `publicError.unavailable('AI is not set up yet. Open Settings to choose a provider.')`
when provider or model is unset, when the provider id is not registered
(message: `The configured AI provider is not available in this build.`),
when the adapter needs a key and none is stored (`An API key is required for <label>.`),
or when `needs.baseUrl === 'required'` and none is set.

`update(patch)`:
- `provider` set to an unregistered id → `publicError.invalidInput('Unknown provider.')`.
- `provider` changed → `modelId` is cleared unless the patch also sets it; `baseUrl` is reset to the new adapter's `defaultBaseUrl` unless the patch sets it.
- `apiKey: string` → stored in the secret store under the **current** provider's name (after applying a provider change in the same patch). `apiKey: null` → deleted. Empty string is treated as `null`.
- `remember: false` → the key moves from the file store to the memory store: read it, delete from file, set in memory. `remember: true` does the reverse. Keep one active `SecretStore` reference and swap it; both stores are constructed once in `createAi`.
- `keyHint` is the last four characters of the key, or `null`. For keys shorter than eight characters, `keyHint` is `null` (too short to hint safely).
- `configured` is true when `resolve()` would succeed. Implement by calling `resolve()` in a try/catch rather than duplicating the rules.

Every write goes through `SettingsStore.write` atomically.

## Step 5 — `create-ai.ts`

```ts
export interface AiAppDescription {
  readonly name: string;
  readonly purpose: string;
  readonly terminology?: readonly string[];
}

export interface CreateAiOptions {
  readonly dataDir: string;
  readonly providers: readonly ProviderAdapter[];
  readonly app: AiAppDescription;
  /** Defaults to globalThis.fetch. Tests inject a fake. */
  readonly fetch?: typeof fetch;
  readonly logger?: HostLogger;          // reuse the type from host/app.ts
  // `context` and `tools` are added by prompt 04. Leave them out now.
}

export interface Ai {
  mount(bridge: Bridge): void;
  abortAll(reason: string): void;
  readonly activeStreams: number;
  /** For tests and for applications that want to read settings on the host. */
  readonly registry: Registry;
}

export function createAi(options: CreateAiOptions): Ai;
```

Implementation:
- Throw `TypeError` if `providers` is empty or two adapters share an `id`.
- Build the stores, the registry, and a `HostApp<AiContract>` via
  `createReservedHostApp(aiContract)` (from prompt 02).
- Implement these operations now; register `ai.chat` and `ai.chat.confirm`
  with handlers that throw `publicError.unavailable('Chat is not available yet.')`
  so `mount` does not refuse to start (mount requires every route
  implemented). Prompt 04 replaces them.
  - `ai.settings.get` → `registry.settings()`
  - `ai.settings.update` → `registry.update(input)`
  - `ai.providers.list` → for each adapter: `ProviderInfo` with `local`
    computed against the current config for that adapter (key omitted;
    `local` must not depend on the key).
  - `ai.models.list` → `currentConfig()`; null → the "not set up" error;
    else `adapter.models(config, signal)` with a 20 s `AbortSignal.timeout`,
    errors through `toPublicError`.
  - `ai.connection.test` → same resolution; time `adapter.test`; return
    `{ ok: true, message: 'Connected to <label>.', latencyMs }`. On
    `AdapterError` return `{ ok: false, message: error.message, latencyMs }`
    instead of throwing — the UI shows it inline. Non-adapter errors still
    throw.
- `mount(bridge)` mounts the host app. `abortAll` and `activeStreams`
  delegate to it.

## Step 6 — `fake.ts`

```ts
export interface FakeAdapterOptions {
  readonly id?: string;                     // default 'fake'
  readonly models?: readonly BroappModel[]; // default one model 'fake-1'
  readonly needsKey?: boolean;              // default false
  readonly failTestWith?: AdapterError;     // when set, test() rejects with it
  /** Scripted replies for chat. Used from prompt 04 on; accept and store it now. */
  readonly script?: unknown;
}
export function createFakeAdapter(options?: FakeAdapterOptions): ProviderAdapter;
```

`model()` must return a working AI SDK mock model from `ai/test` (the class
named in `reports/01-spike.md`). For now it may return a model that streams
the single text `"fake reply"`. Prompt 04 will extend it.

## Step 7 — `index.ts` and package wiring

Export: `createAi`, `createFakeAdapter`, `createFileSecretStore`,
`createMemorySecretStore`, `AdapterError`, `isLoopbackUrl`, and the types
`Ai`, `CreateAiOptions`, `AiAppDescription`, `ProviderAdapter`,
`AdapterConfig`, `AdapterErrorCode`, `SecretStore`, `Registry`.

Add `"./ai/host": "./src/ai/host/index.ts"` to `packages/broapp/package.json` exports.

Add to `tests/build.test.ts` boundary tests: a browser bundle importing
`broapp/ai/host` **fails** — same shape as the existing `broapp/host` case.

Add `tests/ai-engine-boundary.test.ts`: read every file under
`packages/broapp/src/ai/shared` and `packages/broapp/src/ai/react` (the
latter may not exist yet; skip missing directories) and assert none
contains the strings `from 'ai'`, `from "ai"`, `from 'ai/`, or `@ai-sdk/`.

## Step 8 — real-bridge tests

`tests/ai-host.test.ts`, using `harness()` from `tests/harness.ts`. Mount an
application `HostApp` and an `Ai` in the same `register`. The client
connects with `mergeContracts(appContract, aiContract)`. Use a fresh temp
`dataDir` per test.

Cases:
1. Fresh start: `ai.settings.get` → `provider: null`, `configured: false`, `hasKey: false`.
2. `ai.providers.list` lists the fake adapter with `local: true`.
3. `ai.models.list` before setup → rejects with `BroappError` code `unavailable`.
4. `ai.settings.update({ provider: 'fake', modelId: 'fake-1' })` → `configured: true`; then `ai.models.list` returns the fake model.
5. With `needsKey: true`: update provider+model without a key → `configured: false`; `ai.connection.test` → rejects `unavailable`; update `{ apiKey: 'sk-test-1234abcd' }` → `hasKey: true`, `keyHint: 'abcd'`, `configured: true`; the returned settings object, serialised, does not contain `sk-test`.
6. Key persistence: after step 5, stop the harness, start a new one on the same `dataDir`, `ai.settings.get` → `hasKey: true`.
7. `remember: false` then restart → `hasKey: false`, and `secrets.json` does not contain the key.
8. `ai.connection.test` with `failTestWith: new AdapterError('auth', 'The API key was rejected.')` → resolves `{ ok: false, message: 'The API key was rejected.' }`.
9. An application contract declaring `ai.foo` makes `createHostApp` throw — already covered in prompt 02; here assert that `harness()` with such a `register` rejects, to prove it surfaces at startup.

## Verify

```bash
bun install
bun run check
```

## Report

`prompts/ai-layer/reports/03-host.md`. Include the exact `ai/test` API you
used for the fake model.

Commit:

```
Add the AI host runtime: settings, secret stores, adapters and the non-chat routes
```
