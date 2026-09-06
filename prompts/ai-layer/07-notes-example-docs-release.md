# 07 — Wire the notes example, document the layer, prove the release

## Goal

The notes example becomes the reference AI-enabled Broapp. The
documentation, README, agent skill and site describe the layer. CI builds
it. The release dry run passes. This is the prompt where you run the real
application and look at it.

## Read first

- `prompts/ai-layer/00-common-rules.md` and reports 01–06.
- `examples/notes/src/**` — all of it.
- `examples/notes/README.md`, `examples/notes/tests/db.test.ts`.
- `docs/architecture.md`, `docs/security.md`, `docs/host-operations.md` — tone and structure for the new doc.
- `README.md` sections "What Broapp contributes", "How an application is shaped", "Documentation".
- `skills/broapp/SKILL.md` and `skills/broapp/references/*.md`; `tests/skill.test.ts` (size and link rules).
- `scripts/build-site.ts` — the `PAGES` list near line 30.
- `.github/workflows/ci.yml`, `scripts/smoke-binary.ts`, `scripts/release-dry-run.ts`.

## Step 1 — notes host

`examples/notes/package.json`: add dependencies `broapp-ai-anthropic: workspace:*`,
`broapp-ai-compatible: workspace:*`.

`examples/notes/src/host/db.ts`: add to `Store`:

```ts
/** Case-insensitive substring search over title and body, newest first. */
search(text: string, limit: number): Note[];
/** Notes by id, in the order asked, skipping ids that no longer exist. */
byIds(ids: readonly number[]): Note[];
```

Bound parameters only. Add tests for both in `db.test.ts`.

New file `examples/notes/src/host/ai.ts`:

```ts
export function createNotesAi(app: HostApp<AppContract>, state: StoreState, dataDir: string): Ai
```

- `providers: [anthropic(), ollama(), openai(), customServer()]`.
- `app: { name: 'Notes', purpose: 'Keeps the user's personal notes in a SQLite database on this computer. Each note has a title, a body, a done flag and timestamps.', terminology: ['note', 'done', 'pinned'] }`.
- `context.search`: `store.search(text, limit)` → refs `note:<id>`, title, snippet = first 160 chars of body.
- `context.resolve`: parse `note:<id>` refs (ignore malformed), `store.byIds`, content = `Title: …\nStatus: done|to do\nUpdated: <ISO>\n\n<body>`.
- `tools`: `fromContract(contract, app, { read: ['notes.list'], confirm: ['notes.create', 'notes.update', 'notes.remove'] })`. This requires every one of those routes to have a `summary` in `contract.ts` — add the missing ones.
- When the store is unhealthy (`state.ok === false`), `search` and `resolve` return `[]` rather than throwing; the tools still go through `app.invoke`, which already answers with the store's public error.

`main.ts`: create the AI after `createApp(state)`, pass `dataDir`, and:

```ts
register: (bridge) => { app.mount(bridge); ai.mount(bridge); },
isBusy: () => app.activeStreams > 0 || ai.activeStreams > 0,
onShutdown: () => { ai.abortAll('the application is shutting down'); app.abortAll(...); if (state.ok) state.store.close(); },
```

## Step 2 — notes UI

- `main.tsx`: `<BroappProvider contract={contract} extensions={[aiContract]}><AiProvider>…`. Import `broapp/ai/react/ai.css`.
- `App.tsx`: add a header button "Settings" toggling a `<section className="card">` that contains `<AiSettings />`. Add an "Ask" panel in the main column: `<AiChat refs={editing !== null ? [`note:${editing}`] : []} placeholder="Ask about your notes…" />`. When a note is being edited, the chat sees it. When the AI creates or changes a note through a confirmed tool, refresh the list: pass an `onToolResult` callback — add that optional prop to `AiChat` (and `useAiChat`) now if prompt 06 did not: `onToolResult?(call: ToolCallState): void`.
- Keep the existing lede. Add one sentence under it: "AI features are optional and off until you set them up in Settings."

## Step 3 — run it and look

```bash
cd examples/notes && bun run dev
```

Open the URL. Do all of the following and write what you saw in the report:

1. Settings → provider "Ollama (local)". If an Ollama server is running on this machine, Test connection succeeds and models list. If not, the test shows the network error message inline and nothing crashes. Either outcome is acceptable; record which.
2. Provider "Anthropic" without a key → notice says data is sent to Anthropic; Test connection reports the key is required.
3. Type a fake key `sk-ant-test-0000000000abcd` → "A key ending in abcd is saved." Reload the page → still saved. Uncheck "Remember" → reload → key gone.
4. Ask panel with no provider configured → the "not set up" line.
5. If any real provider is reachable (Ollama with a model pulled, or a real key the operator exported as `ANTHROPIC_API_KEY` — read it only to paste into the field yourself; never write it into a file or a test), send "How many notes do I have?" and confirm a tool call for `notes.list` appears, then an answer. Then "Create a note titled Hello with body World" → a confirmation row → Allow → the list refreshes with the new note. If no provider is reachable, say so and skip.
6. Cancel: send a message and press Stop before it finishes. The assistant bubble keeps the partial text; the host log shows no error.

Take no screenshots into the repository.

## Step 4 — documentation

Create `docs/ai.md`, in the style of the other docs, sections:

1. **What it is** — the fourth layer, host-only, optional, provider-independent, one sentence on why the browser cannot call providers (CSP).
2. **Turning it on** — the four code touches from the notes example, verbatim.
3. **How the model knows your application** — description, context providers, tools from the contract, permissions, the confirmation flow; the system prompt's rule that documents are data.
4. **Settings and keys** — routes, where files live, the file-store posture in plain words, `remember: false`, what is never sent to the browser.
5. **Providers** — the two packages, which servers the compatible one covers, how to write an adapter (the interface).
6. **What leaves the machine** — an honest table: local provider → nothing; remote provider → message, history, resolved documents, search snippets, tool inputs and outputs. Say that Broapp shows this notice in `<AiSettings/>` and that an application must not hide it.
7. **Testing your application's AI** — `createFakeAdapter` with a script, one example.
8. **Limitations** — no markdown rendering, no threads persistence yet, no OS keychain yet, no images, one turn at a time.

Register it in `scripts/build-site.ts` under group `Guides` as `{ slug: 'ai.html', title: 'AI layer', source: 'docs/ai.md' }`.

`README.md`: add a bullet to "What Broapp contributes" and a line in "How an application is shaped" showing the `ai.ts` file; add the doc link under "Documentation". Update `docs/architecture.md` "Three layers" to four, with one paragraph, and the "What Broapp adds" list. Update `docs/security.md` with a short "AI providers" subsection under "What this does not protect against": a remote provider sees what the notice says; the key file posture.

`skills/broapp/`: add `references/ai-layer.md` (the turning-on steps, the tool permission rule, the fake adapter for tests) and link it from `SKILL.md` in the workflow and in the references list. `tests/skill.test.ts` has size and link rules — keep them green.

`examples/notes/README.md`: a section "AI" describing what the example shows.

## Step 5 — CI and release

- `.github/workflows/ci.yml`: nothing should need to change — `bun install --frozen-lockfile` covers the new packages and the notes matrix entry builds. Run the same commands locally that the `examples` job runs for notes, including `bun run ../../scripts/smoke-binary.ts ./release/notes`. If `smoke-binary.ts` supports `--call`, also call `ai.settings.get` and check it answers `configured: false`.
- `bun run dryrun` must pass with the two new packages.
- Check `bun.lock` is committed and `bun install --frozen-lockfile` succeeds from clean (`rm -rf node_modules` first, then install).

## Verify

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun run check
cd examples/notes && bun run check && bun run build && bun run ../../scripts/smoke-binary.ts ./release/notes && cd ../..
bun run site
bun run dryrun
```

## Report

`prompts/ai-layer/reports/07-notes-docs.md`. Include the step 3
observations verbatim, the notes binary size before and after (build
`main` at the previous commit for the before number), and anything the
docs promise that you could not verify.

Commit:

```
Wire the AI layer into the notes example and document it
```
