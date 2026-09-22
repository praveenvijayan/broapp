# 20a — Working without asking

## Goal

Every edit, build and preview the engineer makes in a chat turn is a question
the person has to click. Report 08b measured the cost of that arithmetic once
(a two-minute window after ten minutes of thinking); 12m's strip and the
600-second window reduced it; but on 2026-09-22 a person told the engineer three
times in the conversation to go ahead, the card was never clicked, and
`candidate.cycle` was declined three times. Typing "proceed" is not an answer.
The card is, and it arrives when the person has walked away.

The backlog run already has the shape of the fix: a **standing answer** that
approves an application's edits, builds and previews without asking and brings
everything else to the person (13c, `standingAnswer` in
`src/intent/executor.ts`). After this prompt a person can give the engineer's
own conversation the same standing approval with **one switch for the whole
launcher**, and take it back:

- **In the card.** Beside *Allow* and *Decline*, a third choice when the
  question is one the standing approval would cover: **Allow, and stop
  asking**. One click answers this question and every later one like it, for
  every application.
- **In Settings.** A switch, **Work without asking**, in the launcher's own
  Settings drawer, under a new section, so what is on is visible without
  opening a conversation; the same word in the conversation's top bar while
  it is on, with **Ask again** beside it.
- **At the command line.** `broapp-autoapp standing [on|off]`.
- **Recorded.** The gate still asks every question and records every answer;
  the launcher's log carries one event per answer the standing approval gave,
  as it does for a run's.

What it never covers, however it was turned on: `release.activate`,
`apps.create`, removal, `launcher.folderChoose`, `launcher.standingSet` itself,
anything `external`, a listed tool whose input names no application, the `mcp`
and `workflow` channels, and an application's own chat in its own tab. Those
ask exactly as today.

A person who never touches it sees nothing change: no file is written, every
question is asked, and the card has two buttons.

## Read first

- `prompts/autoapp/00-common-rules.md`. Reports 13c, 17a and 18a, whole:
  13c for how the run's stand-in answers, defers and logs; 17a for how a core
  option was added to `run.ts` and `create-ai.ts` additively and how
  `prices.json` is a launcher-level file the person writes; 18a for how a
  launcher-level setting is read as it stands and written whole.
- `packages/broapp/src/host/gate.ts` (`decide`, `guard`), `approvals.ts`
  (`'defer'` is not a table concept: a deferred question simply stays in it),
  `ai/host/run.ts` (`RunDeps`, `createRunApprover`, `buildTools`) and
  `ai/host/create-ai.ts` (`CreateAiOptions`, `InProcessTurnOptions.answer`,
  `turn`, `ai.chatConfirm`). The stand-in you add sits in `createRunApprover`,
  before the `confirm` event is emitted.
- `packages/broapp-autoapp/src/intent/executor.ts` ~40–70 and ~160–185
  (`INTENT_APPROVES`, `INTENT_REFUSES`, `StandingAnswer`, `standingAnswer`),
  ~800–812 (`note`), ~945–975 (`answerFor`) and ~1100–1135 (`hostBuild`'s own
  approver). The chat's stand-in is the same list with two differences, below.
- `packages/broapp-autoapp/src/launcher/tab.ts` ~280–460: where `createAi`,
  `engineerTools` and the executor are built, what `knowledge.log` is, and
  where `LAUNCHER_CONFIRM_TIMEOUT_MS` is passed. `src/launcher/app.ts` ~690–720
  (`launcher.grantsGet`/`grantsSet`) for the shape of a get and a set;
  `launcher.pricesGet`/`pricesSet` (17a) for a **launcher-level** file with
  two routes — the closer pattern, with `src/intent/prices.ts` (`PRICES_FILE`,
  `readPrices`, `writePrices`) for how that file is read and written in the
  launcher's data directory. `src/spec/layout.ts` ~145–155: where the root's
  own files (`journal.sqlite`, `launcher.json`) are named.
- `src/engineer/tools.ts` ~1385–1520: `candidate.cycle`, whose inner steps ask
  under `<requestId>.build` and `<requestId>.preview` through the same
  approver, so one stand-in covers them; and ~283–325 (`wasDeclined`,
  `tellingExpiry`). `src/engineer/instructions.ts`: step 3's "asking the person
  at each" and the test that holds the five headings.
- `packages/broapp-ai-elements/src/ui/BroappChatView.tsx` ~112–160
  (`ToolApproval`) and ~200–260 (where it is drawn from a part's descriptor),
  `BroappChat.tsx` (`BroappChatProps`, `onConfirm`), `use-broapp-chat.ts`
  (`confirm`, `confirmError`), and `tests/ai-elements-view.test.tsx` for how a
  card is rendered and clicked in a test.
- `src/launcher/ui/App.tsx` ~160–200 (the strip and `onAwaiting`), ~689 (the
  `BroappChat`), ~722–740 (the top bar), and ~855–930 (the Settings drawer:
  `AiSettings`, then the launcher's own *Conversations* section — the new
  section goes between them). `src/launcher/contract.ts` ~827–905
  (`launcher.overview`, the prices routes).
- `src/launcher/main.ts`: the `status` command (~1130) and how a command with
  an optional argument is parsed and printed, so `standing` looks like its
  neighbours.
- `docs/autoapp/components.md`, "One set of controls": the switch.
  `packages/broapp/src/ai/react/AiSettings.tsx` ~305 and ~519 draw one
  (`role="switch"`); the launcher's own page draws none today. Draw this one
  the same way, in the launcher's classes.
- `docs/autoapp/security.md` "Approvals" and "A run answers for the person";
  `packages/broapp-autoapp/README.md` ~44–55; `docs/troubleshooting.md`'s
  Autoapp entries.

## Fixed decisions

| Decision | Value |
|---|---|
| The rule | One module, `src/engineer/standing.ts`, holds `INTENT_APPROVES`, `INTENT_REFUSES`, `StandingAnswer` and `standingAnswer`, moved from `executor.ts` unchanged, and one new pure function, `standingCovers(tool: string, input: unknown): boolean` — `true` when the tool is in `INTENT_APPROVES` and `input.appId` is a non-empty string. `executor.ts` re-exports the four it had, so nothing that imports them from there changes. |
| The two differences from a run | A run approves only calls naming **its** application; the person's switch covers **every** application, which is what `standingCovers` says. A run **refuses** `release.activate` and `apps.create`; the person's switch **defers** them, so the person is asked as today. The standing approval only ever answers `true` or nothing. |
| The file | `<root>/standing.json`, beside `prices.json`: `{ "version": 1, "standing": true, "since": <ms> }`. Absent, unreadable, not version 1, or `standing` not `true` all read as **off** (a warning for the unreadable case, once per read, nothing for absent). Written atomically through the helper the root's other files use; turning it off **removes** the file rather than writing `false`, so a launcher that was never touched and one that was turned back off look the same on disk. `layout.ts` names it beside `journal` and `control`. Nothing per application. |
| Read every time | The stand-in reads the file at each question. No cache: the switch flipped in Settings or at the command line answers the next question, and nothing in memory can disagree with the disk. A question already waiting when the switch is turned on stays waiting; its card is still the answer. |
| The routes | `launcher.standingGet`, effect `'read'`, input `s.void()`, output `{ standing: s.boolean(), since: s.nullable(s.number()) }`. `launcher.standingSet`, effect `'write'`, input `{ standing: s.boolean() }`, same output. `launcher.overview` gains `standing: s.boolean()` at the top level, additively, so the overview screen needs no second read. There is **no engineer tool** for either route, and `INTENT_APPROVES` is closed: the standing approval cannot approve the call that would widen it. A test holds both. |
| The core hook | `CreateAiOptions` and `RunDeps` gain `standIn?: (question: StandInQuestion) => boolean \| 'defer'`, where `StandInQuestion` is `{ runId, tool, input, requestId, callId }` (export it beside `InProcessQuestion`). `createRunApprover` calls it before emitting `confirm`; `true` or `false` resolves the question without a `confirm` event and without the approval table (the gate records `confirmed` or `denied` exactly as for a click); `'defer'` or no hook is today's path. `Ai.turn` passes `runDeps` **without** `standIn`: an in-process turn has its own `answer`, and the executor's rule is not to be answered twice. `tests/ai-chat.test.ts` is untouchable and must stay green unedited; the option is optional and absent there. |
| Where the stand-in lives | `tab.ts`, beside the executor's `answerFor`: read the file; off → `'defer'`; on and `standingCovers` → `true`; on and not covered → `'defer'`. On `true`, one `log` event through `knowledge.log`, worded `the standing approval approved <tool> for <appId>`, with `appId` (from the input), `runId` and `callId`, exactly as `note` writes a run's. Without `knowledge`, nothing is logged and the answer still stands. |
| The card | `BroappChatProps` gains `standing?: (call: { callId: string; tool: string; input: unknown }) => { label: string; grant(): Promise<void> } \| null`. `ToolApproval` draws a third button, secondary weight, with that label, only when the function returns non-null. Clicking it awaits `grant()` and then answers the question `true` through the existing `onConfirm`; a `grant()` that rejects shows its message where `confirmError` is shown and leaves the card, with both buttons, in place. Not in the transport, not in the descriptor: the panel asks the surrounding application, which is the only thing that knows what "always" means. |
| What the launcher hands the card | Non-null only when `standingCovers(tool, input)` and the switch is off; the label is `Allow, and stop asking`. `grant()` calls `launcher.standingSet({ standing: true })`. On channel `user`, so it is not asked about; Settings and the command line call the same route. |
| Settings | A new section between `AiSettings` and *Conversations*, titled **The engineer**, holding the switch **Work without asking** and its hint: *Edits, builds and previews of any application are approved for the engineer without asking. Activation, creating or removing an application, and anything that reaches outside still ask.* Checked from `launcher.standingGet` on open; while the write is pending the switch is disabled, not optimistic; a refusal is a sentence beside it. |
| The top bar | While the switch is on, one line in the conversation's top bar, before the status: `Working without asking` with an **Ask again** link that calls `launcher.standingSet` off. Read from `launcher.overview.standing`, which the tab already polls, and re-read after the switch or the card changes it. The strip, the title count and the notification are untouched: a question the standing approval answers never becomes one of them. |
| The overview | `standing` is drawn as one muted line under the summary strip, `The engineer works without asking`, and nothing else changes: it is not an attention item. |
| The command line | `broapp-autoapp standing` prints `on since <date>` or `off`; `standing on` and `standing off` write and print the same; `status` with no application gains one line, `standing: on since <date>` or `standing: off`. |
| Words | `src/launcher/standing-words.ts`, no `node:` imports, holds every sentence the page shows: the section title, the switch's label, the hint, the card's label, the top bar's line, the link, the overview line, and the refusals. The page and the routes import them; nobody writes a second copy. |
| What the engineer is told | `instructions.ts` step 3: "asking the person at each" becomes "asking the person at each, unless they have turned on working without asking, in which case those answers come at once and you are not told which". `candidate.cycle`'s description, the same sentence in fewer words. The five headings and their test do not change. No new tool, and the engineer is never told to ask for the switch: a model that asks for fewer questions is asking for trust, and that is the person's to offer. |
| Channels | `mcp` and `workflow` do not consult the file. An application's own `AiChat` in its own tab does not consult it. `hostBuild`'s own approver in the executor is unchanged. |

## Steps

1. **The rule moves**, and `standingCovers` is added. `src/engineer/standing.ts`;
   `executor.ts` imports and re-exports. `bun test tests/autoapp-intent-run.test.ts`
   unchanged and green.
2. **The file and its routes.** `layout.ts`; `src/launcher/standing.ts`
   (`readStanding`, `writeStanding`, `clearStanding`, each taking `Layout`,
   shaped as `prices.ts` is);
   the two routes in `contract.ts` and `app.ts`; `standing` on
   `launcher.overview` in `overview.ts`. Tests for every reading of the file
   listed under *The file* and for the output fields.
3. **The core hook.** `StandInQuestion`, `standIn` on `CreateAiOptions` and
   `RunDeps`, consulted in `createRunApprover`; `Ai.turn` strips it. A test in
   a new `tests/ai-standin.test.ts` using `fake.ts`: with `standIn` returning
   `true`, a write tool runs with no `confirm` event and the gate's record says
   `confirmed`; returning `false`, the tool result is the declined result and
   the record says `denied`; returning `'defer'`, the `confirm` event is
   emitted and `ai.chatConfirm` answers it; `Ai.turn` with `standIn` set still
   asks its own `answer` and never the hook.
4. **The stand-in in the tab**, with its log event. Tests in a new
   `tests/autoapp-standing.test.ts`, on the real launcher tab as
   `autoapp-engineer.test.ts` drives it: switch on, a chat turn's
   `candidate.cycle` — the patch, its `.build` and its `.preview` — runs with
   no `confirm` event and three `confirmed` records, for either of two
   applications; `release.activate` and `apps.create` emit `confirm` and are
   **not** refused; a tool outside the list emits `confirm`; a listed tool with
   no `appId` in its input emits `confirm`; switch off is today, event for
   event; the file removed between two questions changes the answer without a
   restart; one `log` event per approved question with the words above; a
   backlog run behaves exactly as before with the file present and absent,
   including deferring a listed tool that names another application.
5. **The card.** `standing` on `BroappChatProps`, the third button in
   `ToolApproval`. `tests/ai-elements-view.test.tsx`: no third button without
   the prop or when it returns null; with it, the label; clicking awaits
   `grant()` then confirms `true`; a rejecting `grant()` shows the message and
   keeps the card. `bun run check` green.
6. **The launcher's page.** The card's `standing` function, the Settings
   section and switch, the overview line, the top bar's line and link,
   `standing-words.ts`. The existing view tests for the overview and for
   Settings (add one if the drawer has none) gain the switch and the line.
   `theme-check` gains the switch: the launcher had none.
7. **The command line** and `status`'s line.
8. **Words for the engineer**, docs, report, commit.

## Acceptance

- With nothing turned on, every existing suite passes unedited, and a chat
  turn's questions arrive as cards with two buttons.
- Turned on by the card, a following `candidate.cycle` from any conversation on
  any application shows no card, its three gate records say `confirmed`, and
  the launcher's log has three events naming the standing approval. The same
  turn's `release.activate` shows a card.
- Turned off from Settings while a turn runs, the next question shows a card.
- The stand-in never answers `release.activate`, `apps.create`,
  `launcher.standingSet`, anything `external`, a listed tool naming no
  application, or a question from `mcp` or `workflow`.
- A backlog run's behaviour is unchanged with the file present or absent.
- `tests/ai-chat.test.ts` is unedited and green. `bun run check` and
  `theme-check` green. Everything reachable by keyboard and announced; the
  switch's state is not colour alone.

## Not in scope

Backlog rows, not built: a per-application switch (this prompt's first draft;
kept as a row in case one application should stay guarded); a standing
approval that expires (an hour, a day); a per-tool list the person edits; the
same for the `mcp` channel (13c's row on elicitation is the place);
`answeredBy` on the gate's record (backlog row already there: this prompt adds
"the standing approval" as a third kind that row would name).

## Docs

`docs/autoapp/security.md`: a new section, "The person's standing approval",
after "A run answers for the person", with the list it covers, the list it
never covers, the file, that every answer is still asked and recorded, and the
log line; the sentence "An unanswered question is a **denial**, not a pause.
Nothing runs unattended." gains "…unless the person has turned on working
without asking, and then only what that covers."
`packages/broapp-autoapp/README.md`: one paragraph after the Backlog one.
`docs/troubleshooting.md`: a new entry, "The build was declined although I
told the engineer to go ahead" — a message in the conversation is not an
answer; the card's Allow is, or the switch. `docs/autoapp/backlog.md`: the
rows from *Not in scope*. `prompts/autoapp/README.md`: the 20a row.

## Report

`prompts/autoapp/reports/20a-working-without-asking.md`: the exact `confirm`
path in `createRunApprover` before and after; whether `Ai.turn` needed more
than dropping the option; what the three records of one `candidate.cycle`
look like in `runs.sqlite` with the switch on; where the Settings section sits
and how the drawer's focus handling took it; what the engineer says now when
a cycle runs without a card; the by-hand run in both schemes with a screenshot
of the card's three buttons and of the switch; and anything in *Fixed
decisions* you found wrong, with what you did instead and why — do not
quietly differ.

## Commit

```
Let a person turn off the questions for the engineer's edits and builds

Every edit, build and preview the engineer made was a question, and a
question asked after minutes of thinking was asked of a tab nobody was
looking at; saying "go ahead" in the conversation answered nothing. The
backlog run already had a standing answer for exactly these calls. One
switch now gives the engineer's own conversations the same one, for
every application: from the card, with a third button, from Settings,
or at the command line. It covers edits, builds and previews and
nothing else; activation, creation, anything external and the other
channels ask as they did. The gate still asks every question and
records every answer, and the launcher's log says which ones the
standing approval gave. Turned off, the file is gone and nothing is
different.
```

End the commit with the co-author trailer your session's rules give you.
