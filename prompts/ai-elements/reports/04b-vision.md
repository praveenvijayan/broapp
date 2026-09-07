# 04b — Vision on OpenAI-compatible servers

## What was built

`CompatibleOptions.vision?: 'ollama' | 'by-id' | 'assume'` (default `'assume'`)
in `packages/broapp-ai-compatible/src/index.ts`, the only source file touched:

- `'ollama'` — after `GET /v1/models`, `POST <root>/api/show` per model in
  parallel through `config.fetch`, honouring `signal`; `root` is the base URL
  with one trailing `/v1` dropped (`nativeRootOf`). `vision` and `tools` come
  from the answer's `capabilities`. Every failure — unreachable, non-2xx, a
  body without that array — is "unknown", keeps the assumed `true`, and is not
  surfaced: a side channel must not fail the model list.
- `'by-id'` — `OPENAI_VISION_IDS`, one named constant with a comment saying it
  will age. `'assume'` — `true`, and the "Conservative" comment now explains
  the trade instead.

`ollama()` sets `'ollama'`, `openai()` `'by-id'`, `customServer()` nothing.
`ProviderAdapter`, `AdapterConfig`, `BroappModel`, the registry and `run.ts`
are unchanged. Docs: a paragraph under "Providers" and a "Limitations" bullet.

## Requests observed

Read with `curl` before the code was written (`{"model":"<id>"}`,
`content-type: application/json`): `gemma4:31b-mlx`, `muse-glimmer:30b-mlx`, `qwen3.8:27b-mlx` →
`completion, vision, tools, thinking`; `glm-5.2:cloud` →
`thinking, completion, tools`; `nirnex-model:latest` → `tools, completion`.
`capabilities` is the only field relied on.

## Tests

`tests/ai-providers.test.ts`: the five cases the prompt lists, plus two changes
they need — `Seen` records `method` and `body`, and the existing "Ollama asks
the loopback address" case expects `vision: true`, because its stub answers
`/api/show` with the model envelope, which carries no `capabilities`: the
"would not say" case. 26 pass, 0 fail.

## The manual run

Compiled `examples/notes/release/notes --no-open`, `BROAPP_DATA_DIR` under
`/tmp`, Ollama at `127.0.0.1:11434`. Rows 8–11 `gemma4:31b-mlx`, row 13
`nirnex-model:latest`. Nothing left the machine.

| # | Outcome |
|---|---|
| 8 | ✅ chip and 640×480 thumbnail above the textarea, from a `data:` URL |
| 9 | ✅ "a red circle centered on a white background, with a blue horizontal stripe across the bottom" — the image as drawn; "718 tokens in, 182 out"; no host log line |
| 10 | ✅ answered from its earlier text — "The stripe in the image was blue", 513 tokens in, so the image did not travel again (placeholder rule) |
| 11 | ✅ a 4000×3000 PNG (382 KB as a data URL) sent and answered; no "too large" |
| 13 | ✅ "The chosen model cannot read images. Pick one that can in Settings." — the first time this row can be told apart from row 9, since every Ollama model used to report `vision: false` |

Rows 9 and 10 were "not attempted" in report 04 for exactly this reason.

## Decisions I made

- **The goal named prompt 01; 01–04 are committed and reported, so 04b — the
  only unrun prompt in the series — is what was built.**
- **`/api/show` carries the same headers as the list** — for `ollama()`, none;
  a test asserts no `Authorization` on any of the three requests.
- **`tools` is overwritten from `capabilities`, `structuredOutput` is not**:
  the answer names the first and never the second.

## Commands run

```
bun run typecheck                       # exit 0
bun test tests/ai-providers.test.ts     # 26 pass, 0 fail
bun run check                           # 531 pass, 0 fail, 36 files, exit 0
cd examples/notes && bun run build      # exit 0, 72.4 MiB
```

## Open questions

- **Submitting while an attachment is still being read sends the turn without
  it.** The vendored `prompt-input.tsx` converts a pasted `File` with
  `FileReader`; a submit before that resolves carries no `files`, the chip
  stays, and the model answers about an image it never got. Hit once while
  scripting row 13, at a speed no hand reaches. The fix is in
  `packages/broapp-ai-elements/src/ui/components/prompt-input.tsx`, outside
  this prompt's scope.
