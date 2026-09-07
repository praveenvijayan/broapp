# 07 — The launcher becomes a chat workspace

## Goal

The chat is the centre of the launcher, not a drawer beside it. Full
width. Left: a thin rail and the conversation list. Middle: the chat,
with a model picker and a menu in its top bar. Right: the application
panel (apps, candidate, releases) always visible. Settings: a drawer that
slides over the right side on demand. Nothing shifts when anything
opens; the drawer overlays. The layout the person sees first is chat +
applications, and only that.

The four screenshots that describe the target: a collapsible "History"
list with a rail (`+` new, clock for history, theme switch at the
bottom); a model combobox with search, icons, and a check on the current
one; a `…` menu with "Clear chat" and a destructive "Delete chat"; a
full-width prompt bar with an image button at the left and send at the
right.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–06.
- `packages/broapp-autoapp/src/launcher/ui/**` — every file. `App.tsx`
  composes `AppsTable`, `CandidatePanel`, `ReleasesPanel`, `AiSettings`,
  and since 04d `BroappChatDrawer` + `BroappChatToggle`;
  `launcher.css` holds the grid, the `--launcher-*` palette, and 04d's
  `.launcher--drawer-open` margin (that margin is the "layout jumping"
  the person saw; it goes).
- `packages/broapp-autoapp/src/react/index.tsx` — `titleWithPending`,
  `announcePending`, `browserSurface`.
- `packages/broapp-ai-elements/src/ui/{BroappChat,BroappChatView,BroappChatDrawer}.tsx`,
  `tailwind.css`, and the vendored `command.tsx`, `dropdown-menu.tsx`,
  `select.tsx` under `src/ui/components/ui/`.
- `packages/broapp/src/ai/react/{use-ai-models,use-ai-settings,AiSettings}.tsx`
  — read only; `useAiModels()` is what the model picker consumes.
- `packages/broapp-autoapp/src/launcher/instructions.ts` — what the
  engineer can do, for the suggestions.

Allowed files: everything under `packages/broapp-ai-elements/`, everything
under `packages/broapp-autoapp/src/launcher/ui/` (new files welcome),
`packages/broapp-autoapp/src/react/index.tsx` only if `titleWithPending`
needs a tweak, docs, tests. Nothing else under `launcher/`.

## Step 1 — reusable pieces in `broapp-ai-elements/ui`

Each is a plain component with props; none reads the launcher.

### `BroappModelPicker`

```tsx
export interface BroappModelPickerProps {
  readonly value: string | null;          // null = "Default (Settings)"
  onChange(modelId: string | null): void;
  readonly disabled?: boolean;
}
```

A button showing the current model's label (or "Default · ‹settings
model›") that opens the vendored `Command` popover: a search box, the
list from `useAiModels()` (import from `broapp/ai/react`), each row with
a small provider mark (first letter of `provider` in a rounded square —
no icon downloads), the label, a `vision` badge when
`capabilities.vision`, and a check on the current one. First row is
"Default (follow Settings)". Disabled with a tooltip "Choose a provider in
Settings" when `settings.configured` is false. Loading and error states
from the hook.

### `BroappChatMenu`

`…` button opening the vendored `DropdownMenu`: "Copy transcript",
"Clear chat" (keeps the thread, empties it), a separator, then
"Delete chat" in `--destructive` with a two-step confirm inside the menu
("Delete this conversation? · Delete / Cancel"), never a browser
`confirm()`. Props: the four callbacks.

### `BroappThreadList`

```tsx
export interface BroappThreadListProps {
  readonly threads: readonly AiThread[];
  readonly activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  readonly loading?: boolean;
  readonly emptyText?: string;
}
```

Title "History", a collapse button, rows grouped by day ("Today",
"Yesterday", "Earlier"), each with the title, the model id in muted
text when set, a hover `…` with Rename (inline `<input>`, Enter/Escape)
and Delete. Empty: `emptyText` (default "No conversations yet.").

### `BroappSchemeToggle`

Three segmented buttons: light / system / dark (`Sun`, `Monitor`, `Moon`
from lucide), `role="radiogroup"`. Props `value`, `onChange`. Applying it
is the caller's job (step 3) so the component stays pure.

### `BroappChatView` changes

- The prompt bar becomes one row: image button left, textarea in the
  middle, counter + send right — like the fourth screenshot. Reuse
  `PromptInputTools` / `PromptInputFooter` from the vendored input.
- `BroappChat` accepts `topBar?: React.ReactNode` rendered above the
  conversation, and `loading` from the hook (prompt 06) shows "Loading
  conversation…" instead of the empty state.

`BroappChatDrawer` and `BroappChatToggle` **stay** (another application
may want the drawer); the launcher just stops using them.

Export all of it from `src/ui/index.tsx`.

## Step 2 — the launcher layout

`launcher.css` becomes a full-width app shell:

```
grid-template-columns: 3rem auto minmax(0, 1fr) minmax(24rem, 30rem);
grid-template-areas: 'rail history chat apps';
height: 100vh; overflow: hidden;   /* each column scrolls itself */
```

- **rail** (`launcher__rail`): `+` (new thread), clock (toggle the history
  column), and at the bottom the `BroappSchemeToggle`. Icon buttons with
  `aria-label` and `title`.
- **history** (`launcher__history`): `BroappThreadList`; collapsed →
  `width: 0`, hidden, and the grid column is `0` — collapse changes the
  chat column only, which is the one that is meant to flex. Persist
  collapsed state in `localStorage`.
- **chat** (`launcher__chat`): `BroappChat` with `threadId` = the active
  thread and `modelId` from the thread, `topBar` = `[BroappModelPicker]
  … [image-of-app? no] [Settings (sliders icon)] [+ new] [BroappChatMenu]`,
  `refs`, `onAwaiting`, `onToolResult` as today, suggestions from 04d.
  The connection status pill moves here, small, at the right of the top
  bar.
- **apps** (`launcher__apps`): the header text ("Your applications", the
  lede) shrinks to a section title; `AppsTable`, `CandidatePanel`,
  `ReleasesPanel` stack and scroll. Always visible.
- **settings drawer** (`launcher__settings`): `position: fixed; right: 0;
  top: 0; height: 100vh; width: min(30rem, 100%)`, slides over the apps
  column with a translucent backdrop over the rest of the page, `Escape`
  and the backdrop close it, focus goes to its first control on open and
  returns on close. Contents: `AiSettings`, then a "Conversations" section
  with "Clear all conversations" (two-step, calls `useAiThreads().clearAll()`),
  then the data-directory line if the launcher shows one today. It is not
  rendered while closed. **Nothing in the grid changes when it opens.**
- Below 60rem: `apps` collapses under the chat (`'rail history chat' / 'rail history apps'`
  rows); below 40rem: rail + chat only, history and apps behind toggles.
  Say what you did for small widths in the report; the launcher is a
  desktop tool and a sane fallback is enough.
- Delete `.launcher--drawer-open`, `launcher__aside*`, `launcher__header*`
  rules that no longer apply.

Threads in the launcher (`useAiThreads` from prompt 06):

- On load, list threads; if none, create one and select it; else select
  the most recent. Persist the active id in `localStorage` and prefer it
  when it still exists.
- `+` creates "New conversation" with `modelId: null` and selects it.
- Model picker `onChange` → `setModel(activeId, modelId)`, so the choice
  sticks to the thread.
- Menu: copy / clear / delete; delete selects the next most recent or
  creates one.
- Tab title still gets `(n) ` from `onAwaiting`; a notification still
  fires where permitted.

## Step 3 — scheme

The launcher gets a dark palette and a switch:

- `launcher.css` `:root` tokens become `light-dark()` pairs (pick dark
  values that match the panel's fallbacks: ground `#16171a`, surface
  `#1e2024`, border `#32353b`, heading `#f2f3f5`, text `#eceef1`, muted
  `#a2a7b0`, accent `#6fd3b4`, error surface `#3a1e1b`, error text
  `#f08a76`), and `:root { color-scheme: light dark; }` so "system" works.
- The toggle writes `document.documentElement.style.colorScheme` to
  `light`, `dark`, or `''` (system) and persists the choice in
  `localStorage` under `broapp-autoapp:scheme`; `main.tsx` applies it
  before the first render so nothing flashes.
- The panel follows automatically (prompt 04d); confirm it does.

## Step 4 — tests

- `tests/ai-elements-view.test.tsx` (`renderToString`): `BroappModelPicker`
  closed shows the label and the `vision` badge count; `BroappThreadList`
  groups Today / Earlier and marks the active row (`aria-current="true"`);
  `BroappSchemeToggle` marks the checked radio; `BroappChatMenu` closed
  renders the trigger with `aria-haspopup`.
- `tests/ai-elements-css.test.ts`: the committed CSS contains the new
  component classes and still no `prefers-color-scheme`, `url(`, `@import`.
- `tests/autoapp-launcher*.test.ts` (whatever exists): if it renders
  `App` or checks the page, it still passes; if it greps the built page
  for `launcher__aside`, update it.
- `bun run --cwd packages/broapp-autoapp build:page` exit 0; the page has
  one `<style>` and one CSP meta.

## Manual run

Launcher compiled (`build:launcher`) or `bun run dev`; say which. Ollama
as before.

| # | Step | Expected |
|---|---|---|
| 1 | First open | Rail + History + chat + applications; no settings; no drawer; nothing jumps as data loads |
| 2 | Click clock | History collapses; chat widens; apps column unchanged |
| 3 | Open the model picker | Search box, models with a `vision` badge where Ollama reports it, check on the current, "Default" first |
| 4 | Pick a model, send a message, reload | Same thread, same model, transcript restored |
| 5 | `+` | New conversation, model "Default", picker enabled |
| 6 | Ask "What applications do I have?" | `apps.list` card, answer; History shows the derived title |
| 7 | Rename the thread from the list | Sticks after reload |
| 8 | Open Settings (sliders) | Drawer over the apps column with backdrop; grid did not move; Escape closes; focus returns |
| 9 | Change provider in the drawer | Picker refreshes its list |
| 10 | Menu → Clear chat | Empty transcript, thread kept, suggestions back |
| 11 | Menu → Delete chat, confirm inside the menu | Next thread selected, or a new one |
| 12 | Scheme toggle: dark | Whole launcher dark, panel dark, no flash on reload |
| 13 | Scheme toggle: system, macOS light ↔ dark | Follows |
| 14 | Paste a screenshot, send with a vision model | Works as in 04c |
| 15 | Ask for a change needing approval | Card counts down from ~10:00; tab title `(1) …`; History unaffected |
| 16 | Settings drawer → Clear all conversations, confirm | List empty, one fresh thread created |
| 17 | Narrow to 50rem, then 35rem | The fallbacks from step 2 |

## Verify

```bash
cd packages/broapp-ai-elements && bun run build:css && cd ../..
bun run typecheck
bun test tests/ai-elements-view.test.tsx tests/ai-elements-css.test.ts tests/ai-elements-source.test.ts
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
bun run dryrun:autoapp
```

## Report

`prompts/ai-elements/reports/07-workspace.md`: the manual table; the
small-width fallback; the page size before/after; anything `AiSettings`
needed that it did not offer (it may not be edited — say what you worked
around).

Commit:

```
Make the launcher a chat workspace: threads on the left, the application on the right, settings on demand
```
