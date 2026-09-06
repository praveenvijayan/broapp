# 07 — Notes example, documentation, release

`rm -rf node_modules && bun install --frozen-lockfile` → ok. `bun run check` →
`219 pass, 0 fail` across 18 files, exit 0. `examples/notes`: `bun run check` →
`18 pass, 0 fail`; `bun run build` → 69.4 MiB; `smoke-binary.ts ./release/notes
--call ai.settingsGet` → all checks passed. `bun run site` → 17 pages including
`ai.html`. `bun run dryrun` → passed. CI needed no change.

## Binary size

| | bytes | MiB |
|---|---:|---:|
| before (this branch, AI not yet wired into notes) | 65,611,250 | 62.6 |
| after | 72,810,482 | 69.4 |
| delta | +7,199,232 | +6.9 |

Matches the spike's +6.88 MB for the three AI SDK packages, plus the layer.

## Step 3 — what I actually saw

Run against the compiled binary rather than `bun run dev`; see "dev is broken"
below. Ollama **is** running on this machine, so the optional paths were taken.

1. **Ollama.** All four providers listed. Selecting *Ollama (local)* filled the
   address with `http://127.0.0.1:11434/v1` and listed five real local models.
   Notice: "Runs on this computer. Nothing is sent over the internet." Test
   connection: **"Connected to Ollama (local). (17 ms)"**.
2. **Anthropic without a key.** Notice changed to "Messages, the documents you
   are viewing, and search results are sent to Anthropic to generate answers."
   Test connection: **"An API key is required for Anthropic."** The model list
   separately reported "Anthropic rejected the API key." — listing models is a
   real request, and 401 maps to that sentence with no body quoted.
3. **The fake key.** Saving `sk-ant-test-0000000000abcd` gave **"A key ending
   in abcd is saved."** and cleared the input. On disk: `secrets.json` mode
   `600` with the key, `settings.json` mode `644` without it. Restart: still
   saved. Unchecking *Remember* **deleted `secrets.json` immediately**; after a
   restart the hint was gone and `hasKey` was false.
4. **No provider.** The Ask panel showed "AI is not set up. Open Settings to
   choose a provider."
5. **A real turn.** "How many notes do I have?" → a `Used notes.list` row, then
   *"You have 1 note: Buy milk (not done yet)."* Then "Create a note titled
   Groceries with body Eggs and butter" → `Used notes.create` → **Allow this? /
   Allow / Decline** → Allow → the note appeared in the list the moment the
   result arrived, and the model replied *"Done — created note Groceries…"*.
   Usage: **"1424 tokens in, 108 out"**.
6. **Cancel.** Mid-answer, Stop froze the text at 145 characters, kept it, and
   cleared the typing indicator. The host log printed nothing.

## Four bugs the manual run found, all fixed

1. **"AI is not set up yet" when a provider *was* chosen.** `resolve()` gave one
   message for a missing provider and a missing model. Now: key first (`An API
   key is required for <label>.`), then address, then `Choose a model for
   <label>.` — the key comes first because the model list is fetched *from* the
   provider.
2. **`ai.providersList` reported Anthropic as local.** `configFor` applied the
   *selected* provider's stored base URL to every adapter, so having Ollama
   selected made Anthropic loopback. The base URL is now scoped to the provider
   it belongs to. This was the worst of the four: it is the "does this leave my
   computer" answer. `tests/ai-providers.test.ts` covers it, and fails without
   the fix.
3. **`onToolResult` never fired**, so the list did not refresh after a confirmed
   tool. It read the settled call out of a `setMessages` updater, which React
   runs when it chooses — always after the read. The hook now keeps the turn's
   calls in a ref and calls back from the event.
4. **Usage always read 0.** `createOpenAICompatible` omits token counts from a
   streamed response unless `includeUsage: true`; it is now passed.

## dev is broken here, and it is not this branch

`bun run dev` serves its own launch URL a `403` on the first request, from a
fresh server, to plain `curl` as much as to a browser. The compiled binary
built from the same source bootstraps (`303`) and passes the full smoke test,
and `bun run dryrun` — which builds and runs a generated project — passes. So
the fault is in `broapp dev`, not in the AI layer or the example, and it is
outside this prompt's scope. Worth its own investigation.

## Documentation

`docs/ai.md` (all eight sections), registered in `build-site.ts` under *Guides*.
`README.md`: a bullet in "What Broapp contributes", the two packages in "What is
in here", `src/host/ai.ts` in "How an application is shaped", the doc link.
`docs/architecture.md`: "Three layers" is now "Four layers" with a paragraph,
plus a line in "What Broapp adds". `docs/security.md`: two paragraphs under
"What this does not protect against" — what a remote provider sees, and the
key-file posture. `skills/broapp/references/ai-layer.md`, linked from a new
workflow step 9 and the references list, plus an eleventh hard rule;
`tests/skill.test.ts` still passes. `examples/notes/README.md` gains an "AI"
section.

## What the docs promise that I could not verify

- **Cross-platform key file mode.** `chmod 0600` is asserted on this machine
  only; the Windows no-op path is written but untested.
- **Providers other than Ollama.** Anthropic, OpenAI and a custom server were
  exercised against a stubbed `fetch` and, for Anthropic, one real unauthorised
  request. No real key was used, and none was read from the environment.
- **"No markdown rendering" is visible to users**: the local model emits
  `**bold**`, which the panel shows literally. Intended, but it is what a user
  sees.
- The notes lede still says "Nothing leaves it", now followed by "AI features
  are optional and off until you set them up in Settings." Both are true
  together only because the second is there; if the example ever ships with a
  provider preconfigured, the first sentence has to go.
