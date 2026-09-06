# Common rules for every AI-layer prompt

Read this file completely before starting any numbered prompt. These rules
override anything you remember about how Broapp or the AI SDK "usually"
works.

## 1. What you are building

Broapp gets a fourth layer: an optional, provider-independent AI capability
that any Broapp application can turn on. It lives in the **host process**
only. The browser never talks to an AI provider directly — the page's CSP
(`connect-src 'self' ws://127.0.0.1:*`) forbids it, and that is deliberate.

Fixed decisions. Do not reopen them.

| Decision | Value |
|---|---|
| Engine | Vercel AI SDK, pinned: `ai@7.0.93`, `@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai-compatible@3.0.44`. Exact versions, no `^`. |
| Engine visibility | Only `packages/broapp/src/ai/host/**` and the `packages/broapp-ai-*` packages import from `ai` or `@ai-sdk/*`. Nothing under `src/ai/shared` or `src/ai/react` may import them. A test enforces this. |
| Subpath exports (in `packages/broapp/package.json`) | `broapp/ai` → `src/ai/shared/index.ts`, `broapp/ai/host` → `src/ai/host/index.ts`, `broapp/ai/react` → `src/ai/react/index.tsx` |
| Provider packages | `packages/broapp-ai-anthropic`, `packages/broapp-ai-compatible`. npm names `broapp-ai-anthropic`, `broapp-ai-compatible`. Not scoped. |
| `ai` dependency shape | `peerDependencies` of `broapp` with `peerDependenciesMeta.optional: true`; `devDependencies` of the workspace root; `dependencies` of each provider package. |
| Route group | Every AI route is in group `ai`. An application contract that declares any `ai.*` route is refused at startup. |
| AI contract | One constant, `aiContract`, exported from `broapp/ai`. It is **not** merged into the application's contract on the host. On the host it is mounted as a second `HostApp` on the same bridge. In the browser it is passed to `BroappProvider` through a new `extensions` prop. |
| Secrets | Never returned to the browser. Never logged. Never in a `PublicError` message. Never in a chat transcript. |
| Data directory layout | `<dataDir>/ai/settings.json` (no secrets), `<dataDir>/ai/secrets.json` (mode `0600`). |
| Default provider | None. Until the user configures one, every AI route except `ai.settings.*`, `ai.providers.list` answers `publicError.unavailable('AI is not set up yet. Open Settings to choose a provider.')`. |

## 2. Repository conventions you must follow

- Bun ≥ 1.2, TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Relative imports carry the `.ts` / `.tsx` extension. Named exports only.
- Run everything with `bun`. Never `npm`, `npx`, `node`, `yarn`, `pnpm`.
- Tests live in `tests/` at the repository root (framework tests) or in `examples/<name>/tests/` (example tests), use `bun:test`, and run with `bun test tests`. Real-bridge tests use `tests/harness.ts`. Read it before writing one.
- Tests must not use the network. Mock `fetch` by passing a `fetch` function into whatever you are testing, never by patching `globalThis.fetch`.
- Comments explain *why*, in full sentences. Match the tone of `packages/broapp/src/host/app.ts`.
- Errors that reach the browser are `PublicError` (from `broapp/host`) with one of the existing codes: `invalid_input`, `not_found`, `conflict`, `unavailable`, `rejected`. Anything else becomes a fixed sentence automatically. Do not add codes.
- Do not touch: anything about Brobridge options, the CSP in `build-page.ts`, the route table, loopback binding, `open-browser.ts`, the generator's offline path.
- Do not add dependencies beyond the ones the prompt lists.
- No `any`. No `// @ts-ignore`. No `eslint-disable` except the one pattern already used in `hooks.tsx` for the connection effect.

## 3. Verifying third-party APIs

You will be tempted to write AI SDK calls from memory. Do not. The API
changed between major versions. Before writing any call into `ai` or
`@ai-sdk/*`:

1. Open `node_modules/ai/dist/index.d.ts` (search inside it; it is large).
2. Confirm the exact export name, parameter names and the shape of stream
   parts you rely on.
3. If a name in a prompt differs from the `.d.ts`, **the `.d.ts` wins**.
   Note the difference in your report.

Same for `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible`: open their
`dist/index.d.ts`.

## 4. Working method

1. Read the files the prompt lists under "Read first", completely.
2. Read `prompts/ai-layer/reports/*.md` written by earlier prompts.
3. Write a five-line plan in your first message: files you will create,
   files you will modify, tests you will add. Then start.
4. Implement in the order the prompt gives. Run the prompt's verification
   commands after each numbered step, not only at the end.
5. When a verification command fails, fix the cause. Do not delete or skip
   the test. Do not loosen an assertion to make it pass.
6. When done, run the full gate:

   ```bash
   bun install
   bun run check
   ```

   Both must exit 0.

7. Write the report file the prompt names. Include: what was built, every
   deviation from the prompt and why, exact commands run and their final
   status lines, open questions. Keep it under 80 lines.
8. Commit with the message the prompt gives. One commit per prompt.

## 5. When you are unsure

- If a prompt's instruction conflicts with a file in the repository, the
  repository is right about how things work today, the prompt is right about
  what to build. Report the conflict.
- If something needs a design decision the prompt did not make, choose the
  option that changes the fewest existing files, and write the decision in
  the report under "Decisions I made".
- Never ask the user a question mid-task. Decide, record, continue.
- Never stub a feature with a `TODO` and call the prompt done. If a part
  cannot be finished, finish everything else, then say so in the report.

## 6. Facts established by the spike (report 01)

- `bun build --compile --bytecode` (Broapp's default) rejects top-level
  `await`. Every host entry point and every module under `src/ai/host`
  keeps `await` inside functions. `examples/notes/src/host/main.ts` already
  does this with `main().then(...)`; copy that shape.
- A **string** model id (`'anthropic/claude-opus-5'`) routes through the
  Vercel AI Gateway with the global `fetch`. The layer passes a provider
  **instance** to `streamText` always. `ProviderAdapter.model()` is the
  only place a model is made.
- `ai/test` exports `MockLanguageModelV4`; `simulateReadableStream` is
  exported from both `ai` and `ai/test`. `stepCountIs` is an alias of
  `isStepCount`. `jsonSchema` and `tool` are re-exported by `ai`.
- The three packages add about 6.9 MB to a compiled binary. Applications
  that do not import `broapp/ai/host` pay nothing; keep it that way.
