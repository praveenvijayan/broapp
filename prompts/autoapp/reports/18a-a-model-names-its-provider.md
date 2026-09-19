# 18a — A model names its provider

## What was built

- `broapp/src/ai/shared/model-ref.ts`: `parseModelRef(ref, providerIds)` and
  `formatModelRef(provider, modelId)`, importing nothing, exported from `broapp/ai`. The comment
  says that a bare id beginning with another adapter's id and a colon is unreachable, and that
  qualifying it reaches it.
- `settings.ts`, version 2: `{ version, active, remember, providers: { [id]: { baseUrl, modelId,
  enabled } } }`. A file with version 1 (or no version) is read as version 2 and not rewritten
  until the next `write`. An unknown version, or a `providers` that is not an object, is the
  existing unreadable case with the existing warning.
- `registry.ts`: every provider has its own entry. `resolve` follows a qualified reference.
  New: `configOf`, a sync `activeProvider()`, `AiSettings.providers`, and `update` with
  `target`/`enabled`. `configFor` reads the provider's own entry.
- Contract, `types.ts` (`ProviderSettings`, the new `Thread` comment) and `types.check.ts`
  changed together. The comment on `ai.chat`'s `modelId` was also rewritten; it said "only
  within the configured provider".
- `broapp-ai-compatible`: `openrouter()`. It is in both provider lists in `launcher/main.ts`,
  after `openai()`.
- Autoapp: `intent/models.ts` header; the executor's `notOffered(ref)` replaces `offered()`;
  the tab qualifies usage rows; `costOf`/`spendOf` take `providerIds`, passed through the
  launcher app to the overview. Docs: a sentence in `intents.md`; two `backlog.md` rows (the
  second-provider row is marked landed, and the new row is below).

## The version-2 file as written here (by-hand copy, after one call)

```json
{ "version": 2, "active": "ollama", "remember": true,
  "providers": { "ollama": { "baseUrl": "http://127.0.0.1:11434/v1", "modelId": "gemma4:31b-mlx", "enabled": true },
                 "openai-compatible": { "baseUrl": "http://127.0.0.1:11434/v1", "modelId": null, "enabled": true } } }
```

## `vision` for `openrouter()`

`'assume'`, as `customServer` does. OpenRouter's `/models` entries do describe input
modalities. Reading them would need a fourth vision mode in `openaiCompatible`, written against
a response nobody here has seen (no network in tests). Assuming it lets the provider refuse an
image in its own words. The comment says so.

## Every caller, and what a qualified reference does there

- `run.ts:872` `resolve({ modelId: params.modelId })`: a chat turn, thread pin or task runs on
  the named provider. `tally.modelId` is the bare id; `onContext` gets `{ provider, id }`.
- `create-ai.ts` `ai.connectionTest` → `resolve()`, and `requireConfig` (`ai.modelsList`) →
  `currentConfig()`: no override, so the provider in use, unchanged (18b).
- `create-ai.ts` `Ai.model(override)` → `resolve(override)`: qualified works. The distiller,
  evaluation and replay call it without an override.
- `ai.settingsGet` → `settings()`. `ai.providersList` → `configFor`, now each provider's own
  address, so `local` is right for one not in use.
- `executor.ts` `notOffered` → `configOf(provider)` or `currentConfig()`. `start` →
  `currentConfig()` (a launcher with nothing in use is not set up). The two
  `registry.settings()).modelId` reads (advice row, `settingsModelName`) stay on the Settings
  model, as fixed.
- `tab.ts` distiller `onUsage` → `settings().modelId` (Settings model). `onContext` →
  `activeProvider()`, to decide whether the row is qualified.

## By hand

Run on a copy of the real root: reading-list only, databases copied with `.backup`, no key. The
real root's Settings are **Ollama**, `gemma4:31b-mlx`, and its one stored key belongs to
`openai-compatible`. So the roles in the prompt were swapped (deviation 1).

1. Compiled launcher, `open --no-open --no-restore` on the copy. Settings showed Ollama
   (local), `http://127.0.0.1:11434/v1`, `gemma4:31b-mlx`, "Runs on this computer". No key
   hint: Ollama needs none. `settings.json` was still version 1 afterwards.
2. From a **test script** (`tests/.autoapp-run/byhand-18a.ts`, gitignored), one
   `registry.update({ target: 'openai-compatible', enabled: true, baseUrl:
   'http://127.0.0.1:11434/v1' })`, which is the call `ai.settingsUpdate` makes. Then
   `intent-models.json` became `{ light: "openai-compatible:qwen3.8:27b-mlx", standard: null,
   deep: null }`.
3. Tasks run with `maxAttempts: 1` and a 12-minute turn. Neither completed; both were builder
   failures, not 18a ones.

| task | tier → model | usage row `modelId` | tokens in/out | outcome |
|---|---|---|---|---|
| 0005 light | `openai-compatible:qwen3.8:27b-mlx` | `openai-compatible:qwen3.8:27b-mlx` (partial) | 182,308 / 17,585 | ran out of time |
| its advice | Settings | `gemma4:31b-mlx` | 0 / 0 (partial, 60 s) | no answer |
| 0006 standard | Settings (Ollama) | `gemma4:31b-mlx` (partial) | 37,312 / 9,717 | no change, idle |

Ollama's own log, when the light task's first request arrived (12:01:07Z):
`starting mlx runner subprocess model=qwen3.8:27b-mlx`. All 20 requests went to
`127.0.0.1:11434`.

4. Failure, with deviation 2. `openai-compatible`'s address was set to `http://127.0.0.1:9/v1`
   (a local server that is not running), and a light task was run. The failure's words: **"The
   AI provider returned an error while building 0007-empty-list-words. Nothing was judged. The
   launcher's log has the detail."** The task was `interrupted`. The four requests all went to
   `127.0.0.1:9`: none to the running Ollama in use, none to any hosted host. Its row is
   `openai-compatible:qwen3.8:27b-mlx` with 0/0, partial.

## For 18b, as built

```ts
AiSettings.providers: Array<{ id: string; baseUrl: string | null; modelId: string | null;
  enabled: boolean; hasKey: boolean; keyHint: string | null; configured: boolean }>  // max 50, build order
ai.settingsUpdate input += { target?: string (max 64); enabled?: boolean }
```

`configured` on an element covers only its needs: key and address. It includes neither the
model nor `enabled`. An adapter with no entry shows its default address and `enabled: false`.
Errors, all `invalid_input`:
- an unknown `target`
- `provider` and `target` naming different providers
- `enabled: false` on the provider in use: "The provider in use cannot be turned off. Choose
  another first."

A field sent with no `target` and no provider in use is ignored, as it effectively was before.

## Backlog row

**Two connections of one adapter** (two custom servers at once). It needs a stored list of
connections `{ id, label, baseUrl }`, turned into `openaiCompatible` adapters at start (it
already takes an `id`), a key per connection id, and a rule for an id that clashes with a
built-in one.

## Deviations, and decisions I made

1. **By-hand roles swapped, and no hosted provider.** Settings here were already on Ollama. My
   copy of `secrets.json` into the run directory was refused by this session's permission
   classifier, so the copy had no key. The second provider was therefore `openai-compatible`
   pointed at Ollama, and nothing left the machine.
2. **Ollama was not quit.** The AppleScript quit returned "User canceled (-128)". I did not
   force it. A closed port stood in for the down server, which also shows no fallback to a
   provider that *was* up.
3. **`Registry.activeProvider()`**, not in the prompt. Usage rows are read right after a turn,
   so qualifying a row needs a sync read. `settings()` is async.
4. **`costOf(part, prices, providerIds = [])`.** A bare fallback needs the provider ids, or
   `qwen3:27b` would look up `27b`. The overview gets them through `LauncherAppOptions.providerIds`.
5. **`broapp-autoapp` now depends on `broapp-ai-compatible ^0.4.1`, not `^0.3.0`.** The old
   range resolved npm's 0.3.0, which has no `openrouter`. **For the release:** publish
   `broapp` (new exports), then `broapp-ai-compatible` at 0.4.2, then move this range to
   `^0.4.2`.
6. Existing tests changed shape, not strength: `ai-host`'s fresh-install `toEqual` gained
   `providers`, and `ai-secrets`' settings-store tests moved to version 2.
7. The commit trailer names Claude Opus 5, per this session's rule. The report runs past 100 lines because of the by-hand run and the caller list the prompt asks for, as 13b–14c did.

## Commands

```
bun run typecheck                                            exit 0
bun test tests/ai-{host,providers,secrets,contract,threads,chat}.test.ts   108 pass, 0 fail
bun test tests/autoapp-intent{,-run,-tools}.test.ts          112 pass, 0 fail
bun test tests                                               1090 pass, 0 fail (55 files)
bun run --cwd packages/broapp-autoapp build:launcher         dist/broapp-autoapp 78.1 MB
bun run scripts/autoapp-smoke.ts                             every step passed
bun install && bun run check                                 exit 0, 1090 pass
git diff --stat tests/ai-engine-boundary.test.ts tests/ai-chat.test.ts run.ts threads.ts src/ai/react   (nothing)
```

Mutation: with the tab's qualification removed, test 9's usage-row test fails.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Changing provider and back types nothing twice | pass (test 3) |
| A reference to an enabled provider runs there with its own key and address, from pin, override or tier | pass (tests 4, 9; by hand, tier) |
| A reference to a provider that is off sends nothing | pass (test 4 with a counting `fetch`; test 9) |
| A 0.4 application reads the same fields and sends the same inputs | pass (top-level = active; old tests unchanged in meaning) |
| A failed provider never becomes another | pass (test 9; by hand, all requests to `127.0.0.1:9`) |
| `settings.json` never holds a key, either version | pass (test 2) |
| `check` green; `ai-engine-boundary` untouched | pass |
