# 02 — Images on a chat turn

## Goal

A turn can carry up to four images. The browser downscales them, the
contract bounds them, the host hands them to the model as file parts, and
a model that cannot see refuses them with a sentence. History keeps a
placeholder. After this prompt `useBroappChat().sendMessage({ text, files })`
works end to end; no panel shows it until prompt 03.

## Read first

- `prompts/ai-elements/00-common-rules.md` and `reports/01-transport.md`.
- `packages/broapp/src/ai/shared/{contract,types}.ts`.
- `packages/broapp/src/ai/host/run.ts` — `toModelMessages`, `runChat`, and
  where the resolved model and adapter are available.
- `packages/broapp/src/ai/host/create-ai.ts` — the `ai.chat` handler and
  how `resolve()` picks a model; `packages/broapp/src/ai/host/fake.ts` —
  `capabilities`, `calls`.
- `packages/broapp/src/shared/schema.ts` — `s.string({ max, pattern })`,
  `s.array({ max })`, `s.optional`.
- `packages/broapp/src/shared/ndjson.ts` and `packages/broapp/src/host/app.ts`
  — find whether a stream's *params* pass through any size bound.
- `docs/ai.md` §"What leaves the machine" and §"Limitations".
- `node_modules/ai/dist/index.d.ts`: `ModelMessage`, `UserModelMessage`,
  `FilePart` (`data: DataContent | URL`, `mediaType`, `filename?`).

## Step 1 — the contract

In `packages/broapp/src/ai/shared/contract.ts`:

```ts
/** One image on a turn. `data` is base64 without the `data:` prefix. */
const chatFile = s.object({
  name: s.string({ max: 200 }),
  mediaType: s.string({ pattern: /image\/(png|jpeg|gif|webp)/ }),
  data: s.string({ min: 1, max: 2_000_000 }),
});
```

Add `files: s.optional(s.array(chatFile, { max: 4 }))` to `ai.chat` params.
`history` turns do not change. Export the `ChatFile` type from
`shared/types.ts` with a doc comment stating the limits and the
placeholder rule, and add `ChatFile` to the `broapp/ai` and
`broapp/ai/react` re-exports (types only — `index.tsx` already re-exports
types from `../shared/index.ts`; extend that list, do not add code).

`tests/ai-contract.test.ts`: the new field validates and refuses a fifth
file, an `image/svg+xml`, and 2,000,001 characters.

## Step 2 — the host

`run.ts`:

- `toModelMessages` builds the last user message as parts when `files` is
  present and non-empty:
  `[{ type: 'text', text: message }, ...files.map(f => ({ type: 'file', mediaType: f.mediaType, data: f.data, filename: f.name }))]`.
  Verify `FilePart` accepts a base64 string as `data` in the `.d.ts`.
  History turns stay strings.
- Before the model is called, if `files` is non-empty and the resolved
  model's `capabilities.vision` is `false`, end the turn with
  `publicError.rejected('The chosen model cannot read images. Pick one that can in Settings.')`
  as the `error` event, before any `text`. Find the least invasive place
  to know the model's capabilities: the adapter's `models()` result is
  already fetched for `ai.modelsList`; if the resolved model is only an
  id, look it up there (cache per run, not per process) and record the
  decision. When the model is not in the list at all, assume it can see —
  a custom server's list is often incomplete, and the provider will
  answer if it cannot.
- A total over 6,000,000 base64 characters across files →
  `publicError.invalidInput('Images on one message are limited to about 4 MB together.')`.

`create-ai.ts`: pass `files` through to `runChat` (it comes from
`StreamChatParams`, so likely no change beyond the type). `fake.ts`:
`createFakeAdapter({ vision?: boolean })`, default `false` as today.

Measure, do not assume: write a test that sends two files of 1,900,000
characters each through the real bridge and asserts the model received
both. If a request-side bound refuses it, find the bound, report its
value, and lower the contract's per-file `max` so four files fit under it
rather than raising the bound.

## Step 3 — the browser

`packages/broapp-ai-elements/src/images.ts`:

```ts
export interface PreparedImage { readonly name: string; readonly mediaType: string; readonly data: string }
/** Split a data URL. Throws a plain Error with a user sentence when it is not an allowed image. */
export function splitDataUrl(url: string, filename?: string): PreparedImage;
/** Downscale to ≤1568 px on the longest edge and ≤2,000,000 base64 chars, re-encoding as JPEG when needed. */
export async function prepareImage(part: FileUIPart): Promise<PreparedImage>;
export const IMAGE_LIMITS: { readonly maxFiles: 4; readonly maxEdge: 1568; readonly maxBase64: 2_000_000; readonly accept: 'image/png,image/jpeg,image/gif,image/webp' };
```

`prepareImage` uses `createImageBitmap` and an `OffscreenCanvas` (fall
back to a `canvas` element when `OffscreenCanvas` is missing). A PNG or
GIF under both limits passes through untouched, so a small screenshot
keeps its pixels. Anything else is redrawn and encoded as `image/jpeg` at
quality 0.85, halving the edge again while the base64 is still over the
limit. GIF animation is not preserved; say so in the doc comment.

`transport.ts`: replace the step-4 refusal from prompt 01. The last user
message's `file` parts are `await`ed through `prepareImage` (in
`sendMessages`, before subscribing) and sent as `files`. More than four →
`error` chunk `'Up to four images per message.'`. A part `prepareImage`
rejects → `error` chunk with its message. Nothing is sent when any file
fails.

Tests (non-DOM): `splitDataUrl` on a valid PNG data URL, a non-image, a
malformed URL, and a mismatch between the URL's media type and the part's.
`prepareImage`'s canvas path cannot run under `bun test`; the report says
so and prompt 04's manual run covers it.

`tests/ai-elements-transport.test.ts`: a user message with one small PNG
`file` part reaches the fake adapter as a `file` part with
`mediaType: 'image/png'` (adapter `vision: true`); with `vision: false`
the folded result is the refusal sentence and `adapter.modelCalls` is 0;
the history placeholder `[image: shot.png]` appears in the next turn's
history and no `file` part does.

## Step 4 — docs

`docs/ai.md`: in "What leaves the machine" add one sentence: an image
pasted or attached to a message is sent to the provider with that
message, once. In "Limitations" replace "No images" with the actual
limits (four per message, 1568 px, about 1.5 MB each after downscaling,
only the message they arrive with) and note that `broapp/ai/react`'s
`AiChat` does not send images.

## Verify

```bash
bun run typecheck
bun test tests/ai-contract.test.ts tests/ai-chat.test.ts tests/ai-elements-transport.test.ts
bun run check
```

`tests/ai-chat.test.ts` must pass **unchanged**.

## Report

`prompts/ai-elements/reports/02-attachments.md`. Include: where the
model's capabilities were read from and why; whether a request-side size
bound exists and its value; the exact `FilePart` shape used.

Commit:

```
Let a chat turn carry images, downscaled in the browser and refused by models without vision
```
