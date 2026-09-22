# 20a — Working without asking

## What was built

- **The rule** moved to `src/engineer/standing.ts` (`INTENT_APPROVES`, `INTENT_REFUSES`, `StandingAnswer`,
  `standingAnswer`, unchanged) plus `standingCovers(tool, input)`. `executor.ts` re-exports the four.
- **The file**: `Layout.standing` = `<root>/standing.json`; `launcher/standing.ts` (`readStanding`,
  `writeStanding`, `clearStanding`); `launcher/standing-words.ts`, every sentence, no `node:` import.
- **Routes**: `launcher.standingGet` (read), `launcher.standingSet` (write, refuses off channel `user`,
  one `log` event per change); `launcher.overview` gains `standing`.
- **Core**: `StandInQuestion` (exported from `broapp/ai/host`), `standIn` on `CreateAiOptions` and `RunDeps`.
- **Tab**: the stand-in beside the executor, logging `the standing approval approved <tool> for <appId>`
  with app, run and call ids.
- **Card**: `standing` on `BroappChatProps`/`BroappChatViewProps`, a third button in `ToolApproval`,
  `grantThenAllow` (pure, exported), a rejected `grant()` shown where `confirmError` is.
- **Page**: `ui/StandingSettings.tsx` (`StandingSwitch`, `StandingSection`, `StandingLine`, `standingOfferFor`),
  wired in `App.tsx`; the Overview's muted line; `launcher__switch*`/`__standing*`/`__ov-standing` CSS.
- **CLI**: `broapp-autoapp standing [on|off]`, the `status` line, HELP.
- **Engineer**: step 3 and `candidate.cycle`'s description carry the sentence (instructions still 72 lines).
- **theme-check**: a launcher page (`scripts/theme-check/launcher.tsx`), three schemes, the switch off and on,
  the hint and the top-bar line, plus 3:1 for the switch's edge and knob.
- **Docs**: `security.md` "The person's standing approval" and the amended unanswered-question sentence,
  package README paragraph, troubleshooting entry, four backlog rows, `answeredBy` row amended.
- **Tests**: `tests/ai-standin.test.ts` (5), `tests/autoapp-standing.test.ts` (19), 4 in `ai-elements-view`.

## The `confirm` path in `createRunApprover`

Before: `ask` → `sink.emit({ type: 'confirm', … })` → wait on `deps.approvals.ask` under the turn's deadline.
After: `ask` first calls `deps.standIn?.({ runId, tool: route, input, requestId, callId })`. `true`/`false` is
returned at once — no event, nothing in the approval table; the gate records `confirmed`/`denied` as for a
click. `'defer'`, no hook, or a hook that throws (logged) takes the old path unchanged. `runId` is now passed
to `createRunApprover`, which is the one signature change.

**`Ai.turn`** needed nothing beyond not being given the hook: `runDeps` is built without `standIn`, and a
separate `chatDeps = { ...runDeps, standIn }` is what `ai.chat` runs on. A test proves `Ai.turn` asks its own
`answer` and never the hook.

## One cycle's records, switch on (by hand, `runs.sqlite`)

```
<run>:call_1.build    candidate.build    write  confirmed  succeeded
<run>:call_1.preview  candidate.preview  write  confirmed  succeeded
<run>:call_1.check    candidate.check    read   allowed    succeeded
<run>:call_1          candidate.cycle    write  confirmed  succeeded   caller ai:<run>
```

Here the cycle's own question was the card answered with **Allow, and stop asking** (so a person's
`chatConfirm`); build and preview came from the switch, and `knowledge.sqlite` holds exactly two
`the standing approval approved …` events (`call_1.build`, `call_1.preview`) after `the person turned
working without asking on`. In the tab test with the switch already on, all three are the switch's: six
`confirmed` rows and six log events for two cycles on `items` and `books`. A row is written when its step ends,
so the cycle's row follows its steps'.

## Settings, focus, and what the engineer says

The section, *The engineer*, sits between `AiSettings` and *Conversations*, divided by the drawer's
existing `section + section` rule. The drawer focuses its first control on open and gives focus back to its
opener on close; it has no trap, so the switch is simply in tab order after the AI settings. Playwright:
Tab from **Allow** lands on **Allow, and stop asking**, Enter turns it on; Space on the switch turns it off.

What the engineer says after a cycle with no card was **not observed on a real model** (no live-model run;
the by-hand model was scripted and said "Built and checked items."). What it is told is step 3's sentence.

## By hand (both schemes)

Compiled launcher, scratch root in `tests/.autoapp-run` with the fixture imported as `items`, and a
scripted OpenAI-compatible server on `127.0.0.1:11999` asking for one `candidate.cycle` (nothing left the
machine, no key). The card showed three buttons; the third turned the switch on, and the build and preview
ran with no card; the top bar read *Working without asking · Ask again*; the Overview line appeared; the
switch turned off removed `standing.json` and the top-bar line; `status` printed `standing: on since …`
while on. Screenshots in `reports/20a/`: `card-{light,dark}`, `topbar-{light,dark}`,
`switch-{on,off}-{light,dark}`.

**Seen, not changed:** the card's **Allow** has no primary fill on the launcher page (the launcher does not
style `.button--primary` in the chat), and the countdown read `10:01` once, a second over the window.
Both predate 20a.

## Where the fixed decisions were wrong, and what I did

1. **`<root>/standing.json` is not beside `prices.json`**, which lives in `<root>/launcher/`. The table
   says both; I followed "`<root>`, named in `layout.ts` beside journal and control".
2. **`standing` on `launcher.overview` is `s.optional(s.boolean())`, and present only when on.** As
   `s.boolean()` always present, 17a's `toEqual` over an empty root fails, and "with nothing turned on,
   every existing suite passes unedited" wins. The page reads absent as off.
3. **`status`'s line is printed only while on.** `standing: off` broke two exact-output tests in
   `autoapp-stop.test.ts`; same reason. `standing` still prints `off`.
4. **`writeStanding` keeps `since`** when the switch is already on, so "on since" means when it was first
   turned on.

## Decisions I made

- A stand-in that throws is `'defer'` and logged. The launcher's view tests went into
  `autoapp-standing.test.ts`, not `autoapp-overview.test.ts`: that file carries another session's
  uncommitted edits (below). The Settings drawer had no view test; the section's is there too.
- Section 2b: the card gained a button of the existing classes. The launcher switch is launcher UI, as in
  12k/13a/14c. `design-detect` is green, and theme-check measures both.
- Commit trailer names Claude Opus 5, per this session's rule. The report is just over 100 lines because of
  the records and the by-hand run the prompt asks for.

## Not mine, left in the working tree

When this started, the tree held another session's uncommitted overview redesign (`OverviewScreen.tsx`,
`launcher.css`, `tests/autoapp-overview.test.ts`). It went on changing during this work, and added
`packages/broapp-autoapp/DESIGN.md` and edits to `mockups/overview.html`. None of it is in this commit. My
two edits to those two files (the Overview line and import; the CSS block appended) were staged onto `HEAD`'s
versions. The redesign's `instanceof Node` (`OverviewScreen.tsx:331`) fails `autoapp-boundary`. That is its
fault, not this commit's; the commit was checked on its own (below).

## Commands

```
bun run typecheck                                        exit 0
bun test tests/ai-standin.test.ts                        5 pass, 0 fail
bun test tests/autoapp-standing.test.ts                  19 pass, 0 fail
bun test tests/ai-elements-view.test.tsx                 48 pass, 0 fail
bun test tests/autoapp-intent-run.test.ts                70 pass, 0 fail
bun test tests/autoapp-stop.test.ts (+ standing)         30 pass, 0 fail
bun run theme-check                                      9 combinations + launcher in 3 schemes, every rule passed
bun run design-detect                                    4 pages, no primary findings
bun run --cwd packages/broapp-autoapp build:launcher     dist/broapp-autoapp 78.5 MB
bun install && bun run check (working tree)              1196 pass, 1 fail (the redesign's instanceof, above)
bun install && bun run check (this commit alone)         exit 0, 1197 pass, 0 fail (index checked out to a scratch dir)
bun run theme-check (this commit alone)                   every rule passed
git diff --stat tests/ai-chat.test.ts                    (nothing)
```

## Acceptance

| Criterion | |
|---|---|
| Nothing turned on: suites unedited and green; cards have two buttons | pass (with deviations 2, 3) |
| Turned on by the card: a later cycle on any application shows no card, three `confirmed`, three log events; activation still a card | pass (tab tests; by hand) |
| Turned off from Settings mid-turn: the next question shows a card | pass (file-removed test; by hand) |
| Never answers activate, create, `standingSet`, external, no-application, `mcp`/`workflow` | pass (tests; source scan of readers) |
| A backlog run unchanged with the file present or absent | pass (in-process turn test; intent-run suite unedited) |
| `ai-chat` unedited; `check` and `theme-check` green; keyboard; switch state not colour alone | pass (check: on the commit alone) |
