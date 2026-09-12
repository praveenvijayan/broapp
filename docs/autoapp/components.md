# Components

Three layers draw an Autoapp page, and one theme reaches all three. This is
what each layer is for, what may be added to it, and how anything added is
proved. The token table itself is in [design.md](design.md#the-theme-contract);
the authoring checklist a model follows is
["Adding a component"](../../prompts/autoapp/00-common-rules.md#2b-adding-a-component)
in the common rules.

## Three layers

**The renderer** — `broapp-autoapp/react`, drawing a declarative view
specification. Six kinds: page, section, text, table, form and button, plus the
strips the framework owns (approvals, runs, workflow drafts). Plain CSS in
`view.css`, one `.autoapp-` class per part, no Tailwind, no component library,
no generated browser code. It is pinned: an AI engineer reshapes an application
by proposing a different view specification, so the page's script hash does not
move and its policy stays pinned. Adding a kind here is a framework decision,
not an application's.

**The panel** — `broapp-ai-elements/ui`, the AI chat. Vendored shadcn/ui source
on Radix primitives, compiled Tailwind, scoped to `.broapp-chat` and its
neighbours. It is vendored rather than depended on because a page has one
stylesheet and one policy, and a registry that pulled its own assets could not
live inside either. Every vendored file names its upstream version in its first
line and marks local edits `LOCAL` / `END LOCAL`; a test holds both.

**The application** — its own `src/ui/`, which draws the frame around the
renderer and composes the panel. React, plain CSS, whatever it likes, as long as
the build's rules hold: no off-origin URL, one stylesheet, one script.

## One theme

The application's palette is seven properties on its own `:root`:

    --bg  --surface  --border  --text  --text-muted  --accent  --accent-contrast

The panel reads those seven and maps them onto shadcn's names in
`src/ui/tailwind.css`. Since prompt 12g every colour token the renderer reads
follows one of the same seven by meaning — `--autoapp-surface` is declared
`var(--surface, #ffffff)`, and so on — so an application sets its palette once
and both vocabularies take it. The `reads` column of `AUTOAPP_TOKENS` is the
mapping; there is no second copy of it anywhere.

Precedence, in the order it resolves:

1. The renderer's defaults are on `:where(:root)`, at zero specificity.
2. One of the seven, on the application's `:root`, reaches every token that
   follows it.
3. An `--autoapp-*` token set directly on `:root` beats what it would have
   followed. The panel never reads an `--autoapp-*` property, so an override is
   how an application makes the renderer and the panel differ on purpose.
4. `.broapp-tokens` carries the panel's mapping. The panel's own scopes include
   it, and **every portalled component carries it too**: a select's content, a
   dropdown menu, a tooltip, a hover card and a dialog are all rendered at the
   end of the document, outside the panel, and without that class every colour
   in them resolves to nothing. That was a real fault, found by the harness
   below on the day it was written, and it is now the rule.

A token whose meaning has no place in a palette — a notice, a warning, an
error, a code block's ground, a button's own grey — follows nothing and keeps
its default until an application sets it.

## Two audiences, two instructions

A person applying a brand's style guide and a model adding a component are
told different things in different places, and neither file repeats the other.

- The **engineer** reads `spec.reference` topic `theme`: the token list
  generated from the table, what each token follows, the precedence above, and
  "Applying a style guide" — map by role not by name, the seven first, and what
  a guide cannot become (a marketing component is not a kind; a face the page
  does not ship will not load; a light-only guide sets `color-scheme: light`).
- A **model or contributor** adding a component reads "Adding a component" in
  `prompts/autoapp/00-common-rules.md`: where it may live, what it may import,
  typed props and controlled state, keyboard and focus and accessibility, the
  states it has to draw, tokens only, and the four places it has to appear
  before it is done — the reference topic, the gallery, the harness, the tests.

## How it grows

- **A renderer kind** is added in `packages/broapp-autoapp`: the view schema,
  the renderer, `view.css` in tokens only, the `views` reference topic, the
  gallery, and a specification test. No new dependency; the renderer has none
  for drawing.
- **A panel component** is vendored from the registry with its version in the
  first line, or composed from what is already vendored. `cva` for a component
  with real variants, `cn()` for merging a caller's classes, a Radix primitive
  where focus management or a portal is the hard part — and none of the three
  anywhere else.
- **An application component** is the application's own, and the one place
  ordinary React and ordinary CSS need no justification.

Nothing crosses: the renderer does not import Tailwind, the panel does not read
`--autoapp-*`, and an application's stylesheet does not write rules for
`.autoapp-` or `.broapp-chat` classes.

## How it is proved

Text first, because it is cheap. `tests/autoapp-theme.test.ts` holds the table,
the generated stylesheet, the renderer's stylesheet, the starter, Notes, the
launcher and both presets to each other: no literal length, colour, weight,
tracking or family in `view.css`; every fallback the table's default; every
`reads` one of the seven.

Then a browser, because agreement between vocabularies cannot be read off a
string. `bun run theme-check` builds the page with the real build under three
themes — the starter's palette, the quiet preset, and a hand-written override —
opens each under light, dark and no-preference, opens the panel's select so its
portal is exercised, and reads computed styles: the colours, corner and family
of the renderer's button and of the select's content, whether the content still
sits in the panel's scope, and the contrast of every text/background pair
against 4.5:1. Nine combinations, one line per measurement in
`.broapp-tmp/theme-check.md`. A failure is a named combination and property, not
a screenshot. `tests/autoapp-theme-browser.test.ts` runs the same rules and
skips itself where Chromium is missing; CI installs Chromium in one job.

What it does not cover yet: one ordinary control and one portalled component,
both in a page built for the purpose. Not the approvals strip, not a table under
a long word, not a real bridge, not a screenshot anybody compares. Every new
component adds its combination, which is what makes that list shrink.
