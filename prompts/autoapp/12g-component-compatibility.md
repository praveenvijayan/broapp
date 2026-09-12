# 12g — One palette, three vocabularies: the adapter, the harness, and the authoring gate

## Goal

Three styling vocabularies share Autoapp's pages. The renderer draws its six kinds
from `--autoapp-*` tokens (12f). The AI panel, vendored shadcn source on Radix, reads
seven application variables — `--bg`, `--surface`, `--border`, `--text`,
`--text-muted`, `--accent`, `--accent-contrast` — and maps them onto shadcn's names in
`src/ui/tailwind.css`. The launcher tab feeds those seven from `--launcher-*`. The
starter feeds `--autoapp-*` from those same seven, by hand, in its `styles.css`. Notes
has all of it on one page. Nothing has ever checked, in a compiled page, that a select
opened from the panel and a button drawn by the renderer show the same theme, or what
happens to either when an application overrides a token.

After this prompt: the renderer's colour tokens read the seven application variables
by meaning, generated from the token table, so an application sets its palette once
and the renderer and the panel follow; five type tokens the renderer lacked exist,
with today's values; a headless browser harness opens the compiled page, drives one
ordinary control and one portalled component under three themes and three schemes,
and reads computed styles — the first rendered check, and the harness the backlog's
rendered-acceptance row has been waiting for; the `theme` reference topic says how a
style guide becomes a theme and what it cannot become; and the component strategy is
a document plus a gate in the common rules, so any model adding a kind or a
framework component follows one path.

No component library migration. No Tailwind in the renderer. No new renderer kind.
The renderer's CSS implementation is preserved; only its token defaults change how
they are derived.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report so far, 12f's with care.
- `packages/broapp-autoapp/src/react/theme.ts`, `tokens.css`, `view.css`,
  `scripts/build-tokens.ts`, `presets/*.css`, `tests/autoapp-theme.test.ts`.
- `packages/broapp-ai-elements/src/ui/tailwind.css` — the seven variables, the shadcn
  mapping, the `.broapp-tokens` scope, the scheme selectors. `scripts/build-css.ts`,
  `tests/ai-elements-css.test.ts`.
- `packages/broapp-autoapp/src/launcher/ui/launcher.css` (`:root` block feeding the
  seven from `--launcher-*`).
- `templates/autoapp-starter/src/ui/styles.css`, `examples/notes/src/ui/styles.css`
  and both `main.tsx` files.
- `packages/broapp/src/cli/build-page.ts` — the CSP (`style-src` one hash,
  `font-src 'self' data:`).
- `packages/broapp-ai-elements/src/ui/components/ui/select.tsx` (or whichever file
  holds the vendored Select) — the portal.
- `packages/broapp-autoapp/src/engineer/reference.ts` (`theme` topic).
- `docs/autoapp/design.md` ("The theme contract"), `docs/autoapp/backlog.md`
  (rendered checks, third-party verification rows).
- `tests/autoapp-launcher.ts` (`ensureLauncher`), `scripts/autoapp-smoke.ts` — how a
  script drives the compiled binary.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| The application interface is the seven variables | `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-contrast`, on the application's `:root`, both schemes. Already what the panel reads and the launcher feeds. Nothing is renamed. |
| The renderer derives from it, by meaning | Every colour token in `AUTOAPP_TOKENS` gains `reads?: string`, the application variable it follows. Generated `tokens.css` writes `--autoapp-surface: var(--surface, <default>)` and so on. Mapping is by role: `ground`→`--bg`, `surface`→`--surface`, `border`→`--border`, `heading` and `text`→`--text`, `text-muted` and `muted`→`--text-muted`, `accent`→`--accent`, `accent-text` (new)→`--accent-contrast`, `input`→`--surface`. Tokens with no application-level meaning (notice, warning, error, code surfaces, button hover) read nothing and keep their defaults. The table's `reads` is the documented mapping; there is no second copy. |
| Precedence, written down | Defaults on `:where(:root)`; the seven on the application's `:root` reach the renderer through `reads`; a token set directly on `:root` wins over its `reads`; the panel's `.broapp-tokens` scope wins inside the panel and inside anything it portals. An application that wants the renderer and the panel to differ sets `--autoapp-*` explicitly. |
| Five type tokens | `font-sans`, `font-mono`, `weight-regular`, `weight-strong`, `tracking-caps`, defaults equal to what `view.css` uses today (the system stacks it inherits, 400, the 600/650 it sets — keep both weights if both are used, as two tokens, rather than change one), the literal weights and the one `letter-spacing` moved onto them. The no-literal test extends to `font-weight`, `letter-spacing` and `font-family`. |
| One ordinary control, one portalled component | The renderer's `button` and the panel's Select. Nothing else is measured in this prompt; the harness is built to take more later. |
| Themes and schemes | The starter's palette, the `quiet` preset, and a hand-written override that sets `--autoapp-accent` directly to a value different from `--accent`. Each under light, dark and system (system = no `color-scheme` forced, the browser emulating each). Nine combinations, each with the Select opened so its portal is exercised. |
| The harness | Playwright's Chromium, as a **root devDependency only**, never a dependency of any package, never in a binary. `bun run theme-check` builds Notes' page with the real build, serves it from a local file the way the launcher would (no bridge needed for styles), opens it headless, and writes `.broapp-tmp/theme-check.json` and `.md`: for each combination the computed `background-color`, `color`, `border-color`, `border-radius`, `font-family` of the button and of the opened Select's content, whether the Select's content is inside a `.broapp-tokens` ancestor, and the contrast ratio of each text/background pair. A test in `tests/autoapp-theme-browser.test.ts` runs it under `describe.skipIf` when Chromium is not installed, and CI installs it in one job only (`ci.yml`, a new `theme` job on `ubuntu-latest`, cached). |
| What passes | For each combination: the button's colours equal the theme's resolved values; the Select content's colours equal the panel's mapping of the same seven variables; the override reaches the button and not the panel; every text/background pair meets 4.5:1; no computed value is the fallback literal when the theme set the variable. A failure is a named combination and property, not a screenshot. |
| Fonts | `font-src 'self' data:` stands. A theme names a face the page ships as `data:` or falls back to its substitute; the harness reports the computed family so a fallback is visible. No CDN, no change. |
| The document | `docs/autoapp/components.md`: the strategy in this session's words — three layers and one theme, two audiences and two instructions, how it grows and how it is proved. Precedence and the scope rules from this table. Under a page-size line. |
| The gate | `00-common-rules.md` gains a section "Adding a component", the authoring checklist: where it lives and what it may import; typed props and controlled state; keyboard, focus and accessibility; loading, empty, error and disabled states where they apply; stable ids and renderer registration for a kind; `cva`, `cn()` and Radix where they earn their place and nowhere else; upstream provenance and an update owner for vendored source, licence kept; tokens only, no literal; the reference topic; the gallery; the harness combination it adds; tests. Every later prompt inherits it. |
| The engineer's instruction | Unchanged. The `theme` topic gains "Applying a style guide": map by role, not by name; the seven variables first, then any token the guide's radii, spacing and type scale set; what a guide cannot become (marketing-page components, faces the page does not ship) is said back to the person; a light-only guide sets `color-scheme: light`. With the mapping table from the review as its worked example. |
| Not in scope | Cross-page theme sync; a Lessons or theme UI; new kinds; the painting requirement; Tailwind in the renderer; any second styling vocabulary. |

## Step 1 — the adapter in the table

`theme.ts`: `ThemeToken.reads?: string` and the new `accent-text` colour token
(default: the accent's contrast, white on the light default, the dark scheme's
matching value). `tokensCss()` emits `var(--<reads>, <default>)` for a token with
`reads`, and the plain default otherwise. Rebuild `tokens.css`. The starter's
`styles.css` drops its explicit `--autoapp-*` lines that now follow through `reads`
and keeps any it sets differently on purpose (say which in a comment). Notes the same.
The presets are rewritten to set the seven first and then only the tokens that differ.

Tests (extend `autoapp-theme.test.ts`): every colour token with `reads` names one of
the seven; `tokens.css` carries the `var(--x, default)` form for exactly those; a
stylesheet setting only the seven changes the renderer's computed defaults in the
gallery's server-rendered CSS (string-level: the generated rule reads the variable).

## Step 2 — the type tokens

As decided. The gallery shows the same page after the change; the report carries the
gallery's byte-for-byte diff (should be none) and the token count.

## Step 3 — the harness

`scripts/theme-check.ts` and `tests/autoapp-theme-browser.test.ts`. Playwright in the
root `devDependencies`, pinned; `bun x playwright install chromium` documented in
`docs/development.md` and run in the new CI job. The script:

1. Builds Notes' page (`buildPage` as `build-page.ts` exposes it) three times, once
   per theme, writing each to `.broapp-tmp/theme-check/<theme>.html`.
2. For each theme × scheme: `page.emulateMedia({ colorScheme })` for light and dark,
   nothing for system; open the file; wait for fonts; read the computed styles of the
   first `.autoapp-button`; open the panel's Select by clicking its trigger; read the
   computed styles of the content and whether it sits under `.broapp-tokens`; compute
   contrast with the WCAG formula, no library.
3. Writes the JSON and a Markdown table; exits non-zero on any failing rule.

The test runs the script's function in-process and asserts the rules; `skipIf` when
`playwright` cannot launch. CI: a `theme` job that installs Chromium and runs the one
test; the other jobs unchanged.

## Step 4 — the reference, the document, the gate

`reference.ts`: the `theme` topic's precedence paragraph grows the scope rules and
`reads`; the "Applying a style guide" section as decided, with the worked mapping
table (canvas → `--bg`, card → `--surface`, hairline → `--border`, primary text →
`--text`, secondary → `--text-muted`, signature colour → `--accent`, its readable
foreground → `--accent-contrast`; radii → `radius-*`; base unit and gaps → `space-*`;
sizes → `font-size-*`; faces → `font-sans`/`font-mono` only if shipped).
`docs/autoapp/components.md` and the "Adding a component" section in
`00-common-rules.md` as decided. `docs/autoapp/design.md` points at both.
`docs/autoapp/backlog.md`: the rendered-checks row and the third-party verification
row both now point at the harness as landed, with what it covers (one button, one
select) and what it does not yet.

## Verification

```bash
bun run typecheck
bun run --cwd packages/broapp-autoapp build:tokens
bun test tests/autoapp-theme.test.ts tests/autoapp-verify.test.ts
bun x playwright install chromium
bun run theme-check
bun test tests/autoapp-theme-browser.test.ts
bun run --cwd packages/broapp-autoapp theme-gallery
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

Tests beyond the ones named above: the seven variables set on `:root` in a test
stylesheet change every token that `reads` them and no other; a token set directly
wins over its `reads`; the no-literal test covers weights, tracking and families; the
`theme` topic names `reads` for every token that has one and carries the style-guide
section; `00-common-rules.md` contains the "Adding a component" heading and every
checklist item named in the decisions table (a test reads the file).

## Acceptance criteria

- An application that sets the seven variables and nothing else themes the renderer
  and the panel alike, proven by computed styles in a compiled page under three
  themes and three schemes, with the Select's portal open.
- A token set directly on the application root overrides its `reads`, and reaches the
  renderer without reaching the panel.
- Every text/background pair the harness measures meets 4.5:1 under every combination,
  or the report names the pair and the theme.
- The renderer has no literal weight, tracking or family left; the gallery is
  unchanged byte for byte.
- The strategy is a document, the authoring checklist is in the common rules, and the
  `theme` topic tells the engineer how a style guide becomes a theme.
- `bun run check` is green; every command above exits 0; CI's new job is green.

## Report

`prompts/autoapp/reports/12g-component-compatibility.md`. Include: the `reads`
mapping as landed; the harness table for all nine combinations with the measured
values; every contrast pair that failed and what was changed; how long Chromium
install and the check take in CI; the gallery diff; and what the harness does not
yet cover.

## Commit

```
Let one palette reach the renderer and the panel, and prove it in a compiled page

The renderer's colour tokens now read the seven application variables the
AI panel already reads, by meaning, generated from the token table. A
headless browser opens the compiled page under three themes and three
schemes, opens the panel's select, and reads computed styles and contrast:
the first rendered check. Five type tokens replace the last literals. The
theme topic says how a style guide becomes a theme; the component strategy
is a document and an authoring gate in the common rules.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
