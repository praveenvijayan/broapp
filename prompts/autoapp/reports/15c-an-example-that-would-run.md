# 15c — The valid input a builder is shown would really run

## What was built

- `engineer/tools.ts`: `INPUT_EXAMPLES` rewritten against `examples/notes` as it ships, and its
  doc comment's last sentence made true again. The comment now says what the examples are held
  to: parsed by the tool's own schema, and applied to a copy of `examples/notes` through the
  workspace functions the tools call. Nothing else in the file changed.
- `tests/autoapp-engineer.test.ts`, beside 14c's schema test (which stays): a `notesCopy()` of
  `examples/notes`' `src/` and `autoapp.json` in a temporary directory, a repository of its own;
  `applyExample()` applies an example as its tool does (`applyEdits`; `applyChange`; for the
  cycle, hunks, then the "already exists" check, then `applyChange`), and names the example and
  its files when it is refused. Six tests: the prompt's 1, 2 (three, one per source example),
  3, 4 (under 600 characters; the cycle example is **408**) and 5. A `scratch` list with its own
  `afterEach` removes the copies.
- `docs/autoapp/backlog.md`: one row (other tools' examples, and where a migration's SQL goes).

Run on the examples as they stood, 1, 2 ×3, 3 and 5 failed and 4 passed:
`migrations/002.sql` outside `WRITABLE`; `not found in src/host/db.ts: title TEXT NOT NULL.
Closest line 27: "     title      TEXT    NOT NULL,"`; the refused path again; `not found in
src/host/db.ts: …`; `…` in the cycle example; and `validateTask` refusing one criterion with no
failure path.

## Each example, before and after

| tool | before | after |
|---|---|---|
| `source.edit` | `src/host/db.ts`, `find: 'title TEXT NOT NULL'` (in no line of that file: it is written with column padding), replace adds a `done` column (Notes already has one) | `src/host/db.ts`, `find` the last line of the second migration, ``CREATE INDEX notes_pinned ON notes (pinned DESC, updated_at DESC);` ``+`,` (once in the file), replace appends a third migration, `` `ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`, `` |
| `source.change` | creates `migrations/002.sql` (refused: not under `src/`) | creates `src/shared/limits.ts`: a doc comment and `export const TITLE_MAX = 200;` |
| `candidate.cycle` | one hunk on `src/host/db.ts` with `find: '…'`, `replace: '…'`; creates `migrations/002.sql` with `content: '…'` | the `source.edit` hunk above, and creates `src/shared/limits.ts` with `export const TITLE_MAX = 200;`; 408 characters |
| `intent.task` | one criterion, no failure criterion and no `noFailurePath`: `validateTask` refused it | the same, plus `{ text: 'Marking a note that does not exist as done is refused with not_found', failure: true }` |

Checked beyond the tests, once each and then undone: with the edit applied to the real
`examples/notes/src/host/db.ts`, and separately with `src/shared/limits.ts` written into it,
`bunx tsc --noEmit` in `examples/notes` exits 0. `examples/notes` is unchanged
(`git status --short examples/` prints nothing).

## Where a migration really lives

In the application's own host code: `MIGRATIONS`, an array of SQL strings in `src/host/db.ts`,
applied in order against `PRAGMA user_version`. This holds for `examples/notes`, the starter
template and the test fixture. Its metadata (id, versions, checksum, description) is an entry in
`autoapp.json`'s `migrations`, with `schemaVersion` equal to the last one's `toSchemaVersion`.
There is no `migrations/` directory in any of them, and the workspace could not write one.

**Other text the engineer is shown that teaches `migrations/NNN.sql`: none.** Searched: the
instructions (`instructions.ts`: `autoapp.json` lists `migrations`; "Do not remove or edit an
existing migration"), every `spec.reference` topic (`reference.ts`: the `workspace` topic says
`migrations` are "appended, never edited" in `autoapp.json`, and that `src/host/app.ts` exports
`migrate`; the `intents` topic says a migration is its own task), every tool description in
`tools.ts` and `intent-tools.ts`, and the curated seeds (`seed.ts`, about the checksum and the
list being history). None names a `.sql` file or a `migrations/` path. `NNN-slug` appears only as
the id pattern in `spec/`. What is missing is the other half: nothing says the SQL goes in the
host code. The new `source.edit` example is now the only text that shows it. Recorded as a
backlog row, not changed here.

## Test 6: the local break

`examples/notes/src/host/db.ts` was edited once, by hand, to drop `, updated_at DESC` from the
`notes_pinned` index, and test 2 was run:

```
error: INPUT_EXAMPLES['source.edit'] does not apply to examples/notes (source.edit: src/host/db.ts): not found in src/host/db.ts: CREATE INDEX notes_pinned ON notes (pinn…. Closest line 39: "   CREATE INDEX notes_pinned ON notes (pinned DESC);`,"
error: INPUT_EXAMPLES['candidate.cycle'] does not apply to examples/notes (candidate.cycle: src/host/db.ts, candidate.cycle: src/shared/limits.ts): not found in src/host/db.ts: …
1 pass, 2 fail
```

Each failure names the example, its files and the line that no longer matches. The file was
restored from a copy, and `git status` shows it unchanged.

## Deviations, and decisions I made

1. **`intent.task` was changed**, as the fixed decision allows when `validateTask` refuses it:
   one failure criterion added and nothing else. Its topic (a done column Notes already has) was
   left alone, because the decision says to fix it so it passes, not to rewrite it. It teaches no
   path and no file layout, so nothing about it can be refused by the workspace.
2. **The cycle example's `create` has no doc comment** where the `source.change` one does. It
   keeps the cycle short, since the whole JSON goes into a refusal message.
3. **Test 5 reads the example as the tool does.** `INTENT_TASK_INPUT.parse`, then the tool's own
   defaults (`locks: []`, `risk: 'normal'`, `stub: false`), then `validateTask` with no siblings.
4. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Commands run

```
bun run typecheck                                                exit 0
bun test tests/autoapp-engineer.test.ts -t "valid inputs" (before)   2 pass, 6 fail
bun test tests/autoapp-engineer.test.ts tests/autoapp-intent.test.ts 84 pass, 0 fail
bun test tests                                                   981 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher             dist/broapp-autoapp 77.8 MB, exit 0
bun run check                                                    exit 0, 981 pass, 0 fail
git diff --stat tests/ai-chat.test.ts packages/broapp examples/  (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| A builder that copies any shown example exactly, into `examples/notes`, is not refused | pass (tests 2 ×3, 5; and each file typechecks in Notes) |
| No example teaches a path the workspace refuses or a layout the application does not have | pass (tests 1, 3; a migration is SQL in `src/host/db.ts`) |
| The test fails when an example and `examples/notes` drift apart | pass (test 6's local break, above) |
| No change to `packages/broapp`; `ai-chat` unchanged; `bun run check` green | pass |
