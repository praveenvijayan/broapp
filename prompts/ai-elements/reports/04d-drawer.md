# 04d — The panel follows the page, and opens as a drawer

## What was built

- **`tailwind.css`**: the `prefers-color-scheme` colour block is gone; every
  literal fallback is a `light-dark()` pair, so the scheme is the page's
  inherited `color-scheme` and never the machine's. The token block now covers
  `.broapp-chat-drawer` and `.broapp-chat-toggle` too. The part of preflight a
  form control needs is reproduced at `:where()` specificity, and
  `@layer components` gained the drawer, the toggle and the counter.
- **`BroappChatDrawer.tsx`**: `BroappChatDrawer`, `BroappChatToggle`.
  **`transcript.ts`**: `transcriptOf` — `You:` / `Assistant:` blocks, a tool
  call as `Used <tool>`, a file as `[image: <name>]`.
- **`BroappChatView`**: `suggestions`, `suggestionTip`, `maxLength` (default
  `MESSAGE_MAX_LENGTH`, 20,000 — the contract's cap), the counter.
  **`BroappChat`**: forwards those, takes `frame` (`"card"` | `"plain"`), and
  publishes `clear` / `transcript` through `controlsRef`.
- **Launcher**: `launcher__aside` gone, one-column grid, `:root` aliases the
  panel's variables onto `--launcher-*`, the toggle is in the header, the
  drawer follows `</main>`, and `broapp-autoapp:engineer-open` remembers it.

## Decisions I made

- **`--secondary`, `--muted`, `--accent-surface` read `--surface`.** The two
  scheme blocks disagreed — `--bg` in light, `--surface` in dark — and one
  property cannot name two variables. `--surface` keeps dark exactly as it was
  and means "a panel, not the page" in both.
- **Tailwind's `dark:` variant is repointed at an attribute nothing sets**
  (`@custom-variant dark`): it compiled to a `prefers-color-scheme` query out
  of streamdown's markup — the same bug in a smaller form — and every token
  those utilities set is already a pair.
- **The drawer's header reaches the conversation through a ref.** It is drawn
  above `BroappChat` and cannot be inside it, and `clear` / `transcript` are
  only read from a click, so a ref assigned during render — the idiom
  `useBroappChat` already uses — is enough.
- **`.launcher--drawer-open` reserves 26rem on the right**, because the drawer
  is fixed above the page and was covering the launcher's own header buttons,
  Settings among them. Its width is an inline custom property rather than an
  inline `width`, so `max-width: 40rem` can still take it to full width.
- **`userAgentData.platform` first, then the deprecated `navigator.platform`**;
  both are absent on a server, where ⌘ is assumed.
- **Suggestions, tip and counter live in `BroappChatView`.** The drawer renders
  `BroappChat`, which needs `AiProvider` and a connection, so a
  `renderToString` of it reaches only the "checking the settings" state. They
  are tested where they render; the drawer's cases cover the aside, the header,
  the description and the width.

## The manual run

Launcher from source (`… src/launcher/main.ts open --no-open`),
`BROAPP_DATA_DIR` under the scratch directory, Ollama at `127.0.0.1:11434`,
`gemma4:31b-mlx`. Dark was emulated on the browser pane rather than set on the
machine — the panel cannot tell the difference, which is the point of 1–3.

| # | Outcome |
|---|---|
| 1 | ✅ page light, no drawer, "Ask AI ⌘ I" in the header |
| 2 | ✅ ⌘I slid it in; background `rgb(246,247,249)` — the launcher's own ground, **light** under an emulated-dark browser; textarea focused |
| 3 | ✅ "hello there" legible, placeholder muted, counter "11 / 20000" |
| 4 | ✅ the first suggestion sent; "Used apps.list / Completed", "You have no applications on this computer.", "4336 tokens in, 82 out"; suggestions gone |
| 5 | ✅ Escape closed it; focus back on the toggle |
| 6 | ✅ reload came back open; the stored value is `"true"` |
| 7 | ✅ `You: What applications do I have?` / `Assistant: Used apps.list` + the answer — read back through the `writeText` call, since the pane refuses clipboard reads |
| 8 | ✅ transcript empty, suggestions and tip back |
| 9 | ✅ 600 px viewport: drawer `width: 600px`. The tip read "Ctrl I" there, because a sub-768 viewport also emulates an Android agent — the platform check working, not failing |
| 10 | ✅ notes (`broapp dev`) dark: page and panel both `#16171a`, text `#eceef1`, textarea text light. Light: both `#fbfbfa`, text `#1b1a18` |

**The floor**, in `docs/ai.md` Limitations: `light-dark()` needs Chrome 123,
Safari 17.5 or Firefox 120; older paints the light half of every pair.
**Notes and step 1**: notes declares `color-scheme: light dark` and swaps its
own variables in a `prefers-color-scheme` block, so the two agree — the panel
follows the OS exactly where the page's colours do. The launcher, declaring
nothing, is the opposite case, and the one that was wrong.

## Commands run

`build:css` (wrote `styles.css`), `bun run typecheck` (exit 0), `bun test` on
the view / css / source files (23, 5 and 6 pass, 0 fail), `build:page`
(1138.9 KiB), `bun install && bun run check` (549 pass, 0 fail, 36 files),
`examples/notes` `bunx tsc --noEmit` (exit 0).