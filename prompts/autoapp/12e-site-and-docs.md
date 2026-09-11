# 12e — Autoapp on the site: a tab, a landing page, honest titles

## Goal

The documentation site is generated from the repository's Markdown by
`scripts/build-site.ts` and deployed from `main` by `.github/workflows/pages.yml`.
Five Autoapp pages already build under a group called `Autoapp`, and they reach the
sidebar and the footer — but the header's primary menu is four hard-coded links
(Architecture, Security, Guides, Reference), so a visitor never sees that Autoapp
exists unless they scroll. The pages are titled "Autoapp: …", which reads twice once
there is an Autoapp tab. `docs/autoapp/design.md` doubles as the section's front door
and opens too deep. The announcement banner says "Version 0.1.0" in a string literal
while the packages are at 0.3.1. And a relative image link written from a nested
`docs/autoapp/` file cannot reach `diagrams/`, because the rewriter strips one `../`
and then checks the asset directory against the wrong path.

After this prompt: the header menu is derived from the page groups, so **Autoapp** is
a tab; the tab opens a landing page written in `docs/autoapp/README.md` that carries
the architecture diagram and links the section's pages in reading order; titles read
once; the banner reads the version from the package manifest; nested relative links
resolve. No code outside the site generator, the docs and the README changes. No new
dependency.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `scripts/build-site.ts`, completely: `PAGES`, `ASSET_DIRS`, `rewriteLink`,
  `homeHero`, `contributionBand`, the page shell (the `announce` div and the
  `topbar__menu` nav), `STYLES`.
- `.github/workflows/pages.yml`.
- `README.md` (the "What Broapp contributes" list, whose "An optional launcher"
  bullet is already a capability card on the home page — do not add a second mention).
- `docs/autoapp/*.md` — their opening paragraphs, which the landing page must not
  repeat.
- `diagrams/autoapp-architecture.html` and `diagrams/autoapp-architecture.svg` — the
  diagram and its exported SVG. Both are checked in. Do not edit either; if the SVG
  needs to change, say so in the report and leave it.
- `packages/broapp/package.json` (`version`).

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| One generator, one group, one tab | No second site, no second script. The Autoapp section is the existing `Autoapp` group in `PAGES`. |
| Header menu | Derived from `GROUPS`, one link per group to that group's first page, in `PAGES` order, `Start` excluded (the brand link is the home). The current page's group carries `aria-current="true"`. Result today: Architecture is gone from the menu unless you keep it as `Start`'s first page — decide: the menu becomes **Guides · Reference · Autoapp**, and Architecture and Security move into the sidebar's `Start` group where they already are. Say in the report why the visible menu shrank. |
| Landing page | `docs/autoapp/README.md`, slug `autoapp.html`, title `Autoapp`, first in the group. `design.md` moves to `autoapp-design.html`. Any inbound link to `autoapp.html` from another page (README, `docs/architecture.md`, `docs/limitations.md`) points at `docs/autoapp/design.md` today — those keep working because `rewriteLink` resolves by source path, not slug; a test proves it. |
| Titles | `Autoapp` (landing) · `Design` · `What the launcher remembers` · `Approvals and limits` · `Packaging and offline` · `Phase 2 backlog`. The `Autoapp:` prefix is gone; the group heading in the sidebar and footer already says it. The `<title>` element keeps the site's existing `<page> · Broapp` pattern. |
| Landing page content | Under 60 lines of Markdown. In order: one paragraph saying what Autoapp is (the launcher, the engineer, the gate, one binary per target); the diagram as `![…](../../diagrams/autoapp-architecture.svg)` with the diagram's own `<desc>` sentence as the alt text; the download and first-run lines lifted from the README's Autoapp section (the `curl … | tar xz`, `import`, `serve` lines — copy them, and add a test that the landing page's fenced commands appear verbatim in `README.md` so they cannot drift); a "Read next" list of the five pages with one sentence each; one line naming what it is not (no containment, trusted local code, link to limitations). Nothing that `design.md` already opens with. |
| Banner | `Version ${version}` from `packages/broapp/package.json` imported `with { type: 'json' }`. The npm link stays. |
| Nested links | `rewriteLink` checks `ASSET_DIRS` against `resolved` (the path resolved from the document's directory), not `clean`. Keep the `clean` fallbacks for links written from the repository root. |
| Diagram on the page | The SVG is served from `diagrams/`, copied as-is like the existing three. It loads its own fonts from Google Fonts by `@import`; the site already loads Google Fonts, so no CSP or offline concern changes. Give it the existing `.figure` treatment; no new CSS beyond one rule if the SVG's intrinsic width needs `max-width: 100%`. |
| Deployment | Unchanged: `main` only. This prompt does not merge. The report says the site is not live for Autoapp until `autoapp` reaches `main`. |
| Not in scope | Dark mode for the diagram, a PNG export, per-page hero images, search, versioned docs. |

## Step 1 — the generator

`scripts/build-site.ts`:

1. `PAGES`: insert the landing page first in the `Autoapp` group with slug `autoapp.html`;
   retitle the five pages; move `design.md` to `autoapp-design.html`.
2. `headerMenu(current)`: groups except `Start`, each linking to its first page, with
   `aria-current="true"` on the current page's group. Replace the four literals.
3. `rewriteLink`: asset check on `resolved`. Add a comment saying why (`clean` strips
   one `../`, and `docs/autoapp/` is two deep).
4. Banner: version from the manifest.
5. A "Read next" list is ordinary Markdown; no new renderer feature.

Keep the file's comment style: full sentences, why not what.

## Step 2 — the docs

- `docs/autoapp/README.md` as decided. Cross-links are relative to `docs/autoapp/`:
  `design.md`, `learning.md`, `security.md`, `packaging.md`, `backlog.md`,
  `../limitations.md`.
- `docs/autoapp/design.md`: the first paragraph gains one sentence pointing back:
  "The short version, with a picture, is the [Autoapp overview](README.md)." Nothing
  else moves out of it.
- `README.md`: the "An optional launcher" bullet links to `docs/autoapp/README.md`
  instead of `design.md`. The Autoapp download section stays where it is.
- `docs/architecture.md:51` and `docs/limitations.md:34`: leave pointing at
  `design.md`; they are about the design.

## Step 3 — tests

`tests/site.test.ts` (new, `bun:test`, runs `bun run scripts/build-site.ts` into a
temporary `--out` directory — add that flag if the script has none, defaulting to
`site/dist`, and remove nothing under `site/` in tests):

1. `index.html` header menu has exactly the links Guides, Reference, Autoapp, in that
   order, and no `Autoapp:` string appears in any page title.
2. `autoapp.html` is the landing page: contains the diagram `<img>` pointing at
   `diagrams/autoapp-architecture.svg`, the file exists in the output, and the
   `alt` equals the SVG's `<desc>` text.
3. `autoapp-design.html` exists; `architecture.html`'s link to the Autoapp design
   resolves to `autoapp-design.html`, not to GitHub.
4. Every fenced command block in `docs/autoapp/README.md` appears verbatim in
   `README.md`.
5. The banner contains the version from `packages/broapp/package.json`.
6. A link written as `../../diagrams/x.svg` from a source under `docs/autoapp/`
   rewrites to `diagrams/x.svg` (call `rewriteLink` directly if it is exported for
   the test; export it if not).
7. The page with `aria-current="page"` in the sidebar also has `aria-current="true"`
   on its group in the header.

## Verification

```bash
bun run typecheck
bun test tests/site.test.ts
bun run site
bun test tests
bun run check
```

Open `site/dist/index.html` and `site/dist/autoapp.html` in a browser and look:
the tab, the diagram at full width, the "Read next" list, the version in the banner.
Put the two screenshots' sizes in the report, not the images.

## Acceptance criteria

- The header shows an Autoapp tab on every page; it opens a landing page with the
  diagram and the section's pages in reading order.
- No page title begins with "Autoapp:"; the sidebar group heading is the only place
  the word appears as a label.
- The banner's version comes from the manifest.
- A relative link from `docs/autoapp/` to `diagrams/` resolves in the built site.
- Every existing site page still builds and every existing link still resolves
  (compare the set of `href`s in `site/dist/*.html` before and after for anything that
  newly points at GitHub).
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12e-site-and-docs.md`. Include: the final `PAGES` Autoapp
block; the header menu before and after and why it shrank; any link that changed
where it resolves; the landing page's line count; the sentence that the site is not
live for Autoapp until the branch reaches `main`.

## Commit

```
Give Autoapp a tab, a landing page and titles that read once

The header menu is built from the page groups, so Autoapp appears beside
Guides and Reference. Its tab opens docs/autoapp/README.md with the
architecture diagram and the section's pages in reading order. Page titles
lose their prefix, the banner reads the version from the manifest, and a
relative link from a nested doc to diagrams/ now resolves.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
