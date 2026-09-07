# 02 — Images on a chat turn

## What was built

- **Contract**: `chatFile` (`name` ≤200, `mediaType` one of the four bitmap
  types, `data` 1–2,000,000 base64 characters) and
  `files: s.optional(s.array(chatFile, { max: 4 }))` on `ai.chat`. `ChatFile`
  is in `types.ts`, re-exported from `broapp/ai` and `broapp/ai/react`, pinned
  by a new `types.check.ts` assertion. `history` is unchanged.
- **Host** (`run.ts`): `toModelMessages` builds the last user message as
  `[TextPart, ...FilePart]` when `files` is non-empty; history turns stay
  strings. Before the model is called, a turn with images is refused when the
  total passes 6,000,000 characters or the model cannot see. `create-ai.ts`
  needed nothing — `files` arrives inside `StreamChatParams`.
  `createFakeAdapter({ vision })` defaults to `false`, as the model already did.
- **Browser** (`packages/broapp-ai-elements/src/images.ts`): `splitDataUrl`,
  `prepareImage`, `IMAGE_LIMITS`, exported from the package root.
  `transport.ts` prepares the last user message's `file` parts and sends them
  as `files`; over four is `'Up to four images per message.'`, and a part that
  cannot be read stops the turn with its own sentence.
- **Docs** (`docs/ai.md`): a sentence in "What leaves the machine"; "No images"
  replaced with the real limits.
- **Tests**: four contract cases, seven in `tests/ai-elements-images.test.ts`,
  and four transport cases — the file part reaches the model, a model without
  vision refuses, history keeps the placeholder, two 1.9 MB images go through.

## Answers the prompt asked for

- **Where the capabilities are read from**: `resolved.adapter.models(config,
  signal)` — the list `ai.modelsList` serves — asked once per turn, only when
  the turn carries an image. `ResolvedModel` holds an id, not a record, and the
  registry caches no list, so a per-turn read is the least invasive place that
  knows. A model the list does not mention is assumed to see; so is one whose
  list could not be fetched, because a listing failure says nothing about the
  model.
- **Request-side size bound**: none below Brobridge's frame size. `OPEN` params
  travel in one frame, and `maxFrameSize` defaults to **16 MiB** (its protocol
  ceiling), `maxSocketBufferBytes` to 8 MiB. Measured, not assumed: a test
  sends two 1,900,000-character images through the real bridge and asserts the
  model received both. No bound was lowered.
- **The `FilePart` shape used**:
  `{ type: 'file', mediaType, data, filename }` — a base64 string is a
  `DataContent`, which `FilePart.data` accepts (`@ai-sdk/provider-utils@5.0.36`:
  `type DataContent = string | Uint8Array | ArrayBuffer | Buffer`).

## Decisions I made

- **The refusals are thrown `PublicError`s, not emitted `error` events.**
  Throwing is how `registry.resolve()`'s refusals already travel, `runStream`
  turns it into the wire error, and the browser sees the same `error` chunk
  either way. Emitting an event as well would produce two.
- **`prepareImage` passes an image through when there is no decoder.**
  `createImageBitmap` is absent under `bun test` and in old browsers; rather
  than refuse for want of a canvas, an image already inside the contract's
  bound is sent as it arrived. Over the bound with no decoder is refused.
- **`splitDataUrl` trusts the data URL over the part.** The URL carries the
  bytes, so its media type is the one the host is told about; a `file` part
  claiming `image/png` cannot smuggle an SVG past the contract.
- **A re-encoded image is renamed to `.jpg`**, because the bytes are no longer
  what arrived.

## Commands run

```
bun run typecheck                                    # exit 0
bun test tests/ai-contract.test.ts                   # 11 pass, 0 fail
bun test tests/ai-elements-images.test.ts            # 7 pass, 0 fail
bun test tests/ai-elements-transport.test.ts         # 19 pass, 0 fail
bun run check                                        # 500 pass, 0 fail, 33 files
```

`tests/ai-chat.test.ts` passes unchanged; this commit does not touch it.

## Open questions

- `prepareImage`'s canvas path — downscaling and JPEG re-encoding — has no
  automated test: `bun test` has neither `createImageBitmap` nor a canvas.
  Prompt 04's manual run covers it.
- GIF animation is lost when a GIF is redrawn; only the first frame survives.
  Said so in the doc comment.
