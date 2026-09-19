# 18a — A model names its provider: settings for every provider, and one string that reaches any of them

## Goal

The launcher compiles four providers — `anthropic()`, `ollama()`, `openai()`,
`customServer()` (`launcher/main.ts`, lines ~426 and ~1033) — and can use one.
`StoredSettings` holds one `provider`, one `baseUrl` and one `modelId`, and
`registry.update` clears the address and the model on every change of provider.
So a person who runs OpenRouter through `customServer` and also has Ollama on
the same machine has to choose: the frontier model for everything, or the local
one for everything. Going from one to the other and back means typing the
address and choosing the model again. The key survives, because
`apiKeySecretName` is already per provider; nothing else does.

The places a model is chosen are already strings: `Thread.modelId`, a task's
`modelOverride`, the three tiers in `intent-models.json`. `registry.resolve`
takes such a string and refuses to look past the configured provider — its
comment says *"a conversation may pin a model, never a vendor"*, and
`intent/models.ts` says a model from another provider per task *"is a backlog
row, not a field"*. This prompt is that row.

The AI SDK has `createProviderRegistry`, which routes `'<provider>:<model>'`
to a provider. It is not used here: its providers are built once with a fixed
key and address, and Broapp's adapters take both per call from the secret store
and settings, with an injected `fetch`, and carry `local()`, `models()`, `test()`
and the safe error words. What is taken from it is the convention: one string,
split on the first `:`.

After this prompt every provider keeps its own address and model; a provider is
either turned on or not; and a model id written `ollama:qwen3:27b` or
`openrouter:anthropic/claude-opus-5` runs on that provider, with that
provider's key and address, from any place that holds a model id today. No
screen changes here — 18b does the list, the pickers and the settings panel.

## Read first

- `prompts/autoapp/00-common-rules.md`, the *Core changes allowed* row: this
  prompt changes `packages/broapp` and names every file it may touch below.
  Reports 13c (tiers and `modelOverride`), 15d and 17a (usage rows, prices).
- `packages/broapp/src/ai/host/settings.ts`, `registry.ts`, `secrets.ts`,
  `adapter.ts` — whole files. In `registry.ts` read every comment: each one
  records a fault that was once shipped, and the new code must not bring one
  back (`configFor` and the address of a provider that is not selected; the
  order key → address → model in `resolve`).
- `packages/broapp/src/ai/host/create-ai.ts`: `requireConfig`, `ai.modelsList`,
  `ai.connectionTest`, `model(override)` (line ~394), and what `onRunEnd` is
  given as `model: { provider, id }`. `run.ts` line ~872, the one call to
  `resolve` for a chat turn.
- `packages/broapp/src/ai/shared/types.ts` (`AiSettings`, `Thread` and its
  comment on why the provider is never part of a conversation),
  `contract.ts` (`settings`, `ai.settingsUpdate`), and `types.check.ts` — the
  interfaces and the contract must stay identical.
- `packages/broapp-ai-compatible/src/index.ts`: `openaiCompatible`, the three
  presets, and the comment on `customServer` that already names OpenRouter.
- `packages/broapp-autoapp/src/intent/models.ts`, `executor.ts` (`offered`,
  line ~829; the check at line ~1146; the two `registry.settings()).modelId`
  reads at ~874 and ~1067 that name the model of a usage row), `usage.ts`
  (`costOf`) and `prices.ts`.
- `tests/ai-host.test.ts`, `tests/ai-providers.test.ts`,
  `tests/ai-secrets.test.ts`, `tests/ai-contract.test.ts`: how a registry is
  built over `fake.ts` with an injected `fetch`, and the test that asserts the
  key never appears in `settings.json`.

## Fixed decisions

| Decision | Value |
|---|---|
| The settings file | `version: 2`: `{ version, active: string \| null, remember: boolean, providers: Record<string, { baseUrl: string \| null, modelId: string \| null, enabled: boolean }> }`. `remember` stays one switch for every key. Still never holds a key; the existing test that says so is extended to the new shape. |
| Reading version 1 | `coerce` accepts a version-1 object and returns version 2: `active` is the old `provider`, and that provider's entry holds the old `baseUrl` and `modelId` with `enabled: true`. Nothing is written until the next `write`; a file that is never changed stays as it was. An unknown `version`, or a `providers` that is not an object, is the unreadable case that exists today, with today's warning. An entry for an id this build has no adapter for is kept on write and ignored on read — another build may own it. |
| Enabled | The active provider is always enabled; making a provider active sets its `enabled`. Any other provider is enabled only when `ai.settingsUpdate` says so. A provider that is not enabled is never sent anything, whatever a stored string names. This is the guard that keeps a line in `intent-models.json` from sending a person's source to a provider they did not turn on. |
| Changing the active provider | Restores that provider's own `baseUrl` and `modelId`. A provider with no entry yet gets `{ baseUrl: adapter.defaultBaseUrl, modelId: null, enabled: true }`. Nothing is cleared. The comment in `update` about carrying a model across providers is rewritten: it is no longer carried, it is kept where it belongs. |
| The model reference | One string, `<providerId>:<modelId>`, split on the **first** `:`. It is qualified only when the part before the first `:` is the id of an adapter in this build; otherwise the whole string is a model of the active provider, as today — so `qwen3:27b` with Ollama active is unchanged. A new shared file, `packages/broapp/src/ai/shared/model-ref.ts`, exports `parseModelRef(ref, providerIds): { provider: string \| null; modelId: string }` and `formatModelRef(provider, modelId): string`, imports nothing, and is exported from `ai/shared/index.ts`. The browser uses the same two functions in 18b. A model of the active provider whose own id begins with another adapter's id and a colon is unreachable unqualified; say so in the file's comment, and that qualifying it reaches it. |
| Length | A reference is at most 200 characters, the contract's existing bound on `modelId`, qualified or not. No bound changes. |
| `resolve` | `resolve(override?: { modelId?: string })` keeps its signature. With a qualified override: the named adapter, its own entry's `baseUrl` (else its default), its own key. It must be enabled, else `publicError.unavailable('<label> is not turned on in Settings.')`. Then the same order as today — key, address — with today's sentences. With no override, or an unqualified one: exactly today's behaviour on the active provider. The active provider's "AI is not set up yet" still comes first when `active` is null, even for a qualified override: a launcher with nothing set up is not set up. `ResolvedModel.modelId` is the bare id the adapter is given. |
| `configFor` | Reads the adapter's own entry, so its comment's fault cannot recur by construction: an address is only ever applied to the provider it was typed for. Still no key. |
| `currentConfig` | Unchanged in meaning: the active provider. Add `configOf(providerId): Promise<{ adapter, config } \| null>` — that provider's entry and key, `null` when there is no such adapter or it is not enabled. `offered` and 18b use it. |
| `AiSettings` | Every existing field stays and means the active provider, so an application written against 0.4 reads what it read. One new field: `providers: Array<{ id: string; baseUrl: string \| null; modelId: string \| null; enabled: boolean; hasKey: boolean; keyHint: string \| null; configured: boolean }>`, one element per adapter in this build, in the build's order, an adapter with no entry shown with its default address and `enabled: false`. `configured` for an element is "would a qualified `resolve` for this provider succeed, given a model" — key and address, not the model. Contract, interface and `types.check.ts` together. |
| `ai.settingsUpdate` | Two new optional inputs: `target: string` (max 64) and `enabled: boolean`. With `target`, the fields `modelId`, `baseUrl`, `apiKey` and `enabled` apply to that provider and the active one does not change; an unknown `target` is `invalidInput`. Without `target` they apply to the active provider, as today. `provider` still means "make this one active" and may be sent with `target` only when the two are equal. `enabled: false` on the active provider is `invalidInput('The provider in use cannot be turned off. Choose another first.')`. `moveKeys` already walks every adapter; confirm and leave. |
| The `Thread` comment | Rewritten: a conversation's `modelId` is a model reference and may name an enabled provider; the reason the old rule existed — a change of provider changes which key is used and whether anything leaves the computer — is kept in the comment as the reason 18b must show local or remote wherever a model is chosen. No column changes; `threads.ts` stores the string it is given. |
| OpenRouter | A fourth preset in `broapp-ai-compatible`: `openrouter()`, id `'openrouter'`, label `'OpenRouter'`, `needs: { apiKey: 'required', baseUrl: 'optional' }`, `defaultBaseUrl: 'https://openrouter.ai/api/v1'`. Read the `vision` option and choose as `customServer` does unless reading shows better; say which. Added to both provider lists in `launcher/main.ts`, after `openai()`. Nobody's settings are rewritten: a person on `openai-compatible` with an OpenRouter address stays there until they choose otherwise. |
| Tiers and overrides | `intent/models.ts` stores references; its header comment loses the sentence about one provider and gains the convention. `modelFor` is unchanged. |
| `offered` | Takes the reference a task will run on. Qualified: `configOf` that provider and check the bare id against its list. Unqualified: today. The sentence `The model <id> is no longer offered by <label>` names the right provider. A provider that is not enabled gives the `resolve` sentence, before any network call. A provider whose list cannot be read is `null`, as today — not a refusal. |
| A local server that is down | The task fails through the existing provider-error path. No fallback to another provider, ever: a task sent to `ollama:` that ran on a hosted model because Ollama was closed would have left the machine unasked. One test says so. |
| Usage rows and prices | A usage row's `modelId` is what ran: `formatModelRef(provider, id)` when the turn ran on a provider other than the active one, the bare id otherwise — so rows written before this prompt and after it agree for the common case. The two reads of `registry.settings()).modelId` stay for the advice and planning questions, which run on the Settings model. `costOf` looks up the row's string, then its bare id. `prices.json`'s format is unchanged. |
| `createProviderRegistry` | Not imported. `tests/ai-engine-boundary.test.ts` stays as it is. |
| Not in scope | Any screen, hook or picker (18b). `ai.modelsList` and `ai.connectionTest` (18b). Two connections of one adapter — two custom servers at once: a row in `docs/autoapp/backlog.md`, with what it would take (`openaiCompatible` already accepts an id). Aliases such as `fast`. Choosing a provider by price or by whether one is reachable. |

## Files in `packages/broapp` this prompt may change

`src/ai/host/settings.ts`, `src/ai/host/registry.ts`, `src/ai/host/create-ai.ts`
(only what `configOf` and the new `settingsUpdate` inputs need),
`src/ai/shared/types.ts`, `src/ai/shared/contract.ts`,
`src/ai/shared/types.check.ts`, `src/ai/shared/index.ts`, the new
`src/ai/shared/model-ref.ts`, and `src/ai/host/index.ts` if `configOf`'s types
need exporting. `run.ts`, `threads.ts` and everything under `src/ai/react` are
not touched.

## Verification

```bash
bun run typecheck
bun test tests/ai-host.test.ts tests/ai-providers.test.ts tests/ai-secrets.test.ts tests/ai-contract.test.ts tests/ai-threads.test.ts tests/ai-chat.test.ts
bun test tests/autoapp-intent.test.ts tests/autoapp-intent-run.test.ts tests/autoapp-intent-tools.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside the ones they extend:

1. `parseModelRef`: `ollama:qwen3:27b` with `ollama` known → `ollama`,
   `qwen3:27b`; `qwen3:27b` with no `qwen3` adapter → `null`, whole string;
   `anthropic/claude-opus-5` → `null`; an empty part on either side of the
   colon → unqualified. `formatModelRef` then `parseModelRef` is the identity.
2. Settings: a version-1 file reads as version 2 with one enabled entry and is
   not rewritten by reading; a write produces version 2; an entry for an unknown
   adapter survives a write; the key string is in neither.
3. Switching: set provider A with an address and a model, make B active, make A
   active again — A's address and model are back, and B's are kept too.
4. `resolve`: a qualified override for an enabled second provider returns that
   adapter, its address, its key and the bare id; the same for a provider that
   is not enabled is refused with the sentence above and the injected `fetch`
   was never called; a required key missing on the second provider gives that
   provider's sentence; `active: null` gives "not set up" first.
5. `configFor` for a provider that is not active returns its own stored address,
   not the active one's and not `null` when it has one.
6. `ai.settingsUpdate` with `target`: the key goes under that provider's secret
   name, the active provider is unchanged, `enabled: false` on the active one is
   refused, `remember: false` afterwards moves both keys off the disk.
7. `AiSettings.providers` has one element per adapter, in order; the top-level
   fields equal the active element's.
8. `openrouter()`: id, default address, a missing key refused by `resolve`.
9. Executor, over the fake provider registered twice under two ids: a task whose
   tier names the second provider runs on it and its usage row's `modelId` is
   qualified; a task with no model runs on the active one and its row is bare;
   `offered` names the second provider in its sentence; the second provider
   failing fails the task and the first provider's `fetch` count is unchanged.
10. `costOf`: a price under the bare id prices a qualified row; a price under
    the qualified id wins over one under the bare id.

By hand, on a copy of the root under
`~/Library/Application Support/broapp-autoapp/autoapp`, with Ollama running:
start the launcher on the copy and record that Settings still shows the
provider, address, model and key hint it showed before, and that
`launcher/ai/settings.json` is still version 1. Turn Ollama on with one
`ai.settingsUpdate` call from the launcher's own console or a test script —
say which — and write `{ "light": "ollama:<a model you have>", "standard": null,
"deep": null }` to `intent-models.json`. Run one light task and one standard
task. Record each usage row's `modelId`, and from Ollama's own log that the
light task reached it. Then quit Ollama, run a light task, and record the words
the task failed with and that no request went to the hosted provider.

## Acceptance criteria

- A person who changes provider and changes back types nothing twice.
- A reference naming an enabled provider runs there with that provider's own
  key and address, from a thread pin, a task override or a tier, with no change
  to any of the three stores.
- A reference naming a provider that is not enabled sends nothing anywhere.
- An application written against the 0.4 contract reads the same `AiSettings`
  fields with the same meaning and sends the same `ai.settingsUpdate` inputs
  with the same effect.
- A failed provider never becomes a different provider.
- `settings.json` never holds a key, in either version.
- `bun run check` green; `tests/ai-engine-boundary.test.ts` untouched.

## Report

`prompts/autoapp/reports/18a-a-model-names-its-provider.md`: the version-2
file as written on your machine, with nothing secret in it; the `vision`
choice for `openrouter()` and why; every caller of `resolve`, `currentConfig`
and `registry.settings()` and what each does with a qualified reference now;
the by-hand run with the usage rows and the failure's words; for 18b, the exact
shape of `AiSettings.providers` and of the new `settingsUpdate` inputs as
built; and the backlog row.

## Commit

```
Keep every provider's settings, and let a model id name its provider

The launcher compiled four providers and could use one: settings held a
single address and model, and changing provider cleared both. Settings
are now kept per provider, with a version-1 file read as it stands, and
a provider is either turned on or never contacted. A model id written
"<provider>:<model>" resolves to that provider with its own key and
address, so a tier, a task or a conversation can run on Ollama while the
rest run on a hosted model. Nothing falls back from one provider to
another. OpenRouter gets a preset of its own.
```

End the commit with the co-author trailer your session's rules give you.
