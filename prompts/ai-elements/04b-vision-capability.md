# 04b — Vision on OpenAI-compatible servers

## Why

Report 04 rows 9, 10 and 15 never ran: `broapp-ai-compatible` reports
`capabilities.vision: false` for every model because `GET /v1/models` says
nothing about capabilities, and prompt 02's host check refuses an image
turn on such a model. Ollama's own API does say: `POST /api/show` with
`{ "model": "<id>" }` answers `capabilities: ["completion","vision","tools","thinking"]`
(verified on this machine for `gemma4:31b-mlx`). OpenAI's vision models are
knowable by id. Everything else is unknowable from the outside.

This prompt lifts the "do not touch" on
`packages/broapp-ai-compatible/src/index.ts` for this one purpose. Nothing
else in the common rules changes.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–04.
- `packages/broapp-ai-compatible/src/index.ts`, all of it — `models()`,
  `baseUrlOf`, the three presets, how `config.fetch` is the only fetch.
- `packages/broapp/src/ai/host/run.ts` lines ~225–250 — how the host reads
  vision: listed and `false` → refuse; unlisted → assume it can see.
- `tests/ai-providers.test.ts` — `stubFetch`, `json`, `configWith`, and the
  Ollama and custom-server cases.
- `packages/broapp/src/ai/shared/types.ts` — `BroappModel.capabilities` is
  `{ tools: boolean; vision: boolean; structuredOutput: boolean }`. Do not
  change its type.

## The rule

`CompatibleOptions` gains one optional field:

```ts
/**
 * How to learn whether a model can see. `'ollama'` asks the server's own
 * `/api/show`; `'by-id'` matches known model ids; `'assume'` reports true
 * and lets the provider answer if it cannot. Default `'assume'`.
 */
readonly vision?: 'ollama' | 'by-id' | 'assume';
```

- `ollama()` preset: `vision: 'ollama'`. In `models()`, after the `/v1/models`
  list, derive the native root from the base URL by dropping a trailing
  `/v1` (so `http://127.0.0.1:11434/v1` → `http://127.0.0.1:11434`), then
  `POST <root>/api/show` with body `{ "model": id }` for each listed model,
  through `config.fetch`, in parallel, honouring `signal`. `vision` is
  `true` when the JSON's `capabilities` array contains `"vision"`. Any
  failure for one model — network, non-2xx, malformed body — makes that
  model `vision: true` (unknown, not refused) and is not surfaced: the
  model list must not fail because a side channel did. Also set
  `tools: capabilities.includes('tools')` when the array is present, since
  the same answer carries it; leave `structuredOutput` as it is.
- `openai()` preset: `vision: 'by-id'`. True when the id matches
  `/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|chatgpt-4o)/`, else false.
  Keep the pattern in one named constant with a comment saying it will
  age.
- `customServer()` and any caller that does not set the field: `'assume'`
  → `vision: true`. This matches the host's own rule for an unlisted model
  and means a custom server is never refused on a guess. Update the
  comment that currently says "Conservative" to explain the trade: a
  false refusal blocks a working setup, a false allowance gets the
  provider's own error.

No new dependency. No change to `ProviderAdapter`, `AdapterConfig`, the
registry, or `run.ts`.

## Tests

`tests/ai-providers.test.ts`, with `stubFetch`:

1. Ollama: `/v1/models` lists two models; `/api/show` answers `vision` for
   one. The stub records **three** requests; the second and third are
   `POST http://127.0.0.1:11434/api/show` with the right bodies; the
   resulting models carry `vision: true` / `false` accordingly and no
   `Authorization` header was sent on any of them.
2. Ollama, `/api/show` returns 500 for one model: that model is
   `vision: true`, the other is as reported, `models()` resolves.
3. Ollama with a custom base URL `http://127.0.0.1:11434/v1/` (trailing
   slash) still posts to `…:11434/api/show`.
4. OpenAI: `gpt-4o-mini` true, `gpt-3.5-turbo` false, `o3` true, no extra
   requests beyond `/v1/models`.
5. Custom server: every model `vision: true`, one request.

`tests/ai-chat.test.ts` and `tests/ai-elements-transport.test.ts` are not
touched.

## Docs

`docs/ai.md` "Providers": one sentence per preset on how vision is
known. "Limitations": "a custom server is assumed to see; if it cannot,
the provider's own error is what you get."

## Manual run

Same provider rule as prompt 04. With Ollama and `gemma4:31b-mlx` (or
another model `/api/show` reports as vision), run rows 8–11 and 13 of
prompt 04's table against the compiled notes binary and record outcomes.
Row 13 needs a model `/api/show` reports **without** vision; if none is
installed, record "not attempted" rather than pulling one.

## Verify

```bash
bun run typecheck
bun test tests/ai-providers.test.ts
bun run check
cd examples/notes && bun run build && cd ../..
```

## Report

`prompts/ai-elements/reports/04b-vision.md`: the requests observed, the
five rows' outcomes with model names, and any `/api/show` field you relied
on beyond `capabilities`.

Commit:

```
Learn whether an OpenAI-compatible model can see, from Ollama's own API or a known id
```
