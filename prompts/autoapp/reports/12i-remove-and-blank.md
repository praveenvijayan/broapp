# 12i — Remove an application, and create a blank one

## What was built

- `spec/layout.ts`: `Layout.trash` = `<root>/trash`. `AppLayout` unchanged.
- `launcher/remove.ts`: `describeRemoval` (releases, source, data bytes,
  snapshots, `data-prev` count), `removeApplication` (refuse while serving, stop
  a preview, one `renameSync`, journal row, clear the session and the candidate
  state, a `remove` event), `describeReceipt` for a terminal.
- `launcher/journal.ts`: phase `removed`, terminal, so `recover` never sees it.
- `launcher.appRemove` (`write`, input `{ appId, confirm }`, the receipt as
  output). The confirmation is checked in the route, not in the removal: it is
  about how the request arrived, and the command asks its own way.
- `broapp-autoapp remove <appId> [--yes]`: prints what would move, refuses
  without `--yes`, and refuses first if a running launcher answers `serving`
  over the control connection (new request type; `ControlClient.serving`).
- The panel: **Remove** on each row, disabled with "Stop it first" while
  serving, opening an inline confirmation in the table that enables only when
  the typed id matches. A notice afterwards names the trash path.
- `templates/autoapp-blank/`, packed beside the starter into
  `dist/templates.json` as `{ starter, blank }`. `dist/starter-template.json` is
  gone; `main.ts`, the dry run, `files` and `publish.yml` read the new name.
- `template: 'starter' | 'blank'` on `launcher.appCreate`, `create --template`
  and `apps.create`, default `starter`. `createApplication` takes `templates`.
- `CandidateStates.drop`, `Session.clear`, `EventKind` `remove`.
- Docs: design, security, packaging, backlog, both READMEs, `skills/broapp/SKILL.md`.

## What the prompt asked to be reported

**Did `defineContract` accept an empty contract?** Yes, and so did `parseSpec`:
both check the routes they are given and are content with none. So the blank
carries **no** `app.status` route — its contract is empty, its `start` registers
nothing, and the page is drawn entirely by the renderer's own routes from
`createAutoappHost`. A preview child of it reports schema version 0 and its one
acceptance example passes (`tests/autoapp-create.test.ts`, "builds, is current,
and its one example passes on a preview").

**The trash path format.** `trash/<appId>-<ISO instant, colons as hyphens>`,
e.g. `trash/empty-2026-09-12T14-01-22.731Z`. A colon is not a legal path
character on Windows and the launcher is built for Windows targets; the ordering
a person or a future `prune` reads out of the name is unchanged.

**The receipt from the smoke's removal.**

```
✓ remove — empty — 1 release, a source workspace, 0 bytes of data, 0 snapshots,
  0 previous data directories — moved to trash/empty-2026-09-12T14-01-22.731Z
✓ remove (serving) — refused while a launcher serves it
```

Zero bytes because that application was never opened; the unit tests cover a
non-empty one.

**What the second template adds to the binary.** 33,024 bytes: two compiled
binaries from the same tree, one with `blank.files` emptied (80,075,762) and one
as shipped (80,108,786). `dist/templates.json` grew from 27.5 to 41.0 KiB.

## Deviations, and decisions I made

1. **The blank's `views.ts` carries `__APP_NAME__`.** The starter keeps markers
   out of TypeScript because an unescaped name would break a literal; a blank
   page still has to be called something. `writeStarter` now encodes a `.ts`
   value the way it encodes a JSON one, and the marker sits in a double-quoted
   literal, where that encoding is exactly right. A test writes the blank with
   `A "difficult" \ name` and asserts the module still parses.
2. **No row menu.** The rows carry inline actions (Open, Stop), not a menu, so
   Remove is a third inline action.
3. **The confirmation lists what will move in words, not counts.** Counts come
   from `describeRemoval`, and a `read` route for them was not among the fixed
   decisions; the receipt afterwards carries the real numbers, and the command
   prints them before it asks because it can call the function directly.
4. **`workspace.ts` was not changed.** It never sees a template.
5. **The blank carries `PRODUCT.md`**, which the prompt did not list. It is what
   the engineer reads before writing a word of an interface, and the blank is
   the case where that matters most.
6. **The `remove` command clears the session file too**, which the prompt gave
   to the route only.
7. **The instructions lost a line elsewhere.** They gained the removal rule and
   the `template: "blank"` sentence, and a test caps them at seventy lines, so
   step 2 was rewrapped one line shorter. Every phrase a test pins is unchanged.
8. **The commit trailer names Opus 5**, not the Fable 5.1 in the prompt's
   message: this session's attribution instruction replaces it.
9. **`docs/autoapp/backlog.md` is not in this commit.** Another session on this
   branch committed `9df7c23` while this prompt was in progress, and the backlog
   edits for 12i were in the working tree then and went in with it.

## Commands run

```
bun run typecheck                                     exit 0
bun run --cwd packages/broapp-autoapp build:template  templates 41.0 KiB
bun test tests/autoapp-create.test.ts                 21 pass 0 fail
bun test tests/autoapp-remove.test.ts                 13 pass 0 fail
bun test tests/autoapp-{engineer,gate}.test.ts        83 pass 0 fail
bun test tests                                        758 pass 0 fail, 46 files
bun run --cwd packages/broapp-autoapp build:launcher  dist/broapp-autoapp 76.4 MB
bun run scripts/autoapp-smoke.ts                      every step passed
bun run dryrun:autoapp                                Autoapp dry run passed
bun install && bun run check                          exit 0
```

One thing the tests taught: `Bun.spawnSync` cannot drive the `remove` command
from a process that is also answering its control connection — the synchronous
spawn holds the event loop, the child's question is never answered, and both
wait for ever. The test uses `Bun.spawn`.

## Acceptance criteria

| Criterion | |
|---|---|
| A person removes from the panel or the command line by typing its id, and finds every byte under the trash | pass |
| Nothing removes while serving; the engineer has no way to remove anything | pass |
| **New application** offers items or blank, the same choice on the command and the tool, default unchanged | pass |
| The smoke creates one of each | pass |
| `bun run check` is green; every command above exits 0 | pass |

## Open questions

- Restoring from the trash is the inverse rename and has no command; emptying it
  belongs to `prune`, which now owns "and `trash/`, oldest first, never younger
  than seven days". Nothing in the launcher deletes from it, and a test greps.
- The panel cannot say how many releases or bytes would move before they move.
