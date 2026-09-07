# 04d — The panel follows the page, and opens as a drawer

## Why

Two bugs seen in the launcher on a Mac in dark mode, and one feature.

1. **The panel is dark inside a light page.** `launcher.css` declares no
   dark scheme and uses `--launcher-*` variables, not `--bg` / `--text`.
   The panel's `@media (prefers-color-scheme: dark)` block in
   `packages/broapp-ai-elements/src/ui/tailwind.css` keys on the **OS**, so
   with macOS dark and the page light, the panel paints its dark literals
   into a white page. The scheme must follow what the *page* declares,
   never the OS directly.
2. **Text typed into the input is invisible.** Preflight is off (fixed
   decision), and browsers do not inherit `color` or `font` into form
   controls, so the textarea takes the page's dark text on the panel's
   dark ground. Preflight's form-control reset has to be reproduced,
   scoped.
3. **The chat should open as a drawer from the right edge of the window**
   with a header (title, copy transcript, clear, close), suggestions when
   empty, a character counter, a keyboard shortcut, and a toggle button.
   The launcher moves its Engineer panel into that drawer.

Regression guard item 13 is refined by this prompt: *legible under both
schemes* stays; *which* scheme is the page's `color-scheme`, not the OS.

Allowed launcher files for this prompt: `src/launcher/ui/App.tsx`,
`main.tsx`, **and `launcher.css`**. Nothing else under `launcher/`.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–04c.
- `packages/broapp-ai-elements/src/ui/tailwind.css`, all of it.
- `packages/broapp-ai-elements/src/ui/{BroappChat,BroappChatView}.tsx`,
  `src/ui/index.tsx`.
- `packages/broapp-autoapp/src/launcher/ui/{App.tsx,launcher.css}` — the
  grid (`'header header' 'main aside'`), the `launcher__aside` block, the
  header actions.
- `packages/broapp-autoapp/src/react/index.tsx` — `titleWithPending`,
  `announcePending`; `onAwaiting` keeps working from inside the drawer.
- `packages/broapp/src/ai/shared/contract.ts` — the message cap is
  20,000 characters; the counter shows it.
- `tests/ai-elements-view.test.tsx`, `tests/ai-elements-css.test.ts`.

## Step 1 — the scheme follows the page

In `tailwind.css`, delete the `@media (prefers-color-scheme: dark)` block
for colours (keep the reduced-motion one). Every literal fallback becomes a
`light-dark(<light>, <dark>)` pair using the same values the two blocks
hold today, for example:

```css
--background: var(--bg, light-dark(#ffffff, #16171a));
--foreground: var(--text, light-dark(#1a1a1a, #eceef1));
```

`light-dark()` resolves against the element's own `color-scheme`, which
inherits from the page. A page that declares nothing is light; a page
that declares `color-scheme: light dark` on `:root` follows the OS; a page
that forces `dark` is dark. The panel never decides on its own. Set
nothing on `.broapp-chat` for `color-scheme`; inheritance is the point.
Add a comment saying so, and that this is what makes the panel match the
launcher and the notes example alike.

`tests/ai-elements-css.test.ts`: the committed stylesheet contains
`light-dark(` and no `prefers-color-scheme` (the reduced-motion query is
still there, so assert on `prefers-color-scheme` specifically).

## Step 2 — form controls inherit

In the `@layer base` block, after the token mapping:

```css
.broapp-chat :where(input, textarea, select, button) {
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  background-color: transparent;
  border-radius: 0;
}
.broapp-chat :where(input, textarea)::placeholder {
  color: var(--muted-foreground);
  opacity: 1;
}
.broapp-chat :where(button) { cursor: pointer; }
```

This is the part of Tailwind's preflight the panel actually needs, at
`:where()` specificity so the vendored utility classes still win. Check
every vendored component that styles a control (`input-group`, `button`,
`select`, `textarea`) still looks right after this; adjust nothing in
them unless a class was relying on the browser default.

## Step 3 — `BroappChatDrawer` and `BroappChatToggle`

`src/ui/BroappChatDrawer.tsx`:

```tsx
export interface BroappChatDrawerProps extends BroappChatProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** Header text. Default "Chat". */
  readonly title?: string;
  /** One paragraph under the title, e.g. what the assistant can do. */
  readonly description?: string;
  /** Shown while the transcript is empty; clicking one sends it. */
  readonly suggestions?: readonly string[];
  /** Key that toggles the drawer with ⌘ on macOS, Ctrl elsewhere. Default "i". Set null to disable. */
  readonly shortcutKey?: string | null;
  /** CSS width. Default "26rem"; full width under 40rem viewports. */
  readonly width?: string;
  /** Characters allowed in one message. Default 20000 — the contract's cap. */
  readonly maxLength?: number;
}
export function BroappChatDrawer(props: BroappChatDrawerProps): React.ReactElement;

export function BroappChatToggle(props: { open: boolean; onToggle(): void; label?: string; shortcutKey?: string | null }): React.ReactElement;
```

Behaviour:

- A `<aside role="complementary" aria-label={title}>` fixed to the right
  edge, full height, `width`, above the page (`z-index` high, a left
  hairline in `--border-color`), background `--background`. Translate-in
  from the right over 150 ms; none under reduced motion. When closed the
  aside is not rendered (not merely hidden), so its chat state must live
  in the parent: `BroappChatDrawer` therefore renders `BroappChat`
  **always** and only toggles the aside's visibility with a class, so a
  running turn survives a close. Choose: render always, hide with
  `hidden` when closed, keep hooks mounted. Say so in a comment.
- Header row: title (an `<h2>`), then three icon buttons with `aria-label`
  and a `title`: "Copy transcript" (`navigator.clipboard.writeText` of the
  transcript as plain text: `You: …` / `Assistant: …` lines, tool cards as
  `Used <tool>`), "Clear conversation" (the hook's `clear()`), "Close".
  Icons from `lucide-react` (`Copy`, `Trash2`, `ChevronRight`).
- `description` under the header in muted text.
- When the transcript is empty and `suggestions` is non-empty: a list of
  link-styled buttons in `--primary`; clicking one calls `sendMessage`
  with that text. A tip line under them: "Tip: you can open and close
  chat with ⌘ I" (or Ctrl on non-Mac; detect with
  `navigator.platform`/`userAgentData` at render, default ⌘). Omit the
  tip when `shortcutKey` is null.
- The counter "n / maxLength" right-aligned under the textarea, in muted
  text, turning `--destructive` at the cap. `BroappChatView` needs the
  count: give `PromptInputTextarea` an `onChange` (it accepts textarea
  props) and hold the count in view state; add `maxLength` to the
  textarea so the browser enforces it. Reset to 0 after a send.
- Keyboard: `⌘/Ctrl + shortcutKey` toggles from anywhere on the page
  (`keydown` on `window`, ignoring repeats); `Escape` inside the drawer
  closes it. On open, focus the textarea; on close, return focus to
  whatever had it before opening (store `document.activeElement`).
- No scroll lock on the body, no backdrop: the person can keep using the
  page beside it, which is the launcher's whole point.
- Under 40rem viewport width: `width: 100%`.

`BroappChatToggle`: a button "Ask AI" (or `label`) with a small
`MessageSquare` icon and the shortcut in a `<kbd>` when set;
`aria-expanded={open}`.

Styles for both go in `tailwind.css` `@layer components` under
`.broapp-chat-drawer*` / `.broapp-chat-toggle` (plain CSS with the tokens
— these are not vendored, so no utility classes are needed). Export both
from `src/ui/index.tsx`.

## Step 4 — the launcher

`App.tsx`: remove the `<aside className="launcher__aside">` block. Add
`BroappChatToggle` to `launcher__header-actions` and render
`BroappChatDrawer` after `</main>` with:
`title="Engineer"`, the existing lede sentence as `description`,
`suggestions={['What applications do I have?', 'Add a field to notes', 'Show me the last run']}`
(pick three that the engineer's tools can actually answer — read
`packages/broapp-autoapp/src/launcher/instructions.ts` for what it can
do), `refs`, `onAwaiting`, `onToolResult` unchanged, `open`/`onOpenChange`
from a `useState(false)`. Persist the open state in `localStorage` under
`broapp-autoapp:engineer-open`, wrapped in try/catch, so a reload keeps
the drawer where it was.

`launcher.css`: the grid becomes a single column (`'header' 'main'`),
the `launcher__aside*` rules go, and `:root` gains the panel's variables
as aliases of the launcher's own, so the drawer takes the launcher's
palette rather than its fallbacks:

```css
--bg: var(--launcher-ground);
--surface: var(--launcher-surface);
--border: var(--launcher-border);
--text: var(--launcher-text);
--text-muted: var(--launcher-muted);
--accent: var(--launcher-accent);
--accent-contrast: #ffffff;
--bad: var(--launcher-error-text);
```

Do **not** add a dark scheme to the launcher in this prompt; it is light
today and stays light. The point of step 1 is that the panel agrees.

`main.tsx`: unchanged unless an import moves.

`bun run --cwd packages/broapp-autoapp build:page` exit 0.

## Step 5 — tests

`tests/ai-elements-view.test.tsx` (renderToString):

- Drawer closed: the aside carries `hidden`; open: it does not, and the
  header has the three buttons by `aria-label`.
- Empty transcript with suggestions renders each as a `<button>` and the
  tip mentions `⌘` when `shortcutKey` is `'i'`; no tip when `null`.
- Counter renders `0 / 20000` by default and `0 / 1000` with
  `maxLength={1000}`.
- Toggle renders `aria-expanded="true"` when open and the `<kbd>`.

`tests/ai-elements-css.test.ts`: step 1 assertion, plus the committed CSS
contains `.broapp-chat :where(input, textarea, select, button)` (or the
exact selector you wrote) and `.broapp-chat-drawer`.

`tests/ai-elements-source.test.ts` passes (headers, no aliases, no
forbidden APIs).

## Manual run

Launcher from `packages/broapp-autoapp` (`bun run dev` or the compiled
launcher; say which). macOS in **dark** mode for rows 1–3.

| # | Step | Expected |
|---|---|---|
| 1 | Open the launcher | Page light, no drawer; "Ask AI ⌘I" in the header |
| 2 | Press ⌘I | Drawer slides in from the right, **light**, matching the page; textarea focused |
| 3 | Type | Text clearly visible; placeholder muted; counter counts |
| 4 | Click a suggestion | It sends; the reply streams; suggestions gone |
| 5 | Press Escape | Drawer closes; focus back on the toggle |
| 6 | Reload | Drawer state remembered |
| 7 | Copy transcript | Clipboard has `You:` / `Assistant:` lines |
| 8 | Clear | Transcript empty; suggestions back |
| 9 | Narrow the window under 40rem | Drawer full width |
| 10 | Notes example (`examples/notes`, still inline) in dark OS | Panel follows the notes page's own scheme (it declares `prefers-color-scheme` styles itself — confirm it still reads right both ways) |

## Verify

```bash
cd packages/broapp-ai-elements && bun run build:css && cd ../..
bun run typecheck
bun test tests/ai-elements-view.test.tsx tests/ai-elements-css.test.ts tests/ai-elements-source.test.ts
bun run --cwd packages/broapp-autoapp build:page
bun run check
```

## Report

`prompts/ai-elements/reports/04d-drawer.md`: the manual table; the
`light-dark()` browser floor you accepted and where it is written down
(`docs/ai.md` limitations gets one line); how the notes example's dark
styles interact with step 1.

Commit:

```
Open the chat as a drawer, follow the page's colour scheme, and let form controls inherit
```
