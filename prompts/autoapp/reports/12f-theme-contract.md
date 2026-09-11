# 12f — The theme contract

## What was built

- `src/react/theme.ts`: `AUTOAPP_TOKENS` (57 tokens: 19 colour, 18 space, 7 type, 3 radius, 10 density), `TOKEN_PREFIX`, `tokensCss()`, `fallbackFor()`. Exported from `broapp-autoapp/react`.
- `scripts/build-tokens.ts` → committed `src/react/tokens.css` (`build:tokens`, now the first step of `build:assets`). Export `./react/tokens.css`; `presets` added to `files`.
- `view.css`: default blocks gone, imports nothing; every length and colour is `var(--autoapp-<name>, <today's value>)`. Starter and Notes `main.tsx` import `tokens.css` before `view.css`; `index.tsx` documents it.
- `spec.reference` topic `theme`, generated from the table; `views` Page paragraph points at it; `workspace` carries the two dependency sentences; the tool description lists the topic. `instructions.ts` untouched.
- `presets/quiet.css`, `presets/dense.css`; `scripts/theme-gallery.ts` (`theme-gallery`).
- `candidate.explain` and `launcher.candidateStatus` report `pageBytes` / `pageBytesBefore` (`releasePageBytes` in `spec/store.ts`); `CandidatePanel` appends e.g. "Page 1.1 MB (+3%)." when the change exceeds 2% (`pageCost`).
- Docs: design.md "The theme contract"; backlog rows for rich-interaction kinds and third-party component verification; starter README and `styles.css` header.
- Tests: `tests/autoapp-theme.test.ts` (cases 1–7 plus "view.css never sets a token"), explain + `pageCost` cases in `autoapp-engineer.test.ts`, the stylesheet case in `build.test.ts`.

## Literal → token (view.css)

| Before | Token | Where |
|---|---|---|
| 1.25rem | `space-8` | `.autoapp`, `.autoapp-page` gap |
| 1rem | `space-7` / `card-padding-y` / `font-size-heading` | status gap / card and approvals padding / card, approvals titles |
| 0.75rem | `space-6` | card and approvals gap, approval divider padding |
| 0.6rem | `space-5` / `inset-x` / `notice-padding-y` | draft leaf gap / input, cell, code padding / notice |
| 0.5rem | `space-4` / `inset-y` / `message-padding-y` | button-row and approval gaps, approval margins, run step, run result, urgent padding / input, cell, code / message |
| 0.4rem | `space-3` | row-actions gap, status padding, approval question margin |
| 0.3rem | `space-2` | label-to-field gap |
| 0.25rem | `space-1` / `control-small-padding-y` | notice item gap, draft leaf / small button |
| 1.1rem, 0.7rem, 0.9rem, 1.6rem, 8rem | `card-padding-x`, `message-padding-x`, `notice-padding-x`, `list-indent`, `label-width` | cards, messages, notice right and left, draft path |
| 0.45rem 0.9rem, 0.55rem | `control-padding-y/x`, `control-small-padding-x` | buttons |
| 1.05rem | `check-size` | checkbox |
| 1.35rem, 0.9rem, 0.85rem, 0.8rem, 1.55 | `font-size-title`, `-note`, `-small`, `-caption`, `line-height` | title; message/notice/run step; label/small button/code/path; column header; text |
| 10px, 8px, 7px | `radius-lg`, `radius-md`, `radius-sm` | cards and approvals; notice; field, button, message, code |
| 1px, 3px, 2px, 1px | `border-width`, `accent-border-width`, `focus-ring-width`, `focus-ring-offset` | every border; urgent edge; focus outline |
| (none) | `control-height: auto`, `font-size-base: 1em` | new `min-height` on field and button; `font-size` on `.autoapp` |
| accent | `focus-ring: var(--autoapp-accent)` | field focus outline |

Every colour kept its hex.

## Deviations and decisions

1. **57 tokens, not "a small set".** "No `px`/`rem` literal left" plus "two tokens rather than one changed pixel" cannot both hold with twelve new names: `view.css` uses eight distinct gap/margin values (so `space-1…8`, not `…4`), three radii, five font sizes and four line weights. Role tokens (`card-`, `inset-`, `message-`, `notice-` paddings) cover the paddings. Line weights, `check-size` and the focus-ring width/offset sit in `density`, the nearest of the five fixed groups.
2. **`control-height` and `font-size-base` had no value to inherit.** `view.css` set neither, so their defaults are the values the properties already computed to (`min-height: auto`, `font-size: 1em`), and nothing moves.
3. **`focus-ring` defaults to `var(--autoapp-accent)`, not a hex.** Starter and Notes set `--autoapp-accent`; a hex default would have detached their focus rings from it. `fallbackFor()` gives the fallback (`var(--autoapp-accent, #2a5bd7)`), and the test compares against it.
4. **`build:tokens` runs inside `build:assets`, before `build:page`,** rather than after `build:template` in `build-launcher.ts`. Run after the page, a changed table would reach the next build, not this one. `build:assets` is also what pack and publish call. The launcher's own page does not import `view.css`.
5. **Gallery renders without `Page`:** `Page` loads sources in an effect, which never runs on a server. `renderComponent` is now exported from `Page.tsx`, and the conflict list became `ConflictList` in `AutoappView.tsx` (same markup). The gallery draws them inside a stub `PageProvider` with fixed data, and repeats `Page`'s title wrapper. The approvals strip needs a connection, so it is not drawn; the theme test still holds its rules to the tokens. The gallery also adds a status, a link column and a lone button, which the starter does not use.
6. `react-dom/server` comes from the repository's hoisted install. No dependency was added.
7. Commit trailer names Claude Opus 5, per this session's attribution rule.
8. **`broapp-autoapp` 0.3.1 → 0.3.2 (not published).** The first smoke run failed at `create` with "page: Bundle failed". A created workspace installs `broapp-autoapp@^<package version>` from npm; npm's 0.3.1 satisfied `^0.3.1` and has no `tokens.css`, so the starter's import could not resolve. With the range at `^0.3.2`, which npm does not carry yet, the install fails and the build resolves from this tree, the case the smoke's own comment describes. At release, 0.3.2 must be on npm before a launcher is tagged; the release rule already says so. The root version, `docs/publishing.md` and the README status still describe what is published, and are unchanged.

## Gallery (looked at in the in-app browser by Claude, 1500×1000; not yet by the owner)

Each of default, quiet and dense, light and dark: headings, body text, muted text (column headers, empty-table italic, status label), inputs, buttons, a table with rows, an empty table, the notice and the error message were all readable. In each of the six panels, focusing the first field matched `:focus-visible` with a 2px solid ring: default `#2a5bd7`/`#7aa2ff`, quiet `#46659f`/`#8ea7d8`, dense black/white. A screenshot confirmed the quiet-dark ring. Quiet: rounder (12/18px), roomier, 40px controls, softer ink. Dense: square, 28px controls, black-on-white and white-on-black, visibly compact. **Pre-existing, not changed:** row dividers stop short of the row-actions cell, because that `<td>` is `display: flex` (all presets, before this prompt too).

## Page size (`buildPage` on each `src/ui/main.tsx`)

| | before | after | added |
|---|---|---|---|
| starter | 276,369 B | 286,259 B | +9,890 (+3.6%) |
| Notes | 1,194,291 B | 1,204,202 B | +9,911 (+0.8%) |

`tokens.css` is 3.2 KB of source. The rest is the `var(--autoapp-…, …)` wrappers `view.css` now carries.

## What a token cannot express

Font weights (600/650), the monospace stack, uppercase column headers and their letter-spacing, column widths (1%/60%), the 0.55 disabled opacity, italic empty text, and a textarea's five rows (markup, not CSS). None is a length or a colour.

## Open questions

- Until `broapp-autoapp` 0.3.2 is published, `create` works only where resolution can reach this tree: in the repository, as the smoke runs it. A launcher built from this commit and used anywhere else cannot build a new application. Deviation 8 has the reason.
- The dark block of a preset repeats no lengths. An application that wants different spacing per scheme writes its own.

## Commands run

- `bun run typecheck` — exit 0
- `bun run --cwd packages/broapp-autoapp build:tokens` — 57 tokens, exit 0
- `bun test tests/autoapp-theme.test.ts tests/autoapp-verify.test.ts tests/build.test.ts` — 43 pass, 0 fail
- `bun test tests/autoapp-engineer.test.ts -t "explain|page cost"` — 2 pass, 0 fail
- `bun run --cwd packages/broapp-autoapp theme-gallery` — wrote `.broapp-tmp/theme-gallery.html`, exit 0
- `bun test tests` — 707 pass, 0 fail, 43 files
- `bun run --cwd packages/broapp-autoapp build:launcher` — exit 0
- `bun run scripts/autoapp-smoke.ts` — first run: 1 step failed (`create: page: Bundle failed`, deviation 8); after the bump and `bun install` (exit 0): "every step passed", create "resolved from this tree after the install failed"
- `bun run check` — typecheck clean; 707 pass, 0 fail, 43 files; exit 0

## Acceptance criteria

- One table; defaults and reference generated from it and held by tests — pass.
- No existing application changes appearance (every fallback equals today's value) — pass.
- No hard-coded length or colour in the renderer — pass.
- Two presets; both schemes looked at; findings recorded above — pass, looked at by Claude, not the owner.
- Page cost shown where the person approves — pass.
- `bun run check` green, every command exits 0 — pass.
