# 02 — Shared foundations: JSON Schema export, contract merging, the AI contract

Only proceed if `reports/01-spike.md` ends with `SPIKE PASSED`.

## Goal

Four small, fully tested changes that everything later builds on:

1. Every `s.*` schema can describe itself as JSON Schema (`toJsonSchema`).
2. Two contracts can be merged with a clash check (`mergeContracts`).
3. `HostApp` gains `invoke(name, input)` so AI tools can call an
   application's own operations through the same validation and error
   boundary the bridge uses.
4. The AI contract, event types and model types exist under `broapp/ai`.

No AI SDK code in this prompt. No new dependencies.

## Read first

- `prompts/ai-layer/00-common-rules.md`
- `packages/broapp/src/shared/schema.ts` — the whole file.
- `packages/broapp/src/shared/contract.ts` — the whole file.
- `packages/broapp/src/host/app.ts` — the whole file.
- `packages/broapp/src/shared/index.ts` and `packages/broapp/src/host/index.ts` — what is exported.
- `tests/schema.test.ts` and `tests/bridge.test.ts` — test style.
- `packages/broapp/package.json` — the `exports` map.
- `docs/host-operations.md` — the "Validation" section, so your JSON Schema matches what the docs promise.

## Step 1 — `toJsonSchema` on the `s` validator

Modify `packages/broapp/src/shared/schema.ts`.

Add to the `Schema<T>` interface:

```ts
/** A JSON Schema (draft 2020-12 subset) describing what `parse` accepts. */
toJsonSchema(): JsonSchema;
```

and export:

```ts
export type JsonSchema = Record<string, unknown>;
```

Change the private `schema()` factory to take a third argument, a function
returning the JSON Schema, and store it as `toJsonSchema`. Then give every
constructor its mapping. This table is exact; do not invent extra keywords:

| Constructor | JSON Schema |
|---|---|
| `string({min,max,pattern})` | `{ type: 'string', minLength?, maxLength?, pattern? }` — `pattern` is `pattern.source` |
| `number({min,max,int})` | `{ type: int ? 'integer' : 'number', minimum?, maximum? }` |
| `boolean()` | `{ type: 'boolean' }` |
| `literal(x)` | `{ const: x }` |
| `enum([...])` | `{ type: 'string', enum: [...] }` |
| `array(item,{min,max})` | `{ type: 'array', items: item.toJsonSchema(), minItems?, maxItems? }` |
| `object(fields)` | `{ type: 'object', properties: {...}, required: [keys whose schema kind !== 'optional'], additionalProperties: false }` |
| `optional(inner)` | `inner.toJsonSchema()` — the optionality is expressed by `object` leaving the key out of `required` |
| `nullable(inner)` | `{ anyOf: [inner.toJsonSchema(), { type: 'null' }] }` |
| `void()` | `{ type: 'object', properties: {}, additionalProperties: false }` |
| `unknown()` | `{}` |

Omit a keyword entirely when its option is undefined. Never emit
`minLength: undefined`. `required` must always be present on objects, as an
array, even when empty.

Tests, in `tests/schema.test.ts` under a new `describe('toJsonSchema')`:

- one test per row of the table, asserting deep equality with the literal
  expected object;
- one test with a nested object containing optional, nullable and array
  fields, asserting the full output;
- one test that `JSON.stringify(schema.toJsonSchema())` contains no
  `undefined` for a string with no options (i.e. it is exactly
  `{"type":"string"}`).

## Step 2 — `mergeContracts`

Add to `packages/broapp/src/shared/contract.ts`:

```ts
/**
 * Combine two contracts into one. Used in the browser so one client can
 * speak an application's contract and Broapp's AI contract over one
 * connection. Throws if any route name appears in both.
 */
export function mergeContracts<A extends AnyContract, B extends AnyContract>(
  a: A,
  b: B,
): Contract<{
  operations: ShapeOf<A>['operations'] & ShapeOf<B>['operations'];
  streams: ShapeOf<A>['streams'] & ShapeOf<B>['streams'];
}>;
```

Implement by spreading the two operation tables and the two stream tables,
computing `routes` fresh, and throwing `TypeError('route "x" is declared by both contracts')`
on any duplicate across all four tables. Export it from `shared/index.ts`.

Also add and export:

```ts
/** The route group Broapp reserves for its AI layer. */
export const RESERVED_GROUPS: readonly string[] = ['ai'];

/** Throws if a contract declares a route in a reserved group. */
export function assertNoReservedRoutes(contract: AnyContract): void;
```

Call `assertNoReservedRoutes` inside `createHostApp` (in `host/app.ts`) so an
application whose contract declares `ai.anything` fails at startup with a
message that says the group is reserved for Broapp's AI layer. Do **not**
call it inside `defineContract` — the AI contract itself is defined with
`defineContract` and must be allowed to use the group.

Tests in a new `tests/contract.test.ts`:

- merging two disjoint contracts yields every route from both;
- a route in both operations throws;
- a route that is an operation in one and a stream in the other throws;
- `createHostApp` with a contract declaring `ai.chat` throws with a message
  containing `reserved`;
- `createHostApp` with the real `aiContract` (from step 4) does **not**
  throw — this proves the reservation applies to applications, not to
  Broapp itself. Do it by exporting a second factory, `createHostApp` for
  applications and an internal `createReservedHostApp` (same
  implementation, skips the check) that only `broapp/ai/host` uses. Export
  the internal one from `host/index.ts` with a doc comment saying it is
  not for applications.

## Step 3 — `HostApp.invoke`

Add to the `HostApp<C>` interface in `host/app.ts`:

```ts
/**
 * Run one operation directly, without the bridge. Input is validated and
 * output is checked exactly as for a call from the browser, and the same
 * error boundary applies. This is how the AI layer lets a model call an
 * application's operations as tools.
 */
invoke<K extends OperationName<C>>(name: K, input: unknown): Promise<OperationOutput<C, K>>;
```

Implement it by extracting the per-operation wrapper that `mount` currently
builds inline (validate input → run handler → validate output → `wrap`
errors) into a private function used by both `mount` and `invoke`. `invoke`
on a route with no handler throws `TypeError`. `invoke` on a route that is
a stream throws `TypeError` (streams are not invokable).

Tests in `tests/bridge.test.ts` (extend the existing app in that file):

- `invoke('demo.echo', { text: 'a' })` returns `{ text: 'A' }`;
- `invoke('demo.echo', { text: '' })` rejects with a `BridgeError` whose
  message contains `invalid_input` (look at how `PublicError.toBridgeError`
  formats it and assert on that);
- `invoke('demo.boom', undefined)` rejects, and the rejection message does
  **not** contain `secret-token`;
- `invoke('demo.ticks', {})` throws `TypeError`.

## Step 4 — the AI contract

Create `packages/broapp/src/ai/shared/` with three files.

### `types.ts`

```ts
/** A model a provider offers, as the browser sees it. */
export interface BroappModel {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
  readonly capabilities: {
    readonly tools: boolean;
    readonly vision: boolean;
    readonly structuredOutput: boolean;
  };
}

/** A provider compiled into this application, as the browser sees it. */
export interface ProviderInfo {
  readonly id: string;
  readonly label: string;
  /** True when requests stay on this machine with the current settings. */
  readonly local: boolean;
  readonly needs: { readonly apiKey: boolean; readonly baseUrl: 'required' | 'optional' | 'none' };
  readonly defaultBaseUrl: string | null;
}

/** What the settings route returns. Never contains the key itself. */
export interface AiSettings {
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly baseUrl: string | null;
  readonly hasKey: boolean;
  /** Last four characters of the key, for the UI to show which key is set. */
  readonly keyHint: string | null;
  /** False means the key is held in memory only and forgotten on exit. */
  readonly remember: boolean;
  /** True when provider and model are both set and the provider's needs are met. */
  readonly configured: boolean;
}

export type ToolPermission = 'read' | 'confirm';

/** One turn of prior conversation the browser sends back with each message. */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * One event on the `ai.chat` stream. Flat on purpose: the `s` validator has
 * no unions, so the discriminant is `type` and the other fields are
 * optional. Which fields are present for which type:
 *
 *   text        text
 *   tool-call   callId, tool, input, permission
 *   confirm     callId, tool, input          (waits for ai.chat.confirm)
 *   tool-result callId, tool, output, denied?
 *   usage       inputTokens, outputTokens
 *   done        —
 *   error       code, message
 */
export interface ChatEvent {
  readonly type: 'text' | 'tool-call' | 'confirm' | 'tool-result' | 'usage' | 'done' | 'error';
  readonly text?: string;
  readonly callId?: string;
  readonly tool?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly denied?: boolean;
  readonly permission?: ToolPermission;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly code?: string;
  readonly message?: string;
}
```

### `contract.ts`

Define `aiContract` with `defineContract` and the `s` validator so that its
inferred types match `types.ts` exactly. Use these route names and bounds.
Do not add or rename routes.

| Route | Kind | Input / params | Output / event |
|---|---|---|---|
| `ai.settings.get` | operation | `s.void()` | `AiSettings` |
| `ai.settings.update` | operation | object, every field `s.optional`: `provider: string(max 64)`, `modelId: string(max 200)`, `baseUrl: nullable(string(max 2000))`, `apiKey: nullable(string(max 4000))`, `remember: boolean` | `AiSettings` |
| `ai.providers.list` | operation | `s.void()` | `{ providers: array(ProviderInfo, max 50) }` |
| `ai.models.list` | operation | `s.void()` | `{ models: array(BroappModel, max 1000) }` |
| `ai.connection.test` | operation | `s.void()` | `{ ok: boolean, message: string, latencyMs: number }` |
| `ai.chat` | stream | `{ runId: string(pattern /[A-Za-z0-9_-]{8,64}/), message: string(min 1, max 20000), refs: array(string(max 200), max 50), history: array(ChatTurn with content max 20000, max 100) }` | `ChatEvent` — an object whose `type` is `s.enum([...])` and every other field `s.optional(...)`; `input` and `output` are `s.optional(s.unknown())` |
| `ai.chat.confirm` | operation | `{ runId: same pattern, callId: string(max 200), approve: boolean }` | `{ accepted: boolean }` — false when no run is waiting on that call |

Give every route a `summary`. Export `aiContract` and
`export type AiContract = typeof aiContract`.

Add a type-level assertion file `packages/broapp/src/ai/shared/types.check.ts`
that does nothing at runtime but fails `tsc` if the contract drifts from
the interfaces, in this style:

```ts
import type { OperationOutput } from '../../shared/contract.ts';
import type { AiContract } from './contract.ts';
import type { AiSettings } from './types.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const settingsMatch: Equal<OperationOutput<AiContract, 'ai.settings.get'>, AiSettings> = true;
void settingsMatch;
```

Do this for `AiSettings`, `BroappModel` (element of the models list),
`ProviderInfo`, and `ChatEvent`. If `Equal` is false because of
`readonly` differences, make the interfaces match what `Infer` produces
rather than weakening the check.

### `index.ts`

Export everything public from `types.ts` and `contract.ts`. Nothing else.

### Package wiring

In `packages/broapp/package.json` add to `exports`:

```
"./ai": "./src/ai/shared/index.ts"
```

(`./ai/host` and `./ai/react` come in later prompts.) Add
`packages/broapp/src/ai/**` to whatever `files`/`tsconfig` globs need it —
check `tsconfig.json` `include` already covers `packages/*/src/**`.

Test in `tests/build.test.ts`, in the existing `describe('the host/browser boundary')`:
a browser bundle that imports `broapp/ai` **succeeds** (it is shared code)
— mirror the existing passing case. Also add a test in a new
`tests/ai-contract.test.ts` that every route of `aiContract` starts with
`ai.`, that `ai.chat` params reject a `runId` of `abc` (too short) and a
`message` of `''`, and that a `ChatEvent` of `{ type: 'text', text: 'x' }`
parses while `{ type: 'nope' }` does not.

## Verify

```bash
bun run typecheck
bun test tests
```

## Report

`prompts/ai-layer/reports/02-shared.md`. Include the final JSON Schema for
the `ai.chat` params (print it with `JSON.stringify(aiContract.streams['ai.chat'].params.toJsonSchema(), null, 2)`)
so the next prompt can see the shape.

Commit:

```
Add JSON Schema export, contract merging, HostApp.invoke and the AI contract
```
