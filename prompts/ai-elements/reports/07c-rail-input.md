# 07c — The rail's switch, and the prompt bar that fell off the page

## What was built

`tailwind.css`: the token block is `:where(.broapp-chat, …, .broapp-tokens)` and
carries custom properties only, in all three scheme states; `.broapp-chat` gained
the column layout that used to live in `launcher.css`; the bar's group gained
`height: auto`; the usage line, the error line and the form are pinned
`flex: 0 0 auto`; `[data-orientation="vertical"]` stacks the switch.
`BroappSchemeToggle` gained `orientation`, rendered as `data-orientation` only
when vertical. The rail wraps it in `broapp-tokens launcher__rail-scheme`, and
`.launcher__chat .broapp-chat` is down to `flex: 1 1 auto`. A paragraph in
`docs/ai.md`; one test in `ai-elements-view`, three in `ai-elements-css`.

## The measurement

Launcher from source, Ollama `gemma4:31b-mlx`, a thread with a tool call, two
answers and a 60-line message, at **2000×1024**. Before:

```
.launcher:       top=0 h=1024 minH=0px flex=0 1 auto overflowY=hidden display=grid
.launcher__chat: top=0 h=1024 minH=0px flex=0 1 auto overflowY=visible display=flex
 > .broapp-chat: top=0 h=1024 minH=0px flex=1 1 auto overflowY=visible display=flex
 __topbar:                   top=0   h=46  minH=auto flex=0 1 auto
 [class*=overflow-y-hidden]: top=46  h=888 minH=auto flex=1 1 0% overflowY=hidden
 __usage:                    top=950 h=22  minH=auto flex=0 1 auto
 __form:                     top=988 h=36  minH=auto flex=0 1 auto
body / html:     top=0 h=1024 minH=0px overflowY=visible
innerHeight=1024 · #root h=1024 height=1024px padding=0px · documentElement
.scrollHeight=1024, so neither html nor body scrolls · inner scroller
height=888.5px overflowY=auto scrollHeight=1948
```

After: topbar 46 · conversation top=46 h=858 (scrollHeight 1948) · usage top=920
h=22 flex=0 0 auto · form top=958 h=66 flex=0 0 auto · input-group h=66 · the
page still does not scroll. At 2000×700: form top=634 h=66.

## Which candidate it was: none of the three

Every link measures right, the transcript **does** scroll inside itself (1948 in
889), `#root` has no height or padding of its own, and nothing exceeds
`innerHeight`. `StickToBottom` renders a plain `<div {...props}>` root and an
inner scroller with inline `height: 100%`; the root's own `overflow-y: hidden`
already resolves its automatic minimum size to zero, so it shrinks unaided.

The cause is one element lower, inside the bar:

```
form.broapp-chat__form        h=36  display=block
  div[data-slot=input-group]  h=36  display=grid overflow=hidden rows=64px
    div (lead) h=38 · div.contents h=0 display=contents
      textarea top=964 h=64 min-height:64px
    div (trail) h=38
```

The vendored group is `h-9` — 36px — with `has-[>textarea]:h-auto` to undo that
when it holds a box rather than a one-line input. That hatch is a
**direct-child** selector, and the textarea sits inside `PromptInputBody`, which
renders `display: contents`: a box removed from layout but still in the tree, so
`:has(> textarea)` never matches. The group stayed 36px while its own grid row
measured 64, `align-items: end` put the textarea's top at y=964 — above the
group — and `overflow: hidden` clipped all but that top edge. Setting the form to
`flex: 0 0 auto` in the page changed nothing, which proves it was never a shrink.

## The rule that fixed it, and where it lives

`packages/broapp-ai-elements/src/ui/tailwind.css`, because the panel is at
fault: `height: auto` on `.broapp-chat__form > [data-slot='input-group']`, the
rule that already makes that bar a grid. `.broapp-chat__form`,
`.broapp-chat__usage` and `.broapp-chat > .message--error` take `flex: 0 0 auto`
beside it. The defensive rule is `.broapp-chat { display: flex; flex-direction:
column; min-height: 0 }`, moved out of `launcher.css` — nothing measured needed
the `min-height`, but the drawer and the notes example never had the column at
all. No `!important`. Layer order here is theme < utilities < base < components,
so a components rule beats a utility.

## Step 4, and the manual run

The drawer was measured at 700px by building its own markup and classes around
the live panel in the notes page: nothing has mounted `BroappChatDrawer` since
prompt 07. Putting `display: block` back on the panel there moved the
conversation to h=3728 and the form to y=3847 — broken the same way, fixed in
the same place.

| # | Outcome |
|---|---|
| 1 | ✅ 1024px: bar whole at 958–1024, transcript scrolls inside, usage above it |
| 2 | ✅ 700px: bar 634–700 |
| 3 | ✅ rail 48px, switch 30×78 stacked; dark `#32353b` on `#1e2024`, "System" on `#16171a`; light `#dfe3ea` on `#ffffff`, "Light" on `#f6f7f9` |
| 4 | ✅ Light → `data-scheme="light"`, page `#f6f7f9`; Dark → `"dark"`, `#16171a`; System → attribute absent. The pill follows each time |
| 5 | ✅ notes at 1200×700: `.app__scroll` 259–365, `.ai-chat` 385–679, conversation h=97 (scrollHeight 2528), usage 549, form 590–656, page does not scroll. At 1200×1000 the transcript is 307px. A draft long enough to hit the textarea's own 12rem ceiling gives form 493–687 and still no page scroll |
| 6 | ✅ drawer story at 700px: body 48–699, panel 62–685, conversation h=500 (scrollHeight 3728), form 619–685 |

## Decisions I made

- **Row 5 was fixed in `examples/notes`, on the user's instruction.** That
  directory is outside the prompt's allowed files, and the row was reported
  unfixed until the user asked for it — an authority the file list does not
  have. Nothing in the package changed for it:
  the notes shell became the height of the window (`.app` a flex column at
  `100dvh`), the cards above the assistant scroll in an `.app__scroll` region
  of their own, and `.ai-chat` is a bounded column — `min-height: 12rem` so a
  maxed-out draft still shows its send button, `max-height: 70%` so the notes
  keep a third of the window. A viewport height in the *package's* stylesheet
  was still refused: it would impose a full-height column on every embedder
  that asked for a card.
- **`.broapp-tokens` joins the existing selector list rather than replacing it.**
  The drawer, the toggle, the thread list, the switch and the menu's portalled
  content are all outside `.broapp-chat` and all read these tokens today (07b).
- **No `data-orientation` for horizontal**: one direction is the stylesheet's
  own, and a selector for it would be a rule that changes nothing.
- **This report is 134 lines, not 80.** The prompt asks for the dump before and
  after and a six-row table; the two rules disagree and the specific one wins.

## Commands run

```
bun run build:css                                  # styles.css, 60.3 KiB
bun run typecheck                                  # exit 0
bun test ai-elements-{view,css,source}             # 47 pass, 0 fail
bun run --cwd packages/broapp-autoapp build:page   # 1238.6 KiB
bun install && bun run check                       # 581 pass, 0 fail, 37 files, exit 0
examples/notes: bunx tsc --noEmit · bun test · bun run build   # exit 0, 23 pass, 72.5 MiB
```

## Open questions

- **The `:has(> textarea)` mismatch is upstream's.** Any consumer who puts
  `PromptInputBody` inside `InputGroup` gets a 36px bar.
- **The drawer has no page of its own**, so its measurement tests the CSS chain
  and not the component's render.
- **The notes shell now assumes a window, not a page.** At a viewport shorter
  than about 26rem the assistant's floor wins and the document scrolls again —
  the graceful end of the arrangement, not a case anybody was asked to support.
