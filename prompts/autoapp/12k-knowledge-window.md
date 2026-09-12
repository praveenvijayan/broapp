# 12k — A window on the knowledge layer

## Goal

The knowledge layer records everything and shows nothing. What a turn was given,
which lessons were served and whether they helped, which cases opened and how they
were repaired, and what the distiller made of them: all of it is in
`knowledge.sqlite`, reachable only through `knowledge list|show` on the command
line and the log the tab gained in 0.4.10. A person who wants to see the loop
work, or to correct it, has to read SQL.

After this prompt: a **Knowledge** panel in the launcher's tab, opened from the
rail, with three views — the turns, the lessons, the cases — and the adjustments
a person is allowed to make: confirm a lesson, retire it, write a lesson by hand,
and replace a lesson with a corrected one. Every write goes through a launcher
route on channel `user`, records who did it and a corpus version, and is served on
the very next turn because the serve layer reads lessons from the database at each
turn (`serve.ts` `SELECT l.id, l.status …`, line ~319) and caches only the source
index. Nothing here changes what is served or how; it shows it, and it lets a
person do from the tab what `knowledge confirm|retire` do from the terminal.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far; 12b for what a turn
  is given, 12c for lessons and the CLI, 12d for servings' outcomes, 12j for the
  transcripts.
- `packages/broapp-autoapp/src/knowledge/{store,serve,cli,freshness,seed,evidence,log}.ts`.
  In `cli.ts`: `LessonRecord`, `LessonServing`, `LessonProvenance`, `showLesson`,
  `replayEvidence`, and the `confirm`/`retire` case of `runKnowledgeCommand`
  (line ~476), which is the write this prompt lifts out.
- `packages/broapp-autoapp/src/launcher/{contract,app,tab}.ts` — `launcher.eventsList`
  (0.4.10) is the pattern for a read route over the store; `options.log`.
- `packages/broapp-autoapp/src/launcher/ui/{App,LogsPanel,AppsTable}.tsx` and
  `launcher.css` — the rail, the overlay panels, the row-menu and inline
  confirmation patterns.
- `docs/autoapp/learning.md` in full; `docs/autoapp/components.md` (no modals).
- `tests/autoapp-knowledge.test.ts`: `makeWorld`, `storeLesson`, `handLesson`,
  `served`, the tab tests under `describe('the launcher tab')`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Where the writes live | New `knowledge/review.ts`: `confirmLesson(knowledge, id, by)`, `retireLesson(knowledge, id, by)`, `writeLesson(knowledge, input, by)`. The CLI's `confirm`/`retire` case calls the first two; its behaviour is unchanged (same rows, same corpus version, same FTS removal on retire, same refusal while a launcher serves from the root — that refusal stays in the CLI, not in `review.ts`, because inside the launcher there is nothing to refuse). |
| What a person may change | Confirm a provisional lesson; retire any lesson; write a curated lesson (`origin: 'curated'`, `status: 'confirmed'`, `scope`, `applies`, `summary`, `detail`, `trigger`); replace a lesson by writing a corrected one with `supersedes: <id>`, which marks the old one `superseded` and removes its FTS row, exactly as the distiller's supersession does. Nothing else: a lesson's text is never edited in place, so provenance and servings keep pointing at what was actually served. `method_unclear` lessons are shown and can be retired; they are never served, as before. |
| Who | Routes on channel `user`, effect `write`; input carries `by` (a name the person types once, remembered in `localStorage`, default `"tab"`). `reviewed_by` and `reviewed_at` are written as the CLI writes them. |
| Reads | `launcher.knowledgeTurns { limit?: 1..200, appId? }` → contexts newest first, each with: `runId`, `appId`, `at`, `corpusVersion`, the documents as `included` says (`ref`, `title`, `bytes`, `truncated`), the servings of that run (`lessonId`, `how`, `included`, `outcome`), and the run's counts from `events` (`edits`, `builds`, `checks`, `casesOpened`, `casesResolved`), and from `runs` if the launcher's run store is reachable (`steps`, `ms`, `status`), else `null`. `launcher.knowledgeTurn { runId }` → the same plus each included document's text from its blob (bounded at 20,000 characters each, the head kept), the instructions blob's `sha256` and length, the system blob's length. `launcher.knowledgeLessons { status?: provisional\|confirmed\|superseded\|retired, review?: boolean }` → rows with `id`, `status`, `review`, `origin`, `scope`, `applies`, `summary`, `createdAt`, `reviewedBy`, and served counts by outcome. `launcher.knowledgeLesson { id }` → `showLesson` minus nothing (the reviewer's name is the person's own business here) plus `replayEvidence`. `launcher.knowledgeCases { limit?: 1..200, appId? }` → episodes newest first: `id`, `appId`, `stage`, `signature`, `problem` (first 200 characters), `openedAt`, `resolvedAt`, `diagnosis`, `distillState`, `lessonId` (if one came of it), `edits` count. |
| The panel | A **Knowledge** item on the rail (icon `BookOpen` from `lucide-react`), an overlay like Settings and the log, width `min(56rem, 100%)`. Three tabs across the top: **Turns**, **Lessons**, **Cases**. State remembered in `localStorage`: the open tab and the reviewer's name. Refreshes when opened and on a **Refresh** button; no polling. |
| Turns view | One row per turn, newest first: time, application, the first 80 characters of the request (from the `run` event's message, or `request_blob` when the turn opened a case), a strip of small chips — `orientation`, `evidence`, `lessons ×n` (dimmed when `truncated`, absent when not included) — then counts `edits / builds / checks / cases`, and the servings' outcomes as chips (`resolved`, `recurred`, `blocked`, `inconclusive`, `unrelated`, `none`, `not included`). Opening a row shows each delivered document's text in a `<pre>` with its byte count and a *truncated* mark, and the lessons served with a link into the Lessons tab. This is the visualiser: a person reads down the column of chips and sees, turn by turn, what the loop delivered and what came of it. |
| Lessons view | Filter by status (default: provisional and confirmed) and *needs review*. Rows: id, status pill, review pill, origin, scope, summary, served counts as `resolved/recurred/other`. Opening a row: detail, trigger, applies, provenance (the case, its stage and problem, before/after revisions, the diagnosis and the distiller's reasoning), servings table, replay evidence lines, and the actions: **Confirm** (provisional only), **Retire**, **Replace** (opens the write form prefilled with this lesson's fields and `supersedes` set). A **Write a lesson** button above the list opens the same form empty. Retire and Replace ask inline (no modal) and say what changes: "This lesson stops being served; its servings and case stay." |
| The form | `summary` (≤ 300 chars, required), `detail` (≤ 2,000, required), `trigger` (≤ 300, required: the words a request would contain), `scope` (`global` or `app:<id>` chosen from the applications list), `applies` as three optional fields: `stage` (one of the build stages or `check`), `routes` (comma-separated), `files` (comma-separated). Validation mirrors what the distiller's `DIAGNOSIS` schema allows for a lesson; the route refuses with `invalid_input` naming the field. |
| Cases view | Rows: time opened, application, stage, the signature's first 80 characters, open/resolved, diagnosis, distil state, the lesson it produced. Opening a row: the problem in full, the request, edits appended while open, before/after revisions and releases, and a link to the lesson. |
| Nothing new is recorded | Reads write nothing. The three writes write what the CLI writes and one `knowledge` event each (kind `log`, level `info`, message `lesson 12 confirmed by pv`), through `options.log`. |
| Not in scope | Editing `instructions.ts`; turning documents or hints on or off from the tab; replay from the tab; deleting anything; an evaluation view; charts. The evaluation's two-turn table (12j) is its own report. |

## Step 1 — `review.ts`

The three functions, each one transaction: the lesson row, the FTS row
(insert for a written lesson; delete on retire and on supersession), the
`corpus_versions` row, and for `writeLesson` the `supersedes` handling. Reuse
`storeLesson`'s column list from the distiller (`distil.ts`) rather than a second
INSERT with a different shape. The CLI calls them.

## Step 2 — the routes

`contract.ts` and `app.ts`. The reads need the knowledge store: `LauncherAppOptions`
gains `knowledge?: Knowledge` beside `log`, and `tab.ts` passes it when it has one.
Without it every knowledge route answers `unavailable`, "This launcher keeps no
knowledge store." The run store's `runs` table is read for `steps`, `ms`, `status`
only when `options.store` is present (it is, in the tab).

## Step 3 — the panel

`ui/KnowledgePanel.tsx` with the three views as small components in the same
file; the rail button, overlay and Escape in `App.tsx` as for the log; styles in
`launcher.css` reusing `launcher__log-*` where the shape is the same and adding
`launcher__k-*` classes otherwise. Chips are `<span>`s with a class per outcome;
their colours come from the four existing pairs (`good`, `warn`, `error`, `quiet`).

## Step 4 — docs

`docs/autoapp/learning.md`: a new section **A window on it** after "Where",
saying what each view shows and what a person may change from it, and that the
CLI and the tab write the same rows. `packages/broapp-autoapp/README.md`: one
sentence. `docs/autoapp/backlog.md`: the "Lessons UI" line, if one exists, moves to
done; a row for "documents and hints on/off from the tab" as deferred.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-knowledge.test.ts
bun test tests/autoapp-review.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New `tests/autoapp-review.test.ts` (store in a temp dir, `handLesson` moved to a
shared helper or duplicated):

1. `confirmLesson` sets `status`, clears `review`, writes `reviewed_by`/`reviewed_at`
   and one corpus version; a second confirm is a no-op returning `false`.
2. `retireLesson` sets `retired`, removes the FTS row (an FTS query no longer finds
   it), writes a corpus version; `serve.search` on a request that matched it before
   no longer serves it, on a fresh serve over the same store.
3. `writeLesson` inserts a curated, confirmed lesson with its FTS row and corpus
   version; with `supersedes` the old lesson is `superseded` and gone from FTS, and
   the new one is served for the old one's trigger words.
4. `writeLesson` refuses an empty summary, a detail over 2,000, an unknown stage,
   and a scope that is neither `global` nor `app:<id>`, each naming the field.
5. The CLI's `confirm` and `retire` still produce the same rows (run the command
   function against the store and compare with 1 and 2).

In `tests/autoapp-knowledge.test.ts`, under `describe('the launcher tab')`:

6. After one fake-adapter turn, `launcher.knowledgeTurns` lists it with its
   documents (`digest:items`, `evidence:items`), `truncated: false`, edit/build
   counts matching the turn, and `launcher.knowledgeTurn` returns the digest's text
   equal to the blob the context row names.
7. `launcher.knowledgeLessons` lists the seeds as confirmed/curated; a stored
   provisional lesson shows served counts after a turn that included it;
   `launcher.lessonReview { id, decision: 'confirm', by: 'pv' }` on channel `user`
   confirms it and the next turn's documents still carry it; on channel `ai` the
   route is refused (there is no such tool, and the gate would ask; assert the
   effect is `write` and no engineer tool names it).
8. `launcher.lessonWrite` with `supersedes` replaces a seed: the next turn's lessons
   document carries the new summary and not the old.
9. `launcher.knowledgeCases` lists a case opened by a failing build in the harness,
   then resolved, with its `edits` count.
10. A tab built without a knowledge store answers `unavailable` on every knowledge
    route, and the panel's markup for that answer names the reason (render
    `KnowledgePanel` with `renderToString` and an error prop, as the AI Elements
    view tests do).

## Acceptance criteria

- The Knowledge panel opens from the rail and shows turns, lessons and cases from
  the launcher's own store; each turn's row makes visible what was delivered, cut
  or not, and what became of each served lesson.
- Confirm, retire, write and replace work from the panel, write the same rows the
  CLI writes with a name and a corpus version, and take effect on the next turn.
- No lesson's text is ever edited in place; a correction is a new lesson that
  supersedes the old.
- The CLI's behaviour is unchanged; `tests/ai-chat.test.ts` is unchanged.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12k-knowledge-window.md`. Include: a screenshot's worth
of description of the turns view over the real store on this machine (how many
turns, how many were cut, which outcomes appear); the byte size the panel adds to
the launcher page; and anything the panel made visible that the CLI had hidden.

## Commit

```
Open a window on the knowledge layer

A Knowledge panel in the launcher's tab shows, turn by turn, what the loop
delivered, whether it was cut, and what became of each served lesson; lists
the lessons with their servings and provenance and the cases with their
repairs; and lets a person confirm, retire, write or replace a lesson from
the tab, writing the same rows the command line writes, served on the next
turn.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
