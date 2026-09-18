# 15c — The valid input a builder is shown would really run

## Goal

14c gave a builder whose call is refused twice for the same reason one valid
input to copy: `INPUT_EXAMPLES` in `engineer/tools.ts` (line ~470), held to each
tool's schema by a test "so an example cannot drift from the tool it describes".
The schema is not the only thing a call has to get past. Two of the four
examples create `migrations/002.sql`, and `engineer/workspace.ts` writes only
under `WRITABLE = /^(src\/|autoapp\.json$)/`. The engineer's own instructions
say so: "Do not write anywhere except `src/` and `autoapp.json`."

So a builder refused twice for the shape of `create` is shown an input of the
right shape, copies its path as readily as its shape, and is refused a third
time for a different reason. The `source.edit` example's `find`,
`title TEXT NOT NULL`, occurs nowhere in `examples/notes/src/host/db.ts`, the
file it names, so copied exactly it is refused as well. The cycle example also
sends `find: '…'` and `replace: '…'`, which a model can take for a convention
rather than a placeholder.

After this prompt every example is one that would be applied, to a workspace
that exists, and a test holds it to that.

Run this after 14d is merged. Independent of 15a and 15b.

## Read first

- `prompts/autoapp/00-common-rules.md`; report 14c, above all how the example
  came to be and what the `background-remove` replay showed.
- `packages/broapp-autoapp/src/engineer/tools.ts`: `INPUT_EXAMPLES`,
  `withExample`, `createInputMemory`, the input schemas above them, and the
  `source.edit`, `source.change` and `candidate.cycle` tools.
- `packages/broapp-autoapp/src/engineer/workspace.ts`: `READABLE`, `WRITABLE`,
  `within`, how a hunk is matched, the size limits on a hunk and a file.
- How a migration is really added to an application — where its SQL lives and
  what `autoapp.json` says about it — so the examples stop teaching a layout
  that does not exist. Read the starter template and `examples/notes`.
- The test that parses each example with its schema, in
  `tests/autoapp-engineer.test.ts`.

## Fixed decisions

| Decision | Value |
|---|---|
| One fixture | The examples are written against the Notes example, `examples/notes`, as it ships: real paths, and for a hunk a `find` that occurs exactly once in that file today. `appId: 'notes'` stays. |
| `source.edit` | Keeps its shape; its `find` must occur exactly once in the file it names. `title TEXT NOT NULL` occurs nowhere in the file it names today: change the example, not the application. |
| `source.change` | Creates a new file under `src/`, small and real — not a migration file. A few lines of TypeScript that would typecheck in that application. |
| `candidate.cycle` | One real hunk and one real `create`, both under `src/`, no `…` anywhere. It must be short: `withExample` puts it in a refusal message, so keep the whole JSON under 600 characters and say the number in the test. |
| `intent.task` | Unchanged unless a test below finds it would be refused by `validateTask`; if so, fix it to pass (it has one criterion today, and the plan asks for two to eight and a failure path). |
| The test | The existing schema test stays. Beside it: copy `examples/notes` (its `src/` and `autoapp.json`, as the evaluation's `notes` base does) to a temporary workspace and **apply** each example through the same workspace functions the tools call — the hunk lands, the file is created, nothing is refused. For `intent.task`, `validateTask` returns no problems. Do not build or preview in this test: applying is the claim. |
| The comment | The doc comment's last sentence becomes true again: say what the test now holds the examples to. |
| Not in scope | New examples for other tools; changing when an example is shown (15f does the counting); changing `WRITABLE`; changing `examples/notes`. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-engineer.test.ts tests/autoapp-intent.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

New tests:

1. Every path in every example matches `WRITABLE`.
2. Each of the three source examples applies to a fresh copy of
   `examples/notes` without a refusal, and the workspace revision moves.
3. No example contains `…`.
4. The cycle example's JSON is under the character limit above.
5. The `intent.task` example passes `validateTask`.
6. A change to `examples/notes` that makes an example's `find` stop matching fails test 2
   with a message that says which example and which file — check by breaking it
   locally once, and say so in the report.

## Acceptance criteria

- A builder that copies any shown example exactly, into `examples/notes`, is
  not refused.
- No example teaches a path the workspace refuses or a layout the application
  does not have.
- The test fails when an example and `examples/notes` drift apart.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/15c-an-example-that-would-run.md`: each example before
and after; where a migration really lives and whether any other text the
engineer is shown (instructions, `spec.reference` topics, tool descriptions)
teaches `migrations/NNN.sql` — list each place, change none outside this
prompt's scope; the local break of test 6.

## Commit

```
Show a refused builder an input that would really run

Two of the valid inputs shown after a second identical refusal created
migrations/002.sql, which the workspace refuses: only src/ and
autoapp.json are writable, and the edit's find matched nothing in the
file it named. The examples passed their schemas, which was all the test
asked. They are now written against examples/notes and the test applies
each one to a copy of it.
```

End the commit with the co-author trailer your session's rules give you.
