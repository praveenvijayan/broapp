# 12f — The theme contract: one table of tokens, and everything else derived from it

## Goal

An Autoapp application already owns its appearance. The renderer draws every
component with `.autoapp-` selectors and colours them from `--autoapp-*` custom
properties; `view.css` gives every property a default on `:where(:root)` in both
colour schemes, so an application that sets any of them on its own `:root` wins
whatever order the stylesheets were bundled in, and one that sets none still looks
deliberate. The starter's `styles.css` maps its palette onto those properties.

None of that is written anywhere an engineer or a person reads. The token list
lives only in a stylesheet; its precedence rule lives in a comment; the reference
the engineer reads says nothing about it; and `view.css` still hard-codes its
spacing, radii and control sizes in 28 places, so an application can change its
colours and nothing else.

After this prompt the contract is one table in TypeScript: every token with its
purpose, its light and dark default, and what consumes it. The stylesheet's default
block, the reference topic the engineer reads, and the checks on the starter are all
derived from that table and held to it by tests — the same shape the AI panel uses
for its generated stylesheet, where a committed artefact is rebuilt in a test and
compared byte for byte. A small set of spacing, typography, radius and density
tokens joins the colours, each defaulting to exactly the value `view.css` uses
today, so no existing application changes appearance on upgrade. Two contrasting
presets exist for people to look at, and a test proves every length and colour in
the renderer comes from a token.

Nothing here adopts a component library, adds a renderer kind, or lets an
application ship browser code. Those are separate decisions with their own rows.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `packages/broapp-autoapp/src/react/view.css`, completely — the `:where(:root)`
  blocks, every `var(--autoapp-…)`, every hard-coded `px` and `rem`.
- `packages/broapp-autoapp/src/react/index.tsx` and `package.json` (`exports`,
  `files`) — how `view.css` reaches an application (`import
  'broapp-autoapp/react/view.css'` in the starter's and Notes' `main.tsx`).
- `templates/autoapp-starter/src/ui/styles.css` — the mapping an application writes.
- `packages/broapp-ai-elements/scripts/build-css.ts` and `tests/ai-elements-css.test.ts`
  — the generated-and-committed pattern this prompt copies: a build function, a
  committed file, a test that regenerates and compares.
- `packages/broapp-autoapp/src/engineer/reference.ts` and `tests/autoapp-verify.test.ts`
  — the reference topics and the test that holds a topic to the types.
- `packages/broapp-autoapp/src/launcher/contract.ts` (`STAGE_NAMES`, "a test holds
  the two lists equal") — the other place one list is declared twice on purpose.
- `packages/broapp-autoapp/src/engineer/tools.ts` (`candidate.explain`, `compare`).
- `packages/broapp/src/cli/build-page.ts` — the CSP: one stylesheet, pinned by hash,
  no `unsafe-inline`. Every style in this prompt lands in that one sheet.
- `docs/autoapp/design.md`, `docs/autoapp/backlog.md`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| One source | `packages/broapp-autoapp/src/react/theme.ts` exports `AUTOAPP_TOKENS`: a readonly array of `{ name, group, purpose, light, dark, consumers }`. `name` is the property without the `--autoapp-` prefix. `group` is `colour`, `space`, `type`, `radius` or `density`. `consumers` names the components that read it, for the reference. Nothing else in the package declares a token. |
| Derived, committed, tested | `scripts/build-tokens.ts` in `packages/broapp-autoapp` writes `src/react/tokens.css` from the table: the light `:where(:root)` block, the dark one under `prefers-color-scheme`, and nothing else. The file is committed. `tests/autoapp-theme.test.ts` regenerates it and compares byte for byte, as `ai-elements-css.test.ts` does. `view.css` loses its default blocks and imports nothing; `react/index.tsx`'s documentation and both `main.tsx` files import `tokens.css` before `view.css`. The package's `exports` gains `./react/tokens.css`. |
| Defaults are today's values | Every colour keeps its exact hex. Every new length token defaults to the value `view.css` uses today at the place it replaces; where `view.css` uses two different values for what is conceptually one token, keep two tokens rather than change a pixel. A test renders nothing; instead it asserts that `view.css` after this prompt contains no `px` or `rem` literal and no `#` colour outside a `var(--autoapp-…, fallback)` fallback, and that every fallback equals the table's light default. |
| Precedence | Unchanged and now written down: defaults on `:where(:root)` (zero specificity); an application sets tokens on `:root` in its own stylesheet; the renderer never sets a token anywhere else. A dark scheme is the application's to define if it defines light; the defaults cover both when it defines neither. |
| New tokens, small set | `space-1` … `space-4` (the four gaps `view.css` uses), `radius-sm`, `radius-md`, `control-height`, `control-padding-x`, `font-size-base`, `font-size-small`, `font-size-heading`, `line-height`, `focus-ring` (the focus-visible outline colour, today the accent). No motion tokens: nothing in the renderer animates. No shadow tokens: nothing in the renderer casts one. |
| Presets | `templates/autoapp-starter/src/ui/styles.css` stays the default preset. Add `packages/broapp-autoapp/presets/` with two files, `quiet.css` (low contrast, larger spacing, rounder) and `dense.css` (compact, square, high contrast), each setting tokens on `:root` for both schemes and nothing else. They are documentation and a test fixture, shipped in `files`; an application uses one by copying it into its `styles.css`. |
| What a person looks at | `scripts/theme-gallery.ts` in the package builds one HTML page that renders the starter's `views.ts` through the real renderer with `react-dom/server`, once per preset, light and dark side by side, and writes it to `.broapp-tmp/theme-gallery.html`. No browser automation; a person opens it. The report carries what they saw. |
| The reference | `spec.reference` gains a `theme` topic, **generated from `AUTOAPP_TOKENS`** at module load, not written by hand: the precedence rule, then one line per token with group, purpose, defaults and consumers. `REFERENCE_TOPICS` gains `'theme'`; the `views` topic's Page paragraph gains one sentence pointing at it. The existing drift test extends: every token in the table appears in the topic as code. |
| Ecosystem guidance | In the `workspace` topic, two sentences: prefer what the renderer already draws; a dependency the renderer would need is a decision for the framework, made in `packages/broapp-autoapp`, never in an application's `package.json`. Nothing in `instructions.ts` changes; it is at its limit. |
| Cost made visible | `candidate.explain` reports `pageBytes` (the release's `page.html` size) and `pageBytesBefore` (the current release's), so a change that grows the page shows its cost where the person approves it. The launcher tab's candidate panel shows the two numbers when they differ by more than 2%. |
| Not in scope | Radix, shadcn, Mantine or any dependency; a canvas, editor or map kind; application-supplied browser code; motion; a theme switcher in the tab; runtime theme changes (a preset is a stylesheet, bundled and hashed like any other). |

## Step 1 — the table and the generated stylesheet

`src/react/theme.ts`:

```ts
export type TokenGroup = 'colour' | 'space' | 'type' | 'radius' | 'density';
export interface ThemeToken {
  readonly name: string;          // e.g. 'accent', 'space-2'
  readonly group: TokenGroup;
  readonly purpose: string;       // one sentence
  readonly light: string;         // the default in the light scheme
  readonly dark: string;          // the default in the dark scheme; equal to `light` for lengths
  readonly consumers: readonly string[]; // 'table', 'form', 'button', 'status', 'text', 'section', 'page'
}
export const AUTOAPP_TOKENS: readonly ThemeToken[];
export const TOKEN_PREFIX = '--autoapp-';
export function tokensCss(tokens?: readonly ThemeToken[]): string;   // what build-tokens.ts writes
```

Colours come straight from today's two blocks. Lengths come from reading `view.css`
and naming each distinct value once; the report lists every literal and the token it
became. `tokensCss` writes the light block, then the dark block, with a header comment
saying the file is generated and from where.

`scripts/build-tokens.ts` writes `src/react/tokens.css`; `package.json` gains
`"build:tokens"`, and `build-launcher.ts` runs it after `build:template` so the
launcher's own page picks it up. `view.css`: remove the two default blocks; replace
every literal with `var(--autoapp-<name>, <literal>)`, the literal kept as the
fallback so a page that somehow lost `tokens.css` still renders as today.

## Step 2 — the reference and the guidance

`reference.ts`: `theme` topic built from `AUTOAPP_TOKENS` by a function, grouped by
`group`, one line per token: `` `--autoapp-accent` `` — purpose — light / dark —
read by table, button. Above the table, the precedence rule in four sentences and
the one way an application applies a preset. `views` topic: one sentence. `workspace`
topic: the two sentences on dependencies.

## Step 3 — presets and the gallery

`presets/quiet.css`, `presets/dense.css`, and `scripts/theme-gallery.ts`. The gallery
imports the starter's `views.ts` from `templates/autoapp-starter`, renders each page
with `AutoappView`'s server-side entry (check `react/index.tsx` for what renders
without a bridge; if nothing does, render `Page` with a stub context and say so in
the report), and inlines `tokens.css`, `view.css` and the preset. Light and dark are
produced by wrapping each in a `<div style="color-scheme: …">` with the preset's
dark block rewritten to apply under a class rather than the media query — that is
gallery-only, and the comment says so.

## Step 4 — cost in `candidate.explain`

`pageBytes` from `statSync` of the candidate release's `page.html`,
`pageBytesBefore` from the current release's, both in the tool's output and in
`launcher.candidateStatus`; `CandidatePanel.tsx` shows "page 1.1 MB (+3%)" when the
change is more than 2% either way.

## Step 5 — docs

- `docs/autoapp/design.md`: a section "The theme contract" — the token table is the
  contract, the stylesheet and the reference are derived, precedence, presets, cost.
- `templates/autoapp-starter/README.md` and `styles.css` header: point at the
  `theme` topic and the presets.
- `docs/autoapp/backlog.md`: rows for "a renderer kind with rich interaction (the
  painting requirement)" with the precondition "the reports reproduced and filed under
  `prompts/autoapp/reports/`", and "verify a third-party component in the compiled
  page" pointing at the rendered-checks row as the harness both would share.

## Verification

```bash
bun run typecheck
bun run --cwd packages/broapp-autoapp build:tokens
bun test tests/autoapp-theme.test.ts tests/autoapp-verify.test.ts
bun run --cwd packages/broapp-autoapp theme-gallery
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

`tests/autoapp-theme.test.ts`:

1. `tokens.css` equals `tokensCss()` byte for byte.
2. Every token name is unique, prefixed once, `[a-z][a-z0-9-]*`; every `dark` of a
   length token equals its `light`.
3. `view.css` contains no `px` or `rem` literal outside a `var(--autoapp-…, …)`
   fallback, no `#` colour outside one, and every fallback equals the table's light
   default for that token.
4. Every `--autoapp-` name used in `view.css` is in the table, and every table entry
   with a non-empty `consumers` is used in `view.css`.
5. The starter's `styles.css` sets only names that are in the table.
6. Both presets set only names in the table and set every colour token in both
   schemes.
7. The `theme` reference topic names every token as code; the `views` topic points
   at it; the `workspace` topic carries the dependency sentences.
8. `candidate.explain` on a candidate reports `pageBytes` and `pageBytesBefore`
   (extend the existing explain test).
9. A page built from the starter with `tokens.css` and `view.css` in the CSP's one
   stylesheet passes `broapp build`'s off-origin check (the existing build test
   covers the mechanism; add the case).

The gallery is looked at by a person: the report records, for each preset in each
scheme, that headings, body text, muted text, inputs, buttons, a table with rows, an
empty table, a notice and an error were readable and that focus rings were visible.

## Acceptance criteria

- One table declares every token; the stylesheet's defaults and the engineer's
  reference are generated from it and a test holds each to it.
- No existing application changes appearance: every default equals today's value,
  proven by the fallback test.
- The renderer has no hard-coded length or colour left.
- Two presets exist, a person has looked at both in both schemes, and the report
  says what they saw.
- A change's page cost is shown where the person approves it.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12f-theme-contract.md`. Include: the literal-to-token
mapping table for `view.css`; the gallery findings per preset and scheme; the
`page.html` size of the starter and of Notes before and after (tokens add bytes;
say how many); and anything the renderer could not express with a token.

## Commit

```
Declare the theme once, and derive the stylesheet and the reference from it

One table of tokens with purpose, defaults and consumers. The renderer's
default block is generated from it and held to it by a test; the engineer's
reference gains a theme topic built from the same table; spacing, type,
radius and density join the colours at exactly today's values, so no
application changes appearance. Two presets to look at, and a change's page
size shown where a person approves it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
