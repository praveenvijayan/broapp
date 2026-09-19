# 17b — The overview

## Goal

17a made one read, `launcher.overview`, that answers what needs the person, what
is running and at what stage, what it has cost, what is left and what each
application is doing. Nothing shows it. The launcher opens on a chat and a list
of applications; what a run is doing is three panels away and mostly not there.

This prompt draws the screen a person lands on: an **Overview** that holds only
what they need to decide something — answer, stop, review, activate, start —
and sends them to the panel that already does it.

The layout is fixed by a mockup the owner approved:
`prompts/autoapp/mockups/overview.html`. Open it in a browser before anything
else. **Take from it the layout, the placement, the hierarchy and the words.
Take nothing else.** Its fonts, its colours and its dark palette are the
mockup's own and are not to be copied: the launcher has a design system, and
this screen is drawn in it. No new theme, no new palette, no font.

Run this after 17a is merged.

## Read first

- `prompts/autoapp/00-common-rules.md`, section 2b (the component gate) in
  full; reports 12f, 12g and 12h (tokens, the rendered check, the design
  guidance and the detector), 13a (the Backlog panel), 0.4.14's panel redraw in
  the git log (`518b66e`), and 17a in full — above all the shape of
  `launcher.overview` as it was built, which wins over this prompt where they
  differ; say so in the report.
- `prompts/autoapp/mockups/overview.html`, rendered at 1280 and at 375 wide.
- `packages/broapp-autoapp/src/launcher/ui/launcher.css`: the `--launcher-*`
  variables in both schemes (lines ~28–105), the body's font, the rail, the
  overlay panels and their scrim, the Backlog panel at `min(84rem, 100%)`, the
  existing button, badge, table and progress styles. `scheme.ts`: why the
  scheme is an attribute and why `light-dark()` does not work in this page.
- `packages/broapp-autoapp/src/launcher/ui/App.tsx`: the grid and its areas
  (`rail history chat apps`), `toggleColumn` and the `launcher--*-hidden`
  classes, the narrow-window behaviour, the rail, the four `show*` overlays,
  how `BroappChat` is mounted and what hangs on its `controlsRef`, `onAwaiting`
  and `onBusy`, `runWaiting` and the rail
  button's waiting state, how panels are told which record to open.
  `IntentPanel.tsx`, `AppsTable.tsx`, `CandidatePanel.tsx`: the actions this
  screen links to and how they are invoked today.
- `packages/broapp-autoapp/src/react/pending.ts` as 17a left it: `announce`,
  `requestAlerts`.
- `docs/autoapp/components.md` and the `design` reference topic: the launcher's
  own UI is held to the same register.

## Fixed decisions

| Decision | Value |
|---|---|
| 1. Where it lives | A **screen, as the chat is one**, not an overlay: `OverviewScreen.tsx`. The main area has two views, `overview` and `chat`, and **`overview` is the first screen**: what the tab shows when it loads, every time — the choice is not remembered. A new **first** button on the rail ("Overview") shows it; **New conversation**, picking a conversation, and any action on the screen that leads to the engineer show the chat. The rail marks which of the two is current (`aria-current="page"`), and the Overview button carries the `needsYou` count and the existing waiting state. No scrim, no close button, no Escape: it is a place, not a dialog. |
| What it occupies | While the overview is the view it takes the grid areas of **both** the chat and the applications column (`chat` through `apps`), because it has its own Applications block and the mockup's two columns need the width; the applications column is not drawn beside it and its rail toggle is disabled with a title that says why. The conversations column keeps working: choosing one goes to the chat. Log, Knowledge, Backlog and Settings open over it exactly as they open over the chat. |
| The chat is never unmounted | `BroappChat` stays mounted while the overview is shown — hidden with the `hidden` attribute, not removed — because a turn may be streaming into it and its `controlsRef`, `onAwaiting` and `onBusy` must keep working. A test holds this: a turn started in the chat is still running, and still reports busy, after switching to the overview and back. |
| 2. The layout, from the mockup | Top to bottom: title and one line under it; a **summary strip** of four figures (needs attention, running now, queued tasks, spent today); the **attention band**, one row per `needsYou` item with one action each; then two columns — **Running now** on the left (wider), **Applications** on the right; then a **footer strip** (tokens today, current run, current task, "View usage"). Under 900px one column, the summary two by two; under 520px an attention row's action drops under its text. No horizontal scroll at 375. Same order, same grouping, same words as the mockup. |
| 3. The design system, and only it | Every colour is a `--launcher-*` variable that exists today; both schemes come from the variables and nothing is written per scheme in this screen's CSS. The mapping: page `ground`; cards `surface` with `border`; titles and figures `heading`; body `text`; labels and captions `muted`; the attention band `warn-surface` / `warn-border` / `warn-text`, and the attention figure in the summary `warn-text`; a failed item's mark and "needs review" `error-text` on `error-surface`; "building" and "serving" `good-text`; stopped `muted`; the stepper's done and current marks, progress fills and the one filled button `accent` with `accent-contrast`; tracks and dividers `border`; hover `hover`. **No new variable.** If something in the mockup cannot be said with these, use the nearest and list it in the report; do not add one. |
| Type | The launcher's font, as `body` sets it: the system sans stack. The mockup's serif is not used anywhere. Hierarchy comes from size and weight inside the scale `launcher.css` already uses; the large figures are the same family, larger, `font-variant-numeric: tabular-nums`. No web font, no `@font-face`, no network request. |
| One filled button | At most one `accent`-filled button on the screen: the first attention item's action when there is one, otherwise **Open preview** in Running now. Every other action is the launcher's outline button or a text link. "Stop run" is a text link, as in the mockup: it is there, and it is not what the eye lands on. |
| 4. Summary strip | **Needs attention**: the count, and under it the kinds ("1 question · 1 failed task"); `0` reads "Nothing needs you" and loses the warn colour. **Running now**: `1` and the application's name, or `0` and "Nothing is running". **Queued tasks**: the count across applications and the estimate when 17a gives one ("About 35 min remaining"), nothing when it is `null`. **Spent today**: see 6. |
| 5. Running now | The task's title as the card's heading, application and "Task 4 of 6" under it, the stage word with a dot top right. A four-step **stepper** (Reading, Editing, Building, Checking) from `stage`, an `<ol>` with `aria-current="step"`; it moves back when the stage does. Three figures: files changed, criteria passing ("1 / 3", labelled "Checks passing"), turn time. One line under them: "Last activity 38 seconds ago · attempt 1 of 2 · stops if quiet for 8 minutes" from `quietSince`, the attempt and `idleLimitMs`; when under a minute of quiet remains the line takes `warn-text`. When `lastRefusal` is set, one more line: the tool and the reason. Actions: Open preview, View details (opens the Backlog panel on this task), Stop run (the existing stop, with its existing confirmation if it has one). No run: the card says "Nothing is running" and offers **Open backlog**; it does not disappear, so the layout does not jump. |
| 6. Spend, said honestly | Dollars only where 17a returns a cost. `atLeast` is drawn as "≥" before the figure and the word "partial" after it, as the mockup's footer does. With `cost: null` the **Spent today** tile shows tokens ("1.4M tokens") and under it "No prices set", which opens the prices editor; with `unpricedTokens > 0` the line under the cost says how many tokens are not in it. The budget line ("of $10.00 budget · 22%") appears only when `budgetDay` is set, and at or over it takes `warn-text`. Never `$0.00` for something that ran. |
| Prices editor | "View usage" and "No prices set" open one small section inside this screen, not a panel: today's usage by model (tokens, cost or "no price"), and for each model two number fields, input and output price per million tokens, plus the daily budget, saved with `launcher.pricesSet`. Plain fields, the launcher's existing form styles, validation messages from the route. |
| 7. Applications | One row per application as the mockup has it: name, tasks done of total with a progress bar when it has an open intent (otherwise when it last changed), its state with a dot, and **one** action chosen by state — Open (serving or building), Review (needs review: opens the candidate or the failed task, whichever `needsYou` names), Start (stopped). "View all" goes to the chat view with the applications column open. |
| 8. Attention rows | Mark, title, detail, one action. A question shows its countdown from `expiresAt`, ticking once a second on this row only; its action opens the Backlog panel at the question. A failed task opens it at the task's advice. A candidate ready to activate opens the candidate panel; **this screen never activates anything itself**. An empty list collapses the band to one quiet line, "Nothing needs you". |
| 9. Alerts | One control in the screen's header: when the browser's permission is `default`, a text button "Turn on alerts" that calls 17a's `requestAlerts` — the only place permission is ever asked, and only on that click; the same click is the gesture that unlocks sound. `denied` shows one muted line saying notifications are blocked in the browser's settings; sound still works. Beside it a **Sound** switch (a real checkbox, labelled), on after that first click, remembered with the scheme's mechanism (`localStorage`, storage that refuses means off), and a text button "Test sound" that plays the tone once. `announce` runs for 17a's six events from successive reads — from `App`, not from this screen, so it keeps running while the chat is the view. |
| 10. Reading the route | Read by `App`, which owns the data and hands it to the screen: `launcher.overview` on load, then every 2 s while the overview is the view **and** the tab is visible, every 10 s while the chat is the view or the tab is hidden (for the rail's count, the title and the alerts — a hidden tab is exactly when an alert matters, so reading does not stop there). One request in flight at a time. A failed read keeps the last good data, shows one muted line "Could not refresh" and tries again at the next tick. Timers cleared on unmount. |
| 11. Accessibility and motion | Landmarks with labels as in the mockup; every control reachable and named; the focus ring the launcher already uses; the countdown and the "last activity" line are **not** live regions (they would speak every second) — the attention band is `aria-live="polite"` and announces only when its items change. No animation beyond the launcher's existing transitions, and none under `prefers-reduced-motion`. Contrast held by the existing check. |
| Not in scope | Charts or history over days; a compact strip above the chat; drag, reorder or customise; remembering which view was last shown; activating, answering or revising from this screen; more than one run; a second theme, a new token, a font. A row each in `docs/autoapp/backlog.md` for the first three, with what would justify it. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-theme.test.ts tests/autoapp-theme-browser.test.ts tests/autoapp-gate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run theme-check
bun run check
```

New tests, in `tests/autoapp-overview.test.ts` (or beside 17a's, if it made that
file), rendering the screen with a fake client that returns fixed
`launcher.overview` values:

1. An empty overview: "Nothing needs you", "Nothing is running" with **Open
   backlog**, no budget line, no estimate, and the layout's five regions all
   present.
2. A full overview (the mockup's data): every figure and word of the mockup
   appears, in its order.
3. Spend: `cost: null` shows tokens and "No prices set" and never a `$`;
   `atLeast` shows "≥" and "partial"; `unpricedTokens` is said; a budget at
   100% takes the warn class; no budget, no budget line.
4. The stepper marks the stage `aria-current`, marks earlier ones done, and
   moves back from `building` to `editing` between two reads.
5. Under a minute of quiet left, the activity line takes the warn class.
6. Exactly one element with the filled-button class, in each of: two attention
   items, none with a run going, none with nothing running.
7. Each attention row's action calls the handler that opens the right panel on
   the right record; nothing on this screen calls `launcher.activate`.
8. Application rows: Open, Review and Start by state; a progress bar only with
   an open intent.
9. "Turn on alerts" is present only for `default` permission, and
   `requestAlerts` is called by that click and by nothing else (a render, a
   read and an event do not call it). The Sound switch is off before that
   click, on after it, survives a reload, and is off when storage refuses;
   "Test sound" plays once.
10. Reading: 2 s while the overview is the view and the tab is visible, 10 s
    while the chat is the view and while the tab is hidden, never two in
    flight; a failed read keeps the data and says "Could not refresh". Use fake
    timers with generous margins.
11. The stylesheet: every colour in the screen's rules is `var(--launcher-…)`
    — no hex, no `rgb(`, no named colour, no `light-dark(`, no `@font-face`, no
    `font-family` other than the launcher's — asserted by reading the CSS; and
    no `--launcher-*` variable exists that did not before this prompt.
12. The views: Overview is the first rail button, shows the `needsYou` count,
    and is the view after the first render and after a reload whatever was
    showing before; New conversation and picking a conversation show the chat;
    the rail marks the current view; while the overview shows, the
    applications column is not in the document and its toggle is disabled.
13. The chat survives: a turn started in the chat is still running, still
    reports busy, and still shows its messages after switching to the overview
    and back; `BroappChat` is mounted exactly once across the three renders.
14. Log, Knowledge, Backlog and Settings open over the overview and close back
    to it.

By hand, no model needed: build the page as 0.4.10's note describes
(`bun run --cwd packages/broapp-autoapp build:page`, then run
`src/launcher/main.ts open --no-open` with `BROAPP_DATA_DIR` pointing at a
**copy** of a real root under the scratchpad — apps, launcher minus `ai`,
journal, never `launcher.json` — and delete it afterwards). Look at the screen in
light and in dark, at 1280 and 375 wide, with a run's data and with none, beside
the mockup. Then run the framework gate from section 2b — the design skill's
critique, audit and polish — on the screen, and fix what it finds that this
prompt allows. Record what you saw and what you changed.

## Acceptance criteria

- The launcher's first screen, a view beside the chat and not an overlay, says
  what needs the person, what is running and at what stage, what it has cost,
  what is left and what each application is doing, laid out as the mockup is.
- Switching between the overview and the chat never interrupts a turn.
- Every decision on it is one action that opens the place that decision is
  already made; the screen itself changes nothing.
- It is drawn entirely in the launcher's existing variables and font, in both
  schemes, with no new variable, palette or font, and a test holds it to that.
- No cost is shown that the person did not price, and no floor is shown as
  exact.
- Permission for alerts is asked only by a click, and sound can be turned off
  and tested.
- It reads the route no faster than every 2 s, and no faster than every 10 s
  when nobody is looking at it.
- No horizontal scroll at 375; keyboard-operable; the rendered contrast check
  green.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/17b-the-overview.md`: the mapping of each part of the
mockup to the variable it uses, and everything in the mockup the design system
could not say, with what was used instead; where 17a's route differed from this
prompt and which won; the by-hand look in both schemes and both widths, with
what the design gate found and what changed; the screen's size in the built page
before and after; and anything a person would still have to open another panel
to learn that they should not have to.

## Commit

```
Open the launcher on what needs you and what it is doing

The launcher opened on a chat and a list; what a run was doing, what it
had cost and what was waiting were spread over three panels or not shown.
An Overview screen, a view beside the chat and the first one shown, says
what needs the person, the running task with its stage and limits, spend as far as
it is known, what is left and each application's state, each with the one
action that opens where it is decided. It is drawn in the launcher's
existing variables and font, in both schemes; the chat stays mounted
behind it so a turn is never interrupted; and permission for alerts, and
sound with it, is asked only when its button is pressed.
```

End the commit with the co-author trailer your session's rules give you.
