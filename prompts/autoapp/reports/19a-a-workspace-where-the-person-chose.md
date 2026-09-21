# 19a — A workspace where the person chose to put it

## What was built

- **`spec/layout.ts`**: `AppLayout.source` and `sourceLocation` are getters that read `<dir>/location.json` once per `layout.app()` object; `location` names the file. Never throws: bad JSON, empty, `version` ≠ 1, a relative `source`, or one inside `<root>` (by `resolve` or `realpath`) is `unreadable`, and `source` is then the default path, which nothing builds from.
- **`launcher/location-words.ts`** (no `node:` import): every sentence in the table, plus `workspaceSentence`. **`launcher/location.ts`**: `normaliseLocation`, `checkLocation`, `sourceState`, `sourceProblem`, `requireSource`, `writeLocation` (tmp + `renameSync`, 0600, injectable rename), `locateApplication`, `looksSynced`.
- **`create.ts`**: `location`, `locationOptions`, injectable `writeStarter`; the six steps in order. `EEXIST` or nothing made: non-recursive `rmdirSync(app.dir)`, conflict / problem, no pointer. Target made then failure: pointer written, `spec` problem. Notes start `the workspace is at <target>`, plus the synced-folder note.
- **Contract**: `appCreate.location`; `appSummary.workspace {chosen, dir, state}`; receipt `workspaceLeftAt`; `launcher.locationCheck` (read), `launcher.appLocate` (write). Routes in `app.ts`.
- **Guard placed**: `buildCandidate` (no `sourceDir`), every `source.*` tool, `editHunks`, `candidate.cycle`, executor `runTask` (before any model call; task not moved), orientation/evidence/serve index, replay, `main.ts build`. **Not** guarded: open, restore, activation, rollback, snapshots, removal.
- **Removal** leaves a chosen workspace; receipt and log line say it. **CLI**: `create --at`, `locate <appId> <dir>`, `remove` prints the sentence; usage text.
- **Tests**: `tests/autoapp-location.test.ts`, 22 numbered + 1 (writeStarter still refuses an existing target).
- **Docs**: troubleshooting, design (layout), security, package README, six backlog rows, common rules' *Data layout* sentence.

## Greps

- `grep -rn "'source'" src`: one path maker, `spec/layout.ts:92` (now inside the getter). The other hits are the view schema's `source` property (`views/validate.ts`, `react/bind.ts`, `engineer/design.ts`), not a path.
- `mkdirSync`/`cpSync` near `.source`: `starter.ts` (non-recursive, creation only); `main.ts import` `cpSync` into `app.source` — **would have recreated a chosen, missing folder**; now refused when a pointer exists; `engineer/workspace.ts applyChange` recursive `mkdirSync(dirname(target))` — a race after the tool's guard could recreate a vanished workspace; now refuses when the workspace is gone; `evaluate.ts`/`harness.ts` copy into fresh evaluation roots (default layout, never a pointer); `snapshot.ts`/`replay.ts:177` are data directories.

## Every reader of `.source`

| Reader | Missing directory, before | Now |
|---|---|---|
| `candidate.ts buildCandidate` | `spec: autoapp.json: ENOENT…` | the state's sentence; `unreadable` never builds the default path |
| `workspace.ts prepareWorkspace` | n/a (runs after `writeStarter`) | unchanged |
| `remove.ts describeRemoval` | `hadSource: false` | same, plus `workspaceLeftAt`; never fails |
| `main.ts import` | `cpSync` into it | refused when a pointer exists |
| `main.ts build` | ENOENT problem, exit 1 | sentence, exit 1 |
| `tools.ts source.list/read/search/change/edit`, `candidate.cycle` | ENOENT or `within` errors | `requireSource`: `unavailable` with the sentence |
| `tools.ts spec.read`, `state.ts revisionOf`, `ids.ts origin` | `sourceRevision` → `no-git` | unchanged |
| `engineer/workspace.ts applyChange` | could `mkdir -p` it | refuses |
| `executor.ts runTask` / `countRefusal` | turns ran, every tool refused | stops before any turn with the sentence; `countRefusal` only runs inside a turn |
| `path.ts orientation`, `taskEvidence` | edits `[]`, files "missing" | a `Workspace:` line with the sentence; `Next:` says nothing can change |
| `serve.ts indexOf` | empty index | empty index without reading; `unreadable` never indexes the default |
| `links.ts fileKey`, `isWorkspaceFile` | relative / `false` | unchanged |
| `replay.ts manifestFor` | clone failed → inconclusive | refused with the sentence first |
| `harness.ts`, `evaluate.ts` | own fresh roots | unchanged; never pass `location` |

## Existing tests

None edited; create, remove, spec, engineer pass (and all 56 files). Three pinned exact shapes, so the code bends: `describeRemoval` omits `workspaceLeftAt` for a default workspace (`remove` `toEqual`), the receipt still carries `null`; `AppRow.workspace` is optional in the TS type (`autoapp-review.test.ts` builds a row literal), `listApps` always fills it; `apps.list` carries `workspace` only when chosen or not `present` (`engineer` `toEqual`).

## Where I differ from the Fixed decisions

1. **`apps.list`**: `workspace: { state, dir? }` only for a chosen or not-present workspace (above). Test 19 holds it for a chosen missing one.
2. **Check order**: inside another workspace before inside `<root>`, so a folder in another app's *default* workspace gets the specific sentence.
3. **NUL** has its own sentence; the table's "not absolute" would misstate why.
4. **`unreadable`** lists `chosen: true, dir: null`; removal of one leaves nothing (`workspaceLeftAt` null, `hadSource` false).
5. **`apps.create` with `location`** is refused by name in `run` (after the gate's question): the schema's `parse` strips unknown keys, it does not refuse them.
6. **Test-only**: `create` honours `NODE_ENV=test` + `AUTOAPP_TEST_NO_NETWORK=1` by reporting a failed install (test 21 must not reach the registry). Smoke unaffected.
7. **Executor**: a stopped run also emits the usual `run-ended` event with the sentence.

## Approval on channel `ai`

`launcher.appCreate` from `ai` asks (write). The question carries `route`, `effect: write`, and `input` verbatim — `location` exactly as sent, not normalised (test 19).

## By hand (copy of the root)

Copy: `reading-list` (releases, `current`, grants, source, data by `VACUUM INTO`), journal, knowledge, intents, my own AI settings (Ollama, `qwen3.8:27b-mlx`, no key). `BROAPP_DATA_DIR` at the copy; freshly built binary. The person's own launcher kept serving the real root.

- `create notes2 --at ".../scratchpad/My Projects"`: `the workspace is at …/My Projects/notes2`, installed, release `fb5c8db9…`; pointer mode 600. Creation does not commit, so I committed the starter by hand, edited `'Add an item'` → `'Add a note'` in `sed` (no GUI editor), committed; asked the engineer in the page for header `Label` → `Title`, allowed its `source.edit`: `git log` shows starter, the hand commit, and `1e5d75c` by "Autoapp engineer".
- Serving, renamed with `mv` (not Finder). **Open** still opened (address printed; the app page loaded "Notes two"). The engineer, asked for a change, made no tool call and said: "Notes two's source workspace is missing…", quoting the sentence. `build notes2`: the `missing` sentence, exit 1; the path did not reappear. Renamed back: `build notes2` → `e65ad813…`, no restart.
- Moved to `Elsewhere/notes two moved`; `locate` accepted, then build `6496bf2e…` — a different id from `e65ad813` for the same files at another path; I did not look into why. `locate` of `Elsewhere` → "does not hold notes2"; of reading-list's source → inside its workspace; `locate reading-list` → default, not moved.
- `create desktop-check --at "~/Desktop"`: `~` expanded, **no macOS prompt**: this shell's parent already holds Desktop access, so the unprompted case was not observable here. Not claimed.
- `remove notes2 --yes`: "…3 releases, its workspace stays where it is…", then "Its workspace at …/My Projects/notes2 was left where it is." `create notes2 --at` same place: "…/notes2 already exists. Choose another folder, or move or rename that one first." exit 1. Same for `desktop-check`; I then moved my `~/Desktop/desktop-check` into the scratchpad.
- A hand-copied root carries its pointers: both copies share a chosen workspace (troubleshooting says so).
- Only macOS was run. Windows and Linux behaviour (path forms, `EPERM` on rename) is unit-tested only where portable; permission cases skip on Windows and as root.

## For 19b

`AppsTable` reads only `appId`/`trashPath` of a receipt and ignores `workspace`; the row sentence needs `name`, which `workspaceSentence` takes. `leftSentence` lives in `remove.ts` (imports `node:fs`): the page must use `LOCATION_WORDS.removalLeft/removalMissing` with `hadSource`. `locationCheck` answers the id rule for an unfinished id, so call it once the id is valid. Post `location` only when the field is non-empty.

## Commands

```
bun run typecheck                                  exit 0
bun test tests/autoapp-location.test.ts            23 pass, 0 fail
bun test tests/autoapp-{create,remove,spec}.test.ts  88 pass, 0 fail
bun test tests/autoapp-engineer.test.ts            62 pass, 0 fail
mutation: build guard off → tests 11 and 14 fail; restored
bun install && bun run check                       exit 0; 1143 pass, 0 fail, 56 files
bun run --cwd packages/broapp-autoapp build:launcher   dist/broapp-autoapp 78.3 MB
bun run scripts/autoapp-smoke.ts                   autoapp smoke: every step passed
```

## Acceptance criteria

| Criterion | |
|---|---|
| Untouched field: stores and runs as before; suites unedited | pass (tests 1, 2; suites) |
| `create --at` / `appCreate.location` make it there; `locationCheck` says where first | pass (3, 20, 21) |
| Every refusal before anything is written, id kept, says what to do | pass (7, 8, 20) |
| Missing workspace: opens, list and launcher survive, never recreated, one sentence everywhere, back by itself or by `appLocate` | pass (11, 12, 13, 14, 15, 18) |
| Nothing in a chosen folder deleted or moved | pass (8, 9, 16) |
| A model cannot choose a location | pass (19) |
| Page unedited, works against every changed route | pass (22; `AppsTable.tsx` untouched) |
| `releases/`, `data*/`, snapshots, journal, trash in place; `activate.ts`, `recover.ts` untouched | pass (test 18 needed no change) |
| `bun run check` green | pass |
