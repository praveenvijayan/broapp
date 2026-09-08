# 07 — The launcher becomes a chat workspace

## What was built

`broapp-ai-elements/ui` gained four components — `BroappModelPicker` (with
`BroappModelList` under it), `BroappChatMenu`, `BroappThreadList`,
`BroappSchemeToggle` — plus `topBar`, `loading`, `threadId`, `modelId` and
`onTurnEnd` on `BroappChat`, and a one-row prompt bar. The launcher's `App.tsx`
is a four-column shell (rail, history, chat, applications) with Settings as an
overlay; `launcher.css` is rewritten; `scheme.ts` and `main.tsx` apply the
scheme before the first render. `main.ts` closes the AI layer on shutdown.
Docs: "The workspace pieces" in `docs/ai.md`. Tests: 12 more cases in
`ai-elements-view.test.tsx`, one more in `ai-elements-css.test.ts`.

## Decisions I made

- **The scheme is an attribute, not `light-dark()`.** Step 3's mechanism does
  not survive `buildPage`: Bun's CSS bundler downlevels `light-dark()` into a
  `prefers-color-scheme` query with two toggle variables. Measured in the built
  page — `--launcher-ground` reads
  `var(--buncss-light,#f6f7f9)var(--buncss-dark,#16171a)` — and setting
  `documentElement.style.colorScheme` changed nothing at all. So the palette is
  three blocks keyed on `data-scheme`, each setting `color-scheme` too. The
  same downlevelling hits the *panel's* `light-dark()` fallbacks, so the
  launcher now defines every variable the panel reads (`--pending` is new);
  the panel follows the launcher rather than the machine, which is 04d's rule
  by another route.
- **`BroappModelList` is exported.** The picker reads `useAiModels`, which
  answers nothing under `renderToString`, so the rows it draws are a component
  of their own — that is where the vision badge and the check are tested.
- **`onTurnEnd` is new on the hook and the panel.** The host derives a title
  from the first message; the browser cannot predict it, and `useAiThreads`
  only re-reads after its own writes. Without this the list said "New
  conversation" until something else refreshed it.
- **`useAiThreads` starts `loading: true`.** It always refreshes in an effect,
  so the render before that answered "no conversations" and the launcher made
  one on every reload. Two threads after one reload, until this.
- **A collapsed column is not rendered**, rather than rendered at `width: 0`.
  The grid column is `0` either way.
- **`BroappThreadList` takes `onCollapse` and `now`**, neither in the prompt's
  interface: the collapse button needs a caller, and a fixed `now` is what
  makes the day grouping testable.
- **The menu has three callbacks, not four.** The two-step delete is its own
  state; nothing outside it needs to know about the question.
- **A disabled picker uses `title`, not the vendored tooltip.** A disabled
  button fires none of the events a tooltip listens for.
- **`ai.close()` went into `main.ts`, not `tab.ts`.** `tab.ts` has no shutdown
  path — it returns the `Ai` and `main.ts`'s `onShutdown` is where `abortAll`
  already is. One line, beside it.
- **The launcher's `data-scheme` selector work is duplicated for dark** (media
  query and attribute) because a media query cannot join a selector list.

## Small widths

Below **60rem** the applications move under the chat (`'rail history chat' /
'rail history apps'`, rows `1fr` / `45vh`). Below **40rem** the grid is
`'rail chat'` and both side columns become fixed panels over it — shown only
when the rail asks for one, tracked as `narrowPanel`. Two overlays open at once
is what a window resized down from a desktop width would otherwise have, and it
buried the conversation; measured before the fix.

## The manual run

Compiled launcher (`build:launcher`), `BROAPP_DATA_DIR` under the scratch
directory, Ollama at `127.0.0.1:11434`, `gemma4:31b-mlx`. Widths and the
machine's scheme were emulated on the browser pane.

| # | Outcome |
|---|---|
| 1 | ✅ rail + History + chat + applications, no Settings, no drawer |
| 2 | ✅ history 240 → 0 px, chat 512 → 752 px, applications 480 px throughout |
| 3 | ✅ search box, "Default (follow Settings)" first with the check, `vision` on gemma4 / muse-glimmer / qwen3.8 and not on glm-5.2 / nirnex-model — Ollama's own answer |
| 4 | ✅ picked gemma4, sent, reloaded: same thread, `gemma4:31b-mlx` on the picker and under the row, transcript and usage line restored |
| 5 | ✅ `+` → "New conversation", picker back to "Default · gemma4:31b-mlx", enabled |
| 6 | ✅ "Used apps.list / Completed", "You have no applications on this computer.", 4336 tokens in, 82 out; History showed the derived title once the turn was written |
| 7 | ✅ renamed to "Which applications" from the row menu; still there after a reload |
| 8 | ✅ drawer over the applications with a backdrop; `grid-template-columns` identical before, during and after (`48px 240px 512px 480px`); Escape closed it; focus returned to the Settings button |
| 9 | ✅ provider set to Ollama in the drawer, model chosen: the picker read "Default · gemma4:31b-mlx" without a reload |
| 10 | ✅ Clear chat: transcript empty, thread still listed, suggestions back |
| 11 | ✅ Delete chat: "Delete this conversation? · Delete / Cancel" inside the still-open menu; after Delete the next thread was selected |
| 12 | ✅ light: ground `#f6f7f9`, text `#33383f`, panel the same, typed text legible. Dark: `#16171a` / `#eceef1`. Reload came back dark with the attribute set before the first script tick — no flash |
| 13 | ✅ on "system", emulating light then dark on the pane switched the whole page both ways |
| 14 | ✅ a 320×240 PNG pasted as a `ClipboardEvent`, chip with a `data:` thumbnail, Enter: "The image contains a red circle and a blue rectangle on a white background." — 2435 tokens in |
| 15 | ✅ `source.change` on an imported `notes`: "Allow this? expires in 10:00", tab title `(1) Autoapp`, History unchanged; Allow → "Completed", the file written, the applications column showed "Proposed change · Changed: src/hello.txt", title back to `Autoapp` |
| 16 | ✅ Settings → Clear all conversations → "Delete every conversation?" → list empty and one fresh conversation created and selected |
| 17 | ✅ 800 px: applications under the chat (`rows 385px 315px`). 560 px: `'rail chat'`, both side panels hidden until the rail asked, then one at a time |

## What `AiSettings` did not offer

It draws its own `<section class="card ai-settings">` with its own `AI` heading
and cannot be given a class, a heading level or a width. So the drawer puts its
own header above it and lets it size itself; the "Conversations" section beside
it is a second `.launcher__card` written here rather than a section inside
`AiSettings`. The launcher shows no data-directory line today, so the drawer
adds none. Nothing in `broapp/ai/react` was edited.

## Sizes

The launcher page went **1138.9 → 1237.0 KiB**, its binary 74.6 → 75.0 MB.
`styles.css` went 50.0 → 58.4 KiB.

## Commands run

```
bun run build:css                                  # wrote styles.css
bun run typecheck                                  # exit 0
bun test ai-elements-{view,css,source}             # 43 pass, 0 fail
bun run --cwd packages/broapp-autoapp build:page   # 1237.0 KiB, one <style>, one CSP meta
bun run --cwd packages/broapp-autoapp build:launcher  # 75.0 MB
bun install && bun run check                       # 573 pass, 0 fail, 37 files
bun run dryrun:autoapp                             # Autoapp dry run passed
```

## Open questions

- **`tests/ai-threads.test.ts` is flaky, and was before this branch.** Its
  round-trip case expects `[first, second]` after saving to `first`, but
  `ORDER BY updated_at DESC, id DESC` breaks a same-millisecond tie by a random
  UUID. Stashing every change here and running it six times at `HEAD` failed
  three times. `threads.ts` is prompt 06's; the fix is a monotonic
  `updated_at`, not a looser assertion.
- **The panel's own `light-dark()` fallbacks still answer the machine** in any
  page built by `buildPage`. It does not show here because the launcher defines
  every variable they fall back from, but an application that defines none
  would see the panel follow the OS while its own colours did not.
