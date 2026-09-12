# 12i — Remove an application, and create a blank one

## Goal

The control panel can create, open and stop an application and cannot remove one.
Creation made applications cheap (prompt 11), and cheap things accumulate; the
backlog has carried a `remove` row since then with its rules already decided: list
what would go, require an explicit yes, refuse while the application is serving, and
never remove data without saying that is what is being removed.

The **New application** button writes one starter, an items list with a table and a
form. (It is not Notes; Notes is an example in this repository.) A person who wants
to describe their application to the engineer from nothing gets a list they must
first ask it to take apart.

After this prompt: a person can remove an application from the panel and from the
command line, its directory moved to a trash the launcher never empties on its own,
and its name typed to confirm; and **New application** offers a choice, the items
starter or a blank application with one empty page, the same choice on the `create`
command and the engineer's `apps.create` tool.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far; 11's for how a route,
  a command and a tool share one implementation, and for the starter's packing.
- `docs/autoapp/backlog.md` — the `remove` and `prune` rows.
- `packages/broapp-autoapp/src/launcher/{apps,app,contract,create,workspace,starter,main}.ts`,
  `supervisor.ts` (`serving`, `stop`), `keepalive.ts`, `journal.ts`, `control.ts`.
- `packages/broapp-autoapp/scripts/build-template.ts`, `build-launcher.ts`,
  `package.json` (`files`), `.github/workflows/publish.yml`, `scripts/autoapp-dry-run.ts`,
  `scripts/autoapp-smoke.ts` (the `create` step).
- `packages/broapp-autoapp/src/spec/{layout,validate,types}.ts` — what a
  specification with no migrations, no operations and no acceptance examples needs.
- `packages/broapp-autoapp/src/engineer/{tools,state,instructions}.ts`,
  `knowledge/session.ts`.
- `packages/broapp-autoapp/src/launcher/ui/{App,AppsTable,CandidatePanel}.tsx`.
- `templates/autoapp-starter/` in full, `tests/autoapp-create.test.ts`,
  `tests/fixtures/autoapp-app/`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Removal moves, never deletes | `launcher.appRemove` renames `<root>/apps/<appId>` to `<root>/trash/<appId>-<ISO timestamp>/` with one `renameSync`, so nothing is copied and nothing can be half-gone. The trash is never emptied by the launcher; the `prune` row gains "and `trash/`, oldest first, never younger than seven days". `AppLayout` gains nothing; `Layout` gains `trash`. |
| Who may remove | A person: the route on channel `user`, and the `remove` command. **No engineer tool.** A model asking to delete an application is not a request this launcher relays; the instructions' "what you may not do" gains one line. |
| Refusals | Serving (a live child, or `keepServing` on it): `unavailable`, "stop it first". A preview running: stopped by the removal after the person confirmed, and said in the receipt. Unknown id: `not_found`. A `confirm` that does not equal the id: `invalid_input`. |
| Confirmation | Input `{ appId, confirm }`; `confirm` must equal `appId`, typed by the person. The route's `effect` is `write`. The person's own click runs it; through MCP or a workflow the gate asks, as for any write. |
| What it says | The receipt lists what moved: release count, whether a source workspace existed, data directory bytes, snapshot count, `data-prev` count, and the trash path relative to the root. The journal keeps its rows; `journalList` for a removed application still answers, and `appsList` no longer lists it. `session.selectedAppId` is cleared if it named the application; `CandidateStates` drops its entry. Knowledge rows scoped to the id stay; lessons scoped `app:<id>` are retired by nothing, listed by `knowledge list` as before. |
| The command | `broapp-autoapp remove <appId> [--yes]`: prints what would move, then `refused: pass --yes to move it to trash` and exits 1 without `--yes`; with it, moves and prints the receipt. Refuses while `launcher.json` names a live launcher that is serving the application, by asking it over the control connection whether it is. |
| The panel | A **Remove** action on the selected application's row menu. Disabled with a reason while serving. Opens an inline confirmation (no modal: the strategy document says so) listing what will move and a field for the id; **Remove** enables only when the field equals the id. On success the row disappears and a one-line notice names the trash path. |
| Two templates | `templates/autoapp-blank/` beside `templates/autoapp-starter/`. Packed by the same script into `dist/templates.json`, `{ starter: StarterTemplate, blank: StarterTemplate }`; `dist/starter-template.json` is gone and every reader of it changes (`main.ts`, the dry run, `publish.yml`, `files`). |
| What blank is | `autoapp.json`: `schemaVersion: 0`, `migrations: []`, `capabilities: []`, one acceptance example with one view step, `{ view: { page: 'home' } }` — the page is declared, and nothing else is claimed. `src/shared/contract.ts` exports a contract with **no operations and no streams**; verify `defineContract` and `parseSpec` accept it, and if either does not, the report says which and the blank carries a single `read` route `app.status` returning `{ ok: true }` instead, with the acceptance example calling it. `views.ts`: one page `home`, title `__APP_NAME__`, no sources, one `text` component `welcome`: "Nothing here yet. Tell the engineer what this application should do." `src/host/app.ts`: `start` registers nothing (or the one route), `migrate` is a no-op that reports version 0. `src/ui/`: the starter's. README: three lines. Markers as the starter's. |
| The choice | `launcher.appCreate`, `create` and `apps.create` gain `template: 'starter' \| 'blank'`, default `starter`, so nothing existing changes. The panel's form gains two radio choices above the name: *Items list — a table and a form to start from* and *Blank — one empty page; describe what it should do to the engineer*. `createApplication` takes `templates` and picks. The engineer's `apps.create` description names both; the instructions' sentence about creation gains "blank when the person describes something that is not a list". |
| Not in scope | `prune`; emptying the trash; restoring from trash (a `restore` is the inverse rename and can wait for a request); removing over MCP; a third template. |

## Step 1 — the trash and the route

`spec/layout.ts`: `trash: join(root, 'trash')`. `launcher/remove.ts`:

```ts
export interface RemovalReceipt {
  readonly appId: string;
  readonly trashPath: string;          // relative to the root
  readonly releases: number;
  readonly hadSource: boolean;
  readonly dataBytes: number;
  readonly snapshots: number;
  readonly dataPrev: number;
  readonly previewStopped: boolean;
}
export function describeRemoval(layout: Layout, appId: string): Omit<RemovalReceipt, 'trashPath' | 'previewStopped'>;
export async function removeApplication(deps: { layout; supervisor; states; session; journal; logger }, appId: string): Promise<RemovalReceipt>;
```

`removeApplication` refuses when serving, stops a preview, renames, clears the
session and the candidate state, writes one journal row of a new phase `removed`
(the journal's phase union gains it; `recover` ignores it), and logs an `activate`-kind
event? No: a new event kind `remove` with the receipt's numbers, allow-listed.

`contract.ts` + `app.ts`: `launcher.appRemove` (`write`) with input `{ appId, confirm }`
and the receipt as output; `launcher.appsList` unchanged. `main.ts`: the command.

## Step 2 — the panel

`AppsTable.tsx`: the row menu, the inline confirmation, the typed id, the notice.
`App.tsx`: on success, refresh the list and clear the selection.

## Step 3 — the blank template

`templates/autoapp-blank/` as decided. `scripts/build-template.ts` packs both;
`StarterTemplate` stays the per-template shape; `Templates = { starter, blank }`.
`starter.ts`, `create.ts`, `workspace.ts`, `main.ts`, `tab.ts`, `tools.ts`: the
`template` choice threaded through. The smoke's `create` step creates one of each and
imports both. The dry run checks `dist/templates.json` is in the tarball.

## Step 4 — docs

`docs/autoapp/design.md` (removal beside creation, two sentences; the trash),
`docs/autoapp/security.md` (removal is a person's action; no tool; the typed
confirmation; what MCP would see), `docs/autoapp/backlog.md` (the `remove` row moves to
"done after all"; `prune` gains the trash), `templates/autoapp-blank/README.md`,
`packages/broapp-autoapp/README.md` (one sentence each for remove and blank),
`skills/broapp/SKILL.md` (the two commands).

## Verification

```bash
bun run typecheck
bun run --cwd packages/broapp-autoapp build:template
bun test tests/autoapp-create.test.ts tests/autoapp-remove.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run dryrun:autoapp
bun run check
```

`tests/autoapp-remove.test.ts` (root under `tests/.autoapp-run/`, children stopped and
roots removed in `afterEach`):

1. `describeRemoval` counts releases, snapshots and `data-prev` directories and
   measures data bytes for a built application.
2. `removeApplication` renames the directory to `trash/<id>-<stamp>`, leaves every
   byte inside it, writes the journal row, clears the session and the candidate
   state, and `listApps` no longer lists the id; `journal.history(id)` still answers.
3. Serving refuses with `unavailable` and moves nothing; a running preview is
   stopped and the receipt says so.
4. Over the harness: `launcher.appRemove` with a wrong `confirm` is `invalid_input`
   and moves nothing; with the right one it returns the receipt; on channel `ai`
   through a guarded wrapper it asks (assert the route's effect is `write`).
5. The `remove` command without `--yes` prints the description and exits 1; with
   `--yes` it moves; while a launcher serves the application it refuses.
6. No engineer tool named `apps.remove` or similar exists (`engineerTools` keys).
7. `tests/autoapp-create.test.ts`: both templates pack, each with every `SOURCE` path;
   the blank builds, its one example passes on a preview, `apps.create` with
   `template: 'blank'` writes it and the row lists it; the default is still the
   starter; the blank's `schemaVersion` is what its migrations reach.

## Acceptance criteria

- A person can remove an application from the panel or the command line by typing
  its id, and finds every byte of it under the launcher's trash.
- Nothing removes while the application is serving; the engineer has no way to
  remove anything.
- **New application** offers the items list or a blank page, the same choice on the
  command and the tool, and the default is unchanged.
- The smoke creates one of each.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12i-remove-and-blank.md`. Include: whether `defineContract`
accepted an empty contract or the blank carries `app.status`; the trash path format;
the receipt from the smoke's removal; the size the second template adds to the
binary.

## Commit

```
Remove an application to the trash, and create a blank one

launcher.appRemove and the remove command move an application's directory
to a trash the launcher never empties, after the person types its id;
nothing removes while it serves, and no engineer tool can ask. New
application offers the items starter or a blank page, the same choice on
create and apps.create, with the starter still the default.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
