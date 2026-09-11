# 12e — Autoapp on the site

## What was built

- `scripts/build-site.ts`: the Autoapp block of `PAGES` gains the landing page and loses its prefixes; `headerMenu(current)` replaces the four literal links; `rewriteLink` is exported, takes the source directory as an optional second argument, and resolves pages and assets from the writing document first; the banner reads `version` from the root `package.json`; `--out <dir>` (default `site/dist`); the build runs only under `import.meta.main`, so the test can import `rewriteLink`.
- `docs/autoapp/README.md` (new, 44 lines): what Autoapp is, the diagram, the download and first-run commands copied from `README.md`, "Read next", what it is not.
- `docs/autoapp/design.md`: one sentence pointing back to the overview. `README.md`: the launcher bullet links to `docs/autoapp/README.md`.
- `tests/site.test.ts` (new): the prompt's seven, plus the reading order of "Read next", the 60-line limit, and resolution order.

The final Autoapp block:

```ts
{ slug: 'autoapp.html', title: 'Autoapp', source: 'docs/autoapp/README.md', group: 'Autoapp' },
{ slug: 'autoapp-design.html', title: 'Design', source: 'docs/autoapp/design.md', group: 'Autoapp' },
{ slug: 'autoapp-learning.html', title: 'What the launcher remembers', source: 'docs/autoapp/learning.md', group: 'Autoapp' },
{ slug: 'autoapp-security.html', title: 'Approvals and limits', source: 'docs/autoapp/security.md', group: 'Autoapp' },
{ slug: 'autoapp-packaging.html', title: 'Packaging and offline', source: 'docs/autoapp/packaging.md', group: 'Autoapp' },
{ slug: 'autoapp-backlog.html', title: 'Phase 2 backlog', source: 'docs/autoapp/backlog.md', group: 'Autoapp' },
```

The order is the reading order the prompt gives for cross-links (design, learning, security, packaging, backlog); before, packaging came second.

## The header menu

Before: Architecture · Security · Guides · Reference (literals). After: **Guides · Reference · Autoapp**, one tab per group except `Start`, each opening its group's first page, the current group marked `aria-current="true"`. It shrank because it now names groups, not pages: Architecture and Security were two pages of `Start`, whose tab would be the home page the brand link already is. Both stay one click away in the sidebar's `Start` group and the footer; the home hero's "Read the architecture" button is unchanged.

## Links that changed where they resolve

1. **Inbound to the design:** every `docs/autoapp/design.md` link (README before this change, `docs/architecture.md`, `docs/limitations.md`, the Autoapp pages) now lands on `autoapp-design.html`; `autoapp.html` is the landing page. The README bullet now opens the landing page.
2. **A bug found and fixed:** `rewriteLink` tried the resolved and the flat forms in one `find` over `PAGES`, so the first page matching *either* won. `packaging.md` and `security.md` written in `docs/autoapp/` matched `docs/packaging.md` / `docs/security.md` by the flat form first and linked to the **core Broapp** pages. Counted in the article bodies of the built site: 14 prose links from Autoapp pages went to `packaging.html` / `security.html` before; after, 12 go to `autoapp-packaging.html` / `autoapp-security.html`, and the 2 that remain are the intended `../packaging.md` and `../security.md`. The new `README.md` link from `design.md` would have hit the same bug and gone to `index.html`. Now: resolved form first, flat forms only if nothing matches. A test covers both directions.
3. `href`/`src` sets of `site/dist/*.html` compared before and after: nothing newly points at GitHub except each page's own "Edit this page" link (new pages, new sources). No GitHub link contains `..`.

## Deviations and decisions

1. **The banner reads the root `package.json` (0.3.1), not `packages/broapp/package.json` (0.3.0).** The prompt names the package manifest and says the packages are at 0.3.1; only the root is (README "Status": the npm packages are unchanged at 0.3.0). The first cut followed the named file and showed 0.3.0; on review the owner chose the repository release, 0.3.1.
2. **README fence fixed.** The notes-starter block closed with "``` The binaries are unsigned; …" on one line. CommonMark does not close a fence with text after it, so GitHub rendered the rest of the README as code, and the site dropped the sentence. Split onto its own line; wording unchanged.
3. **One CSS rule, not for the diagram:** `.topbar__menu a[aria-current="true"]` shares the hover underline, so the current tab is visible. The diagram needed none: `.figure img { width: 100% }` already scales it (673 px of a 673 px column).
4. **"Read next" items are one line each.** The renderer has no list-item continuation lines; wrapped items came out as five one-item lists and loose paragraphs (seen in the browser). No renderer feature added; a test asserts one `<ol>` of five.
5. **Document headings unchanged.** `learning.md` etc. still open with "# Autoapp: …", and `design.md` with "# Autoapp". Those are body text read on GitHub, where there is no group heading; the prompt's titles are the `PAGES` titles, and no `<title>`, sidebar or footer label begins with "Autoapp:".
6. Commit trailer names Claude Opus 5, per this session's attribution rule, not the prompt's Fable 5.1.
7. The test builds once in `beforeAll` into `mkdtempSync` and removes it in `afterAll`; nothing under `site/` is touched.

## Notes

- The SVG's `@import` of Google Fonts does not run when it is loaded by `<img>` (browsers load no external resources for image SVGs), so its labels fall back to the stack in each `font-family`. Legible in the screenshot; the SVG is unchanged. If the exact faces matter, the fonts would have to be inlined in the SVG — not done here.
- Footer: with four groups beside the brand, the wide layout's `2fr repeat(3, 1fr)` grid wraps the Autoapp column to a second row. Pre-existing since the Autoapp group was added; left.
- Looked at over `python3 -m http.server` on 127.0.0.1 (the in-app browser renders `file://` pages as snapshots that cannot load relative images). Screenshots: `index.html` 800×609 (viewport 1024×768), `autoapp.html` top 800×609 and "Read next" 800×772.

**The site is not live for Autoapp until the `autoapp` branch reaches `main`;** `pages.yml` deploys from `main` only, and this prompt does not merge.

## Commands run

- `bun run typecheck` — exit 0
- `bun test tests/site.test.ts` — 10 pass, 0 fail
- `bun run site` — 22 files, exit 0
- `bun test tests` — 661 pass, 0 fail, 40 files
- `bun run check` — typecheck clean; 661 pass, 0 fail, 40 files; exit 0

## Acceptance criteria

- Autoapp tab on every page, opening the landing page with the diagram and the pages in reading order — pass (tests 1, 2, "Read next").
- No page title begins with "Autoapp:" — pass.
- Banner version from the manifest — pass (test 5).
- A relative link from `docs/autoapp/` to `diagrams/` resolves — pass (test 6; the landing page's own image).
- Every existing page builds, no link newly points at GitHub — pass (href comparison above).
- `bun run check` green, every command exits 0 — pass.

## Open questions

- The banner now says "Version 0.3.1 · Published to npm" and links to `create-broapp`, which npm has at 0.3.0. Rewording the banner (for example "Release 0.3.1") would remove the mismatch; not done here.
