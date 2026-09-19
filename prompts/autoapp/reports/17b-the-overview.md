# 17b — The overview

## What was built

- `launcher/ui/OverviewScreen.tsx`: the screen, drawn from one `launcher.overview` read
  handed in by `App`: header with the alerts control, summary strip, attention band,
  Running now (stepper, three figures, the activity line, the last refusal), Applications,
  the footer strip, and a prices section (`launcher.pricesGet`/`pricesSet`, the one
  thing the screen writes). Pure formatters exported for tests.
- `launcher/ui/overview-poll.ts`: `overviewInterval`, `startOverviewPoller` — 2 s on the
  Overview while visible, 10 s otherwise, one read in flight, timers injected.
- `App.tsx`: two views, `overview` first on every load; rail gains **Overview** (first,
  `aria-current="page"`, the `needsYou` count, the waiting mark), **Engineer** (the chat,
  `aria-current` when shown) and **Settings**; the chat section is always mounted and
  `hidden` on the Overview; the applications column is not drawn there and its toggle is
  disabled with a title saying why. New conversation and picking a conversation show the
  chat. `announceOverview` runs from `App` on every read; the title counts `needsYou`
  plus the chat's own questions. Sound switch in `localStorage` (`broapp-autoapp:sound`).
- `IntentPanel.tsx`: `openIntent`, so an action can open the Backlog panel on a request.
- `launcher.css`: the screen's rules at the end, `--launcher-*` only; container queries
  for the 900 px and 520 px steps (the screen's width, not the window's).
- `react/pending.ts`: unchanged since 17a.
- `ci.yml`: the `theme` job also runs `tests/autoapp-overview.test.ts`, so its browser
  half runs in CI.
- Docs: three `backlog.md` rows (charts or days, a strip above the chat, arranging).

## Where 17a's route and this prompt differed, and which won

17a's shape won everywhere: attention rows show `title` and `appName · detail`, not the
mockup's split; the advice item's title is "<task> failed"; "attempt n of m" is `turn`
of `maxAttempts`; "Last changed" is `apps[].changedAt`; the prices section's usage is
`spend.todayByModel`; the estimate is shown only when every application with queued
tasks has one.

## The mockup, mapped to the design system

| Mockup | Used here |
|---|---|
| page `--page` | `--launcher-ground` |
| cards `--card`, `--line` | `--launcher-surface`, `--launcher-border` |
| titles and figures `--ink` | `--launcher-heading` |
| body `--ink`, captions `--ink-2`/`--ink-3` | `--launcher-text`, `--launcher-muted` |
| attention band `--attention-bg`/`--attention-line` | `--launcher-warn-surface`/`--launcher-warn-border`; the band's detail line `--launcher-text` (muted there was 4.49:1) |
| attention figure, count pill, "?" mark `--attention` on white | `--launcher-warn-text`; pill and mark `--launcher-warn-text` ground with `--launcher-warn-surface` text |
| "!" mark `--danger`, "Needs review" dot | `--launcher-error-text` on `--launcher-error-surface` |
| Building / serving dot `--ok` | `--launcher-good-text` |
| stopped dot `--idle` | `--launcher-muted` |
| stepper done/current, progress fill, `.btn.primary` | `--launcher-accent` with `--launcher-accent-contrast` |
| `.btn.hot` (the attention action, orange) | the one filled button: `--launcher-accent`, not a warn fill |
| tracks and dividers `--track`, `--line-strong` | `--launcher-border`; the progress track outlined in `--launcher-muted` and the upcoming step's ring `--launcher-muted`, because the divider colour alone is under 3:1 as a shape |
| hover `--ink-2` border | `--launcher-hover` |
| focus ring `--attention` | `--launcher-accent` |

**What the design system could not say, and what was used instead**

1. **The serif display type** (56 px title, 36 px task title, 28 px Applications, 46 and 32 px figures): no second family, so all system sans. The title, the task title and the block headings use the launcher's own largest steps (1.05rem/650, 1rem/620); the figures are the same family larger (2rem and 1.5rem, weight 600, tabular). The page title is therefore no larger than a card title; the detector's "flat type hierarchy" finding is that, and stays.
2. **The orange attention colour and the white on it**: the launcher's warn pair is amber-brown, so the band is warn-surface/warn-border and the marks invert the pair; the orange "Answer" button became the accent fill.
3. **`--ok` green dots**: `--launcher-good-text` (a text colour used as a dot).
4. **`--track` and `--line-strong`** (a mid grey between divider and caption): none; border plus a muted outline.
5. **The mockup's page breakpoints** (900 px, 520 px) are container queries on the screen's own width, because the conversations column shares the window.

## The by-hand look

The page built with `build:page`; `src/launcher/main.ts open --no-open --no-restore` with
`BROAPP_DATA_DIR` at a copy under the scratchpad: `apps` (no `data*`, `source`,
snapshots or `node_modules`), `intents.sqlite`, `knowledge.sqlite` and `journal.sqlite`
taken by `VACUUM INTO` read-only, `intent-models.json`, `session.json`; not `ai`, not
`runs.sqlite`, not `launcher.json`, not `serving.json`. The person's own launcher kept
serving the real root and was not touched. Both copies are deleted.

- **Real root, 1280 light and dark:** 3 need you (two candidates ready to activate, one
  failed task with advice), 1 queued, nothing running, spend 0. Fixed from it: the
  advice detail ran to five lines (now two, whole text in the panel); application names
  broke mid-word in a narrow column (now a 6rem floor); the 900 px step fired on the
  window, not the screen (container queries).
- **Empty root, 1280 light and 375 dark:** every block present; Open backlog is the filled
  button. Fixed: the empty Applications line sat against its heading.
- **A run's data:** no model, so no live run. The screen was drawn from the mockup's data
  (a run building, two attention items, three applications) with `renderToString` and
  `launcher.css`, served on loopback, at 1280 and 375 in both schemes. No horizontal
  scroll at 375 in any case (`scrollWidth` 375). Seen: close to the mockup in order,
  grouping and words; the `≥`/partial footer; the stepper; budget line.

## The design gate (section 2b)

No `PRODUCT.md` exists, and `impeccable teach` would write one into the repository, so
the gate ran without it, product register. **Critique** (an independent agent, not shown
my view): 28/40 — visibility 3, match 3, control 3, consistency 3, error prevention 4,
recognition 3, flexibility 2, minimalism 3, error recovery 2, help 2. **Audit**:
accessibility 2, performance 4, theming 4, responsive 3, anti-patterns 3. **Detector**
(`impeccable detect --no-config` on both renders): 6 × cramped padding, 2 × flat type
hierarchy.

Acted on, all below 3 and allowed: the countdown now `aria-live="off"` inside the band's
polite region; "Could not refresh" in warn with the figures' age; `<main>` landmark;
24 px targets for links and the Sound switch; band detail in `--launcher-text`; stepper
ring and track outlined in muted; figures, countdown and "· 22%" no longer split at 375;
attention rows share one grid (subgrid) so their columns line up; focus ring offset
2 px on filled buttons; "≥"/partial and Stop run explained on hover; padding in the
facts' dividers (the detector's six). Left: flat type hierarchy and flexibility (no
shortcuts) — the scale is fixed by this prompt; the Running-now tile repeating the card,
the uppercase eyebrow and the figure strip — the mockup's. After: detector primary
findings on the renders, only the two flat-hierarchy ones; `bun run design-detect` clean.

## What a person still has to open another panel to learn

Whether a preview is running (the Candidate panel; Open preview says so if not); the
whole advice note and the failure reasons (the Backlog panel); which model each task
runs on and its tier; a release's checks by name and its capabilities to grant (the
Candidate panel). The first is the one that should not need a panel: `launcher.overview`
could carry `previewRunning` per application.

## Page size

`dist/launcher-page.html` 1,367,582 → 1,402,844 bytes: **+35,262 (+2.6%)**.

## Deviations, and decisions I made

1. **Two rail buttons beyond "Overview": Engineer and Settings.** The rail must mark
   which view is current, and there was no button for the chat itself; Settings lived in
   the chat's hidden top bar, and must open over the Overview.
2. **Stop run opens the Backlog panel** on the run, where Stop and its confirmation are:
   the screen changes nothing itself. Start and Open call the Applications table's own
   open (`launcher.appOpen`); Open preview calls `launcher.previewOpen`.
3. **A candidate ready to activate** opens the chat view with the applications column
   open and the application selected, where the candidate panel is.
4. **`data-view` and `data-turn`** on the launcher's root, so a browser test can read the
   view and the chat's busy state.
5. **The browser tests skip without Chromium**, as the theme test does; they ran here and
   CI's `theme` job now runs the file. The chat-survives test is one of them.
6. **The "writes nothing" of 17a and this screen's prices section**: the section is the
   prompt's own exception. Commit trailer names Claude Opus 5.

## Commands run

```
bun run typecheck                                                   exit 0
bun test tests/autoapp-theme.test.ts tests/autoapp-theme-browser.test.ts tests/autoapp-gate.test.ts   63 pass, 0 fail
bun test tests                                                      1069 pass, 0 fail (55 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 78.1 MB, exit 0
bun run scripts/autoapp-smoke.ts                                    autoapp smoke: every step passed
bun run theme-check                                                 every rule passed
bun run check                                                       exit 0
bun run design-detect                                               4 pages, no primary findings
git diff --stat packages/broapp tests/ai-chat.test.ts               (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| First screen, a view beside the chat, says what needs the person, the run and stage, cost, what is left, each app, laid out as the mockup | pass (tests 1, 2, 12; by hand) |
| Switching views never interrupts a turn | pass (test 13, Chromium) |
| Every decision is one action opening where it is made; the screen changes nothing | pass (test 7; nothing calls `launcher.activate`, stop or answer) |
| Only existing variables and font, both schemes, no new variable; a test holds it | pass (test 11) |
| No cost unpriced, no floor as exact | pass (test 3) |
| Permission only by a click; sound can be turned off and tested | pass (test 9, both halves) |
| Reads no faster than 2 s, 10 s when unwatched | pass (test 10) |
| No horizontal scroll at 375; keyboard-operable; contrast check green | pass (by hand; `theme-check`) |
| No change to `packages/broapp`; `ai-chat` unchanged; `check` green | pass |
