# 12k — A window on the knowledge layer

## What was built

- `knowledge/review.ts`: `confirmLesson`, `retireLesson`, `writeLesson`, each one
  transaction (lesson row, FTS row, corpus version; supersession for a write),
  and `insertLesson`, the one INSERT column list the distiller now also uses.
  `knowledge confirm|retire` call the first two; the serving-launcher refusal
  stays in `cli.ts`.
- `knowledge/window.ts`: the reads — `knowledgeTurns`, `knowledgeTurn`,
  `knowledgeLessons`, `knowledgeLesson`, `knowledgeCases`, `knowledgeCase`.
- Routes: six reads (`launcher.knowledgeTurns|Turn|Lessons|Lesson|Cases|Case`)
  and two writes (`launcher.lessonReview`, `launcher.lessonWrite`), each write
  logging one `log` event; `LauncherAppOptions` gains `knowledge` and `store`,
  passed by `tab.ts`; without a store every knowledge route is `unavailable`.
- `ui/KnowledgePanel.tsx` as the prompt specifies (rail `BookOpen`, three tabs,
  write/replace form, inline asks); Escape in `App.tsx`, skipped while a form
  field has focus; `launcher__k-*` styles on the four existing colour pairs.
- Docs (`learning.md`, README, backlog); tests 1–5 in `autoapp-review.test.ts`,
  6–10 under `12k: the Knowledge panel` in `autoapp-knowledge.test.ts`.

## Decisions I made

1. **The request of a turn.** The prompt says the Turns row takes it "from the
   `run` event's message". That message is `a turn ended: <status>`; the request
   is recorded only in a case's `request_blob`. Nothing new is recorded, so a row
   shows the request when the turn opened a case, otherwise the words of its
   `search` event, labelled `words:`. Recording the request (sanitised, capped)
   on the `run` event would be a one-line follow-up.
2. **Case counts** per turn come from `episodes.run_id` / `resolved_run_id`, not
   events: no event names a case opening. Edits, builds, checks come from events.
3. **Extra read route `launcher.knowledgeCase`** for the Cases view's detail.
4. **Confirm** applies to a provisional lesson, or a confirmed one carrying a
   review flag (clears it — the CLI allowed this, and `freshness.ts` documents
   confirm as how a flag is cleared). An unflagged confirmed lesson is a no-op
   returning `false` (test 1). The CLI's one visible change: a second `confirm`
   of an unflagged confirmed lesson prints `lesson N is already confirmed`, exit
   0, instead of writing a redundant corpus version. Every other row is identical
   (test 5 compares the CLI's rows with the functions').
5. **Limits:** summary ≤ 300 and trigger ≤ 300 as the prompt's form says, detail
   ≤ 2,000; stage ∈ build stages + `check`; routes/files ≤ 5 entries, ≤ 80/120
   characters, as `DIAGNOSIS`. The route schema is wider so the refusal comes
   from `writeLesson` as `invalid_input` naming the field (`summary: is required.`).
   Text is sanitised like the distiller's; replacing a non-served lesson is `conflict`.
6. The reads live in `knowledge/window.ts`, beside the store, not in `app.ts`.
7. Test 7's "no engineer tool names it": the engineer already has
   `knowledge.show`, a read. The test asserts that is the only knowledge/lesson
   tool and that its effect is `read`.

## The turns view over this machine's store

Read through `window.ts` on a `.backup` copy of
`~/Library/Application Support/broapp-autoapp/autoapp/launcher/knowledge.sqlite`,
so the launcher's retention on open touched nothing real. 21 turns, 2026-09-12
13:57 → 20:28 UTC, across `painting-app`, `shopping-list`, `shopping-app`,
`notes`, `note` and 3 with no application. **None was cut** (no document
`truncated`). 18 turns got `orientation` + `evidence` (190–377 bytes each);
3 got no documents; exactly **one** turn got a lessons document. Outcome chips
across all 21 rows: a single `none`. Edits in 7 turns, builds in 4. No turn has a
request (no cases were ever opened), so every row reads `words: …`; one row's
word list is empty. Lessons: the 7 seeds, confirmed, unflagged; cases: 0.

## What the panel made visible that the CLI hid

- In a day of real use the lessons were served once in 21 turns, and no build
  ever failed into a case, so the distiller has had nothing to learn from on this
  machine; `knowledge list` showed seven confirmed seeds and looked healthy.
- The request a turn answered is not stored unless a case opens (decision 1).
- Three turns were given no documents at all, and they are exactly the three
  for which serving chose no application (`contexts.app_id` is `NULL`).

## Page size

`launcher-page.html`: 1,303,106 bytes at HEAD, 1,328,312 now — **+25,206 (1.9%)**.

## Commands

| Command | Final status |
|---|---|
| `bun test tests/autoapp-review.test.ts` | 5 pass, 0 fail |
| `bun test tests/autoapp-knowledge.test.ts` | 67 pass, 0 fail |
| `bun run --cwd packages/broapp-autoapp build:page` | `launcher-page.html 1297.2 KiB`, exit 0 |
| `bun run --cwd packages/broapp-autoapp build:launcher` | `dist/broapp-autoapp 76.8 MB`, exit 0 |
| `bun run scripts/autoapp-smoke.ts` | `autoapp smoke: every step passed`, exit 0 |
| `bun install` / `bun run check` (includes `bun test tests packages`) | exit 0; 799 pass, 0 fail across 48 files |

## Open questions

- Should the `run` event carry the request (one sanitised field)?
- Impeccable passes not run: the launcher UI is not a renderer kind or panel component.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Panel opens from the rail; turns, lessons, cases from the launcher's store; each turn shows what was delivered, cut or not, and each served lesson's outcome | pass (tests 6, 7; real store above) |
| Confirm, retire, write, replace work from the panel, write the CLI's rows with a name and corpus version, take effect next turn | pass (tests 1–5, 7, 8) |
| No lesson text edited in place; a correction supersedes | pass (`review.ts` has no UPDATE of text; test 3, 8) |
| CLI behaviour unchanged; `tests/ai-chat.test.ts` unchanged | pass, with decision 4's one message; ai-chat untouched |
| `bun run check` green; every command exits 0 | pass |
