# 12g — One palette, three vocabularies

## What was built

- `theme.ts`: `ThemeToken.reads?`, `APPLICATION_VARIABLES` (the seven), `declaredValue()`, the new
  `accent-text` token, six type tokens. 64 tokens (was 57). `tokens.css` regenerated: a token with
  `reads` is declared `var(--<reads>, <default>)` in both schemes.
- `view.css`: the last literals gone — two `font-family`, six `font-weight`, one `letter-spacing` —
  plus a family and a weight on `.autoapp` it previously only inherited.
- Starter: the seven (with `--accent-contrast`, which it lacked) and three `--autoapp-*` lines that
  differ on purpose; eight hand-written mapping lines deleted. Notes the same, six lines kept with
  their reasons. Both presets rewritten: the seven first, then only what differs.
- `scripts/theme-check.ts` + `scripts/theme-check/` (a page built by the real `buildPage`),
  `tests/autoapp-theme-browser.test.ts` (`skipIf` no Chromium), a `theme` job in `ci.yml` with a
  Chromium cache and the measurements uploaded, `bun run theme-check`, Playwright 1.63.0 pinned as a
  **root devDependency** only.
- `reference.ts`: `theme` gains "The palette, and what follows it", a four-rule "Which setting wins",
  and "Applying a style guide" (the role mapping and the three refusals); each token line says what it
  follows. `docs/autoapp/components.md`, "2b. Adding a component" in `00-common-rules.md`, pointers
  from `design.md`, the docs index and the site; both backlog rows rewritten.

## The `reads` mapping as landed

| token | follows | | token | follows |
|---|---|---|---|---|
| `heading`, `text` | `--text` | | `surface`, `input` | `--surface` |
| `text-muted`, `muted` | `--text-muted` | | `border` | `--border` |
| `accent` | `--accent` | | `accent-text` (new) | `--accent-contrast` |

Nothing reads `--bg`: the renderer paints no page ground, and the painting requirement is out of
scope. `button`, `button-hover`, `code-surface`, `notice-*`, `warning*`, `error*` and `focus-ring`
follow nothing — a palette has no word for them.

## The harness — nine combinations, 90 measurements, 2–6s

| theme | scheme | renderer card | panel select content | radius: button / select | worst contrast |
|---|---|---|---|---|---|
| starter | light, no-pref | `rgb(255,255,255)` | `rgb(255,255,255)` | 7px / 8px | 4.83:1 column header |
| starter | dark | `rgb(30,32,36)` | `rgb(30,32,36)` | 7px / 8px | 6.56:1 link |
| quiet | light, no-pref | `rgb(252,252,251)` | `rgb(252,252,251)` | 12px / 8px | 4.63:1 column header |
| quiet | dark | `rgb(33,35,39)` | `rgb(33,35,39)` | 12px / 8px | 5.91:1 column header |
| override | all three | as starter | as starter | 7px / 8px | as starter |

Full table in `.broapp-tmp/theme-check.md`. Override: renderer `--autoapp-accent` =
`rgb(138,29,110)` light / `rgb(255,158,222)` dark, panel `--primary` = `rgb(42,91,215)` /
`rgb(122,162,255)` — the token reaches the renderer and not the panel, in all three schemes. No
contrast pair failed, so nothing was changed for contrast; the two lowest are column headers
(`--text-muted`), and they pass.

## Two faults it found, both fixed

1. **Portalled content had no tokens.** A select's content, a dropdown menu, a tooltip, a hover card
   and a dialog render at the end of the document, outside `.broapp-chat`, so every shadcn colour in
   them resolved to nothing: the first run reported `background rgba(0, 0, 0, 0)` and "drawn outside
   the panel's token scope" in all nine combinations. Each portalled content now carries
   `.broapp-tokens` — five vendored files, marked `LOCAL` / `END LOCAL`.
2. **The panel's radius was a cycle.** `--radius: var(--radius, 8px)` refers to itself, which is
   invalid at computed-value time, so `--radius` inside the panel computed to nothing (measured:
   `getPropertyValue('--radius')` was `""`) and every `rounded-*` in it was 0 — in every application
   since that mapping shipped. Renamed `--radius-base`, the move `--border-color` and
   `--accent-surface` already make; `styles.css` rebuilt, one line changed. The select's corner is now
   judged, and is 8px.

Left open, recorded in the backlog: the panel's `border` utility draws in `currentColor`, because
preflight is off and nothing replaces the part of it that sets a default border colour, so a popover's
hairline is the text colour. Fixing that changes every border in the panel at once, which is its own
decision rather than a side effect of this prompt.

## Deviations and decisions

1. **The harness page is not Notes'.** Measured first: Notes' compiled page draws no
   `.autoapp-button` without a bridge (the renderer loads a view's sources in an effect), and the
   panel as Notes composes it has no portalled component at all — its prompt bar is a textarea and two
   buttons. So `scripts/theme-check/` is a page of its own: the same stylesheets in the same order,
   the renderer's components in a stub page context the way `theme-gallery.ts` draws them, and the
   vendored select inside `.broapp-chat`. The build, the bundler, the hashed policy and the portal are
   real.
2. **Six type tokens, not five.** `view.css` uses 600 *and* 650, and the table's rule is that an
   upgrade changes nothing, so `weight-heading` (650) joins `weight-strong` (600). `weight-regular` is
   400, the value `.autoapp` already computed to.
3. **`font-sans` defaults to `inherit`,** like `control-height: auto` in 12f. Measured subtlety, now a
   comment in the table: `inherit` in a custom property is the CSS-wide keyword, so the declaration
   computes to nothing on `:root` and the `var(…, inherit)` in `view.css` is what applies — exactly
   what the renderer inherited before.
4. **`accent-text` has no consumer yet.** Nothing the renderer draws puts text on the accent; the
   token exists so the first component that does has a name, and so `--accent-contrast` already
   reaches it. The reference says "read by nothing yet".
5. **`--radius` is the one panel fallback written into the harness** (`PANEL_FALLBACKS`); parsing
   compiled Tailwind for one literal would be a worse coupling.
6. **The fixture imports the vendored select by path,** not through `broapp-ai-elements/ui` (which now
   also exports it): `Bun.build` inside `bun test` resolves a relative import from the workspace
   symlink rather than its real path, so `src/ui/`'s siblings cannot be found; the package entry would
   also pull in the whole panel.

## The gallery

Markup byte-for-byte identical (stylesheets stripped, diffed: no difference). The CSS differs only in
declarations — `var(--text, #16181d)` where a literal was, the six type tokens, the seven on each
preset — never in a computed value, **except** that both presets now set `--bg` and `--text`, and the
gallery rewrites `body` to the panel selector: the quiet panel's ground moves #f7f7f8 → #f5f5f3, the
dense panel's to #ffffff with #111111 ink. That is what "a preset sets the seven first" means, and it
is the only visual change.

## Commands run

`bun run typecheck` 0 · `build:tokens` 64 tokens, 3821 bytes, 0 ·
`bun test tests/autoapp-theme.test.ts tests/autoapp-verify.test.ts` 33 pass 0 fail ·
`bun x playwright install chromium` 0, 94.3 MiB (headless shell 153.0.8010.12) ·
`bun run theme-check` "every rule passed", 0 · `bun test tests/autoapp-theme-browser.test.ts` 7 pass
0 fail · `theme-gallery` 0 · `bun test tests` 729 pass 0 fail, 45 files · `build:launcher` 0, 76.3 MB
· `bun run scripts/autoapp-smoke.ts` "every step passed", 0 · `bun install` no changes ·
`bun run check` 0 · `bun run site` 23 files.

## Open questions

- CI's timings are unmeasured: the `theme` job has never run. Locally the check takes 2–6s and
  Chromium is a 94.3 MiB download; a cold CI cache will be slower, and nobody has seen the number.
- The harness has run on macOS only, and opens its page from `file://`. Serving it over the bridge
  should change nothing that matters to CSS, but that is an argument, not a measurement.
- `theme-check` writes `scripts/theme-check/theme.css` (gitignored) and removes it afterwards. Two
  runs at once would fight over it.

## Acceptance criteria

- Seven variables theme the renderer and the panel alike, proven by computed styles in a compiled
  page, three themes × three schemes, portal open — **pass**.
- A token set directly overrides its `reads` and reaches the renderer without the panel — **pass**.
- Every measured text/background pair meets 4.5:1 — **pass**, lowest 4.63:1.
- No literal weight, tracking or family left in the renderer; the gallery unchanged — **pass** for the
  renderer and for the markup; the preset panels move as described above.
- Strategy a document, checklist in the common rules, `theme` topic tells the engineer how a style
  guide becomes a theme — **pass**.
- `bun run check` green, every command exit 0 — **pass**. CI's new job — **not yet run**.
