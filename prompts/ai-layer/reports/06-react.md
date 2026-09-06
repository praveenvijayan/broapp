# 06 — The AI React layer

`bun run check` exit 0. Typecheck is the gate here, as the prompt says; the
visual check happens in prompt 07.

## What was built

- `BroappProvider` gained `extensions?: readonly AnyContract[]`. The merge runs
  once, in a `useRef`, and the merged contract is what `createClient` is given
  and what the context now carries. Behaviour without `extensions` is
  unchanged.
- `useBroappContract()` on `broapp/react`, so an extension's provider can check
  it was installed. `AiProvider` throws the prompt's exact sentence at render
  when `ai.settingsGet` is missing — at render, rather than at the first call,
  because the mistake is in the provider setup.
- `packages/broapp/src/ai/react/`: `provider.tsx`, `use-ai-settings.ts`,
  `use-ai-models.ts`, `use-ai-chat.ts`, `AiSettings.tsx`, `AiChat.tsx`,
  `ai.css`, `index.tsx`. Exported as `broapp/ai/react` and
  `broapp/ai/react/ai.css`.
- Tests: `tests/build.test.ts` gains a passing browser bundle of
  `broapp/ai/react` that is checked for engine symbols and for off-origin
  references; `tests/contract.test.ts` gains the merge the provider performs;
  `tests/ai-engine-boundary.test.ts` now walks the React directory too and
  still passes.

## Decisions I made

- **`AiProvider` owns the settings; the hooks read them from it.** The panel
  and the chat must agree about `configured`, and two independent fetches can
  disagree for a whole round trip. Every write returns the new settings, so
  `useAiSettings.update` replaces the shared copy without a second call.
- **The route names are prompt 03's**, not prompt 06's: `ai.settingsGet`,
  `ai.settingsUpdate`, `ai.providersList`, `ai.modelsList`,
  `ai.connectionTest`, `ai.chatConfirm`. See `reports/03-host.md` for why.
- **The key input is write-only.** It starts empty, is never populated from the
  host — the host cannot supply it — and is cleared after a save. `hasKey` and
  `keyHint` are the only things the interface knows about a stored key.
- **The base URL input keeps a local draft** and saves on blur, so a
  half-typed address is not written on every keystroke; the draft is dropped
  when the provider changes.
- **`useAiModels` refetches on `provider`, `baseUrl` and `hasKey`** and holds a
  generation counter, so a slow list for a provider the user has moved away
  from cannot replace the one on screen.
- **`send` while a turn is running is ignored**, as specified. `cancel` keeps
  the text so far: the user asked to stop, not to undo.
- **No markdown renderer.** Assistant text is a `<pre>` with `white-space:
  pre-wrap`. The text was produced by a model that has just been shown
  documents from the user's machine, and a renderer that turns part of it into
  markup is a route from a document into the page.
- `ai.css` uses the notes example's custom properties with literal fallbacks,
  so the panels take an application's colours where they exist and stay legible
  where they do not. No `@import`, no `url()`, and the typing indicator is
  disabled under `prefers-reduced-motion`.

## Not done here

No React render test. The repository sets up no DOM, and the prompt forbids
adding one. What is covered instead: the contract merge the provider performs,
the bundle boundary, and typecheck across every component.

## Open questions

- None blocking. One thing found while writing the panel and fixed here:
  `settings` is `null` until the first read returns, so `configured !== true`
  would have shown "AI is not set up" for a paint or two after connecting even
  when it is. `AiChat` now distinguishes the three states and says "Checking the
  AI settings…" for the first.
