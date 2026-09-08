# 07c — The rail's scheme switch, and the prompt bar that falls off the page

## Why

Two layout defects in the workspace, seen at a 2000×1024 window in dark
mode:

1. **The scheme switch is crushed at the bottom-left.** `BroappSchemeToggle`
   is a horizontal `inline-flex` of three `1.5rem` buttons plus padding and
   border — about `5rem` — inside a `3rem` rail. It also styles itself with
   `--border-color`, `--secondary`, `--muted-foreground`, `--radius`,
   which are defined **only under `.broapp-chat`**; the rail is outside that
   scope, so the switch has no border, no ground and no colour.
2. **The prompt bar is below the fold.** The usage line sits at the bottom
   of the viewport and only the top edge of the input shows. The transcript
   grew the chat column instead of scrolling inside it. On paper the chain
   is right (`.launcher` grid `height: 100vh; overflow: hidden` →
   `.launcher__chat` flex column `min-height: 0` → `.broapp-chat` flex
   column `flex: 1 1 auto; min-height: 0` → `Conversation`
   `flex-1 overflow-y-hidden`), so something in it is not doing what it
   says. Measure, do not guess.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 07, 07b.
- `packages/broapp-ai-elements/src/ui/tailwind.css` — the token block
  (`.broapp-chat { --background: … }`), `.broapp-chat-scheme*`,
  `.broapp-chat__topbar`, `.broapp-chat__form`, `.broapp-chat__usage`.
- `packages/broapp-ai-elements/src/ui/{BroappChat,BroappChatView,BroappSchemeToggle}.tsx`.
- `packages/broapp-ai-elements/src/ui/components/ai-elements/conversation.tsx`
  and `node_modules/use-stick-to-bottom/dist/index.d.ts` + its README —
  what element `StickToBottom` renders, what inline styles it sets, and
  what it requires of its parent's height.
- `packages/broapp-autoapp/src/launcher/ui/{App.tsx,launcher.css}` — the
  rail (`launcher__rail`, `launcher__rail-spacer`), `.launcher__chat`, the
  grid, `body`, and the root element `main.tsx` mounts into
  (`index.html`).

Allowed files: `packages/broapp-ai-elements/src/ui/**`,
`packages/broapp-autoapp/src/launcher/ui/**`, tests, docs.

## Step 1 — tokens have a scope that is not a layout

Split the `.broapp-chat` rule in `tailwind.css` into two:

- `:where(.broapp-chat, .broapp-tokens)` carries **only the custom
  properties** (all three scheme states, same selectors as 07b).
- `.broapp-chat` keeps `color`, `background`, and whatever layout it has.

`.broapp-tokens` is documented in `docs/ai.md` as "wrap a component from
`broapp-ai-elements/ui` in this when it is rendered outside the chat
panel". No visual change for anything already inside `.broapp-chat`.

## Step 2 — the switch fits a rail

`BroappSchemeToggle` gains `orientation?: 'horizontal' | 'vertical'`
(default horizontal) rendered as `data-orientation` on the group;
`.broapp-chat-scheme[data-orientation="vertical"] { flex-direction: column }`.
The launcher's rail wraps it: `<div className="broapp-tokens launcher__rail-scheme"><BroappSchemeToggle orientation="vertical" … /></div>`,
and `.launcher__rail-scheme` only positions it (margin-bottom, centred).
Buttons stay `1.5rem`; the rail stays `3rem`.

`tests/ai-elements-view.test.tsx`: the vertical toggle renders
`data-orientation="vertical"`; the default renders none.

## Step 3 — measure the prompt bar, then fix the cause

Build the launcher page (`bun run --cwd packages/broapp-autoapp build:page`),
run the launcher, open it at a **1024 px tall** window with a transcript
long enough to overflow (send "explain the notes app in detail" twice),
then in the page evaluate and paste into the report:

```js
[ '.launcher', '.launcher__chat', '.launcher__chat > .broapp-chat',
  '.launcher__chat .broapp-chat__topbar', '.launcher__chat [class*="overflow-y-hidden"]',
  '.launcher__chat .broapp-chat__usage', '.launcher__chat .broapp-chat__form', 'body', 'html' ]
  .map(s => { const e = document.querySelector(s); if (!e) return s + ': missing';
    const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    return `${s}: top=${r.top|0} h=${r.height|0} minH=${c.minHeight} flex=${c.flex} overflowY=${c.overflowY} display=${c.display}`; })
```

Also report `innerHeight`, and whether `#root` (or whatever `main.tsx`
mounts into) has a height or padding of its own, and whether `html`/`body`
scroll (`document.documentElement.scrollHeight > innerHeight`).

Then fix **the** cause you measured. Likely candidates, in order of my
suspicion — confirm or rule each out in the report:

- `StickToBottom` renders a root whose height is content-driven and an
  inner scroller that needs the root to be a definite height; in a flex
  parent that means the root needs `min-height: 0` *and* the inner
  scroller `height: 100%` (or `absolute inset-0`). Check what the library
  actually renders.
- A wrapper between `.launcher__chat` and `.broapp-chat` (`Frame`,
  the root element, a `<div>` from `BroappChat`) that is not a flex
  column with `min-height: 0`, so the chain breaks there.
- `#root` or `body` adding height above `100vh` so the grid is clipped
  from the bottom by exactly that amount (the screenshot loses roughly
  one prompt bar's worth).

Whatever it is, the fix is a rule in `tailwind.css` (if the panel is at
fault, so every embedder benefits) or in `launcher.css` (if the shell
is). No `!important`. Add one defensive rule either way, with a comment
naming this prompt:
`.broapp-chat > * { min-height: 0; }` is **not** acceptable as the whole
fix — it hides the cause — but is acceptable in addition, if a measured
element needed it.

While there: the usage line and the error line render **between** the
transcript and the input; keep them there but give the pair a fixed
`flex: 0 0 auto`, so they cannot be the thing that shrinks.

## Step 4 — the drawer and the notes example

`BroappChatDrawer` and the notes example embed the same view. Re-run the
measurement in each (`bun run dev` in `examples/notes`, a long
transcript) and confirm the prompt bar stays visible in a 700 px tall
window. Fix in the same place if not.

## Manual run

| # | Step | Expected |
|---|---|---|
| 1 | Launcher at 1024 px tall, long transcript | Prompt bar fully visible; transcript scrolls inside; usage line above the bar |
| 2 | Same at 700 px tall | Same |
| 3 | Rail bottom-left | Three stacked icons in a bordered pill, current one highlighted, fits the rail in light and dark |
| 4 | Click each scheme button | Switches; pill colours follow |
| 5 | Notes example, long transcript, 700 px | Prompt bar visible |
| 6 | 04d drawer (any page still using it, or a quick local story) | Prompt bar visible |

## Verify

```bash
cd packages/broapp-ai-elements && bun run build:css && cd ../..
bun run typecheck
bun test tests/ai-elements-view.test.tsx tests/ai-elements-css.test.ts tests/ai-elements-source.test.ts
bun run --cwd packages/broapp-autoapp build:page
bun run check
```

## Report

`prompts/ai-elements/reports/07c-rail-input.md`: the measurement dump
before and after; which candidate it was; the rule that fixed it and
where it lives.

Commit:

```
Stack the scheme switch in the rail and keep the prompt bar on the page
```
