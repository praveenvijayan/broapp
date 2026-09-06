# 07 — The engineer service

## Goal

A person asks the application for something it cannot do; the engineer,
running in the launcher's own tab, reads the specification and source,
proposes a change, builds a candidate, opens a preview on a data copy,
explains what changed and what new capabilities it asks for, and requests
activation. Every step is a tool call through the gate. After this prompt,
the Notes demo runs end to end: "Add tags and an Archive action, then let
me save a repeatable workflow for archiving selected notes."

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `packages/broapp/src/ai/host/*` after prompts 01 and 06: `createAi`, `guardedTool`, `fromContract`, `AiContextProviders`, the system prompt assembly in `run.ts` (find where `app.purpose` and `terminology` are used).
- `packages/broapp/src/ai/react/*` — `AiChat`, `AiSettings`, `AiProvider`.
- `packages/broapp-autoapp/src/launcher/*` — `buildCandidate`, `activate`, `Supervisor`, `Journal`, `recover`, `main.ts`.
- `packages/broapp-autoapp/src/spec/*`, `src/views/*`.
- `examples/notes/` as converted by prompt 05 (the source workspace shape).
- `docs/ai.md` — so the engineer's document matches.

## Step 1 — the launcher becomes a Broapp application

`packages/broapp-autoapp/src/launcher/app.ts`: the launcher's own contract
and host, mounted by `serve` (which now serves the launcher tab and, from
it, opens application tabs) and by a new `open` command. Group `launcher`.

| Route | effect | purpose |
|---|---|---|
| `launcher.appsList` | read | apps with current release, serving state, pid, schema version, pending activation |
| `launcher.appOpen` | write | start the app's child if not running; return its URL for the browser to open in a new tab. The URL is a credential; the tab opens it immediately with `window.open`, and the host never logs it. |
| `launcher.appStop` | write | drain and shut down |
| `launcher.releasesList` | read | releases for an app with created time and whether current |
| `launcher.journalList` | read | activation history |
| `launcher.grantsGet` | read | granted capabilities |
| `launcher.grantsSet` | write | replace grants; the input carries the `releaseId` the person was shown |
| `launcher.candidateStatus` | read | what the engineer has built and previewed for an app: `releaseId`, build problems, preview URL present or not, capability diff, changed files |

`packages/broapp-autoapp/src/launcher/ui/` — a small React UI over the
renderer where possible: an apps table, a release/journal page, a grants
page, and the engineer's `AiChat` in a side column. Where the renderer's
primitives are not enough (opening a new tab), write ordinary components;
this is the launcher's own trusted interface, not generated.

The launcher stores its AI settings in its own data directory
(`<root>/../` is `ensureDataDir('broapp-autoapp')`; pass that to
`createAi`).

## Step 2 — the source workspace and the engineer's view of it

`packages/broapp-autoapp/src/engineer/workspace.ts`:

- `readTree(sourceDir): { path, bytes }[]` — files under `src/`, `autoapp.json`, `package.json`, excluding `node_modules`, `dist`, `.git`. Refuses any path that resolves outside `sourceDir`.
- `readFile(sourceDir, path): string` — text only, 200 kB limit, same containment check.
- `applyChange(sourceDir, change: FileChange[]): { changed: string[] }` where `FileChange = { path, content } | { path, delete: true }`. Writes go to the same containment-checked paths. If `git` is available the workspace is committed after every applied change with the message the engineer supplied, so an undo exists; without git, the previous content of every changed file is written to `<app>/source-history/<timestamp>/` first. Both paths are tested.
- `diffSummary(sourceDir, before: Snapshot, after: Snapshot): string` — a unified diff, capped at 20 kB with a note when truncated, produced without git (a small line diff is enough; do not add a dependency).

## Step 3 — the tools

`packages/broapp-autoapp/src/engineer/tools.ts`: `engineerTools({ layout, supervisor, journal, gate, logger }): Record<string, GuardedTool>`.
All built with `guardedTool`. The **gate** here is the launcher's own,
`appId: 'launcher'`, `releaseId` of the launcher build.

| Tool | effect | Input | Does |
|---|---|---|---|
| `spec.read` | read | `{ appId }` | current release's `spec.json` as JSON, plus the views, plus the capability grants |
| `source.list` | read | `{ appId }` | `readTree` |
| `source.read` | read | `{ appId, path }` | `readFile` |
| `source.change` | write | `{ appId, message, changes: FileChange[] }` | `applyChange`; returns the diff summary |
| `candidate.build` | write | `{ appId }` | `buildCandidate`; returns `releaseId` or the problems verbatim, so the model can fix them |
| `candidate.preview` | write | `{ appId, releaseId }` | snapshot `data` to a fresh `previews/<releaseId>/` directory (add `previews` to the layout), start a child in mode `preview` on it, keep the handle in the launcher's candidate state; returns `{ ok: true }` and the tab shows an "Open preview" button through `candidateStatus`. The URL is never returned to the model. |
| `candidate.check` | read | `{ appId, releaseId }` | runs the release's acceptance examples against the running preview child, returns each with pass or fail and the observed output |
| `candidate.explain` | read | `{ appId, releaseId }` | returns the machine facts the model must turn into the explanation: routes added, removed, changed effect; views components added, removed; migrations added; capabilities added and removed; schema version from and to |
| `release.activate` | external | `{ appId, releaseId }` | `activate`. Effect is `external` on purpose: it is the one action whose consequences the person must weigh, and it must be refused in any preview and always confirmed. Returns the result. |
| `preview.stop` | write | `{ appId }` | shuts the preview child down and removes its directory |

The model never sees a launch URL, a secret file, or `grants.json`'s path.
Inputs and outputs of these tools are recorded by the launcher's own run
store (reuse `createRunStore` on the launcher's data directory).

## Step 4 — the engineer's instructions

`packages/broapp-autoapp/src/engineer/instructions.ts` exports the text
appended to the system prompt via `AiAppDescription.purpose` and a new
optional `instructions` field on `AiAppDescription` (core change in
`create-ai.ts` and `run.ts`: appended verbatim after the purpose; name it
in the report). The text, in this order, in plain sentences:

1. What the engineer is: it changes an application's source workspace and
   produces candidate releases; it never edits the running release.
2. The workspace shape from prompt 05, Step 5, with the rule that
   `contract.ts` routes need `effect` and `summary`, `views.ts` components
   keep their `id`s across changes, migrations are appended and never
   edited, `autoapp.json` lists `schemaVersion`, `migrations`,
   `capabilities` and `acceptance`.
3. The loop it must follow: read the spec, read the files it will change,
   state the intended behaviour and add or update an acceptance example,
   change files, build, fix problems until the build passes, preview,
   check, explain the change and any new capabilities in two short
   paragraphs, then ask the person to open the preview, and only after
   they say so, request activation.
4. What it may not do: put secrets in files, add dependencies not already
   in `package.json`, write outside `src/` and `autoapp.json`, remove a
   migration, change a component id, promise the preview is contained (it
   is trusted local code on a data copy).
5. How to describe generated host code to the person: "This change runs
   on your machine with the same permissions as the application; the
   preview uses a copy of your data."

Keep it under 60 lines. The tests assert the file's presence of each of
the five parts by a sentinel sentence, not by wording.

## Step 5 — the candidate state and the tab

`packages/broapp-autoapp/src/engineer/state.ts` keeps, per app, the last
build result, the preview child handle, the check results. Exposed through
`launcher.candidateStatus`. The launcher UI shows: build problems; "Open
preview" (calls a `launcher.previewOpen` write route that returns the
preview child's URL for `window.open`, the same pattern as `appOpen`); the
explanation the model wrote is in the chat, not in state; the capability
diff with an "Grant these" button calling `grantsSet` with the shown
`releaseId`; and "Activate" which calls `launcher.activate` (write, user
channel) — the person's own click, not the model's tool. The model's
`release.activate` tool remains for the case where the person asks in
chat, and it confirms through the chat's confirm event as any `external`
tool does.

`launcher.activate` and the tool call the same `activate()`; the journal
distinguishes them by the run's channel.

## Step 6 — the Notes demo

`examples/notes` is converted by prompt 05 into the workspace shape. Add
to its `autoapp.json` an acceptance example `list-empty-filter` calling
`notes.list` with `{ done: true }` expecting `{ notes: [] }` on the
fixture's empty data. Then, by hand, with a real provider configured in
the launcher tab:

1. `dist/broapp-autoapp serve` — the launcher tab opens. Import Notes if not present.
2. Open Notes from the apps table; create three notes.
3. In the engineer chat: "Add tags to notes and an Archive action. Archived notes disappear from the main list. Then let me save a repeatable workflow for archiving selected notes."
4. Expect: `spec.read`, several `source.read`, `source.change` (confirm), `candidate.build` (confirm; likely a fix loop), `candidate.preview` (confirm), `candidate.check`, `candidate.explain`, an explanation, and a request to open the preview.
5. Open the preview tab; see tags and Archive on a copy of the three notes; archive one; confirm the live tab still shows three.
6. Grant nothing (no new capabilities expected). Activate from the tab. Reload Notes: tags and Archive present, three notes present.
7. In Notes' own chat: "Archive the notes tagged 'old'." Approve. Open `#/autoapp/runs`, save as workflow with the tag as parameter, promote to the `notes` page.
8. Run the promoted form with a tag; approve.

Record every step, what the model did, how many build iterations, and
anything you had to nudge. If the model cannot complete step 3 in three
attempts, record exactly where it stalls; that is a finding, not a failure
of the prompt.

## Step 7 — tests

`tests/autoapp-engineer.test.ts`, with the fake adapter from
`broapp/ai/host` scripted to call tools in sequence, over the harness with
the launcher's host app and the prompt 05 fixture application:

1. `readTree`/`readFile`/`applyChange` containment: `../x`, absolute paths and symlinks pointing outside are refused.
2. `applyChange` with git present commits; without git (`PATH` without git) writes `source-history`.
3. The fake model calls `source.change` → the tool waits for confirmation; declined → the file is untouched and the model is told `DECLINED`.
4. `candidate.build` with a broken contract returns problems in the tool output; the fake model "fixes" the file and the second build succeeds.
5. `candidate.preview` starts a `preview` child on a copy: writing through the preview leaves the live data untouched; `items.ping` (external) is rejected in the preview.
6. `candidate.check` reports a failing example.
7. `release.activate` in a launcher gate set to `preview` is refused; in `live` it confirms and activates; the journal shows channel `ai`.
8. `launcher.activate` from the tab activates with channel `user` and no confirmation.
9. `grantsSet` with a stale `releaseId` (release changed since it was shown) is `conflict`.
10. The model output never contains a launch URL: assert on the fake adapter's received tool outputs across the whole scripted session.
11. Instructions contain the five parts.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-engineer.test.ts
bun test tests
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

Then the Step 6 demo.

## Acceptance criteria

- Every engineer action is a `guardedTool`; `grep -n "execute" packages/broapp-autoapp/src/engineer/tools.ts` shows no bare `execute` definitions.
- The model never receives a URL or a secret path; test 10 proves it for the scripted session.
- The demo's steps 1 to 8 are recorded with outcomes; the report states which steps the model completed unaided.

## Report

`prompts/autoapp/reports/07-engineer.md`. The demo log is the centre of it.

## Commit

```
Add the engineer service and the launcher tab

The launcher is a Broapp application of its own, with an AI engineer
whose tools read the specification and source, change files, build and
preview candidates, explain changes and request activation, every one
through the gate. The Notes demo adds tags and an Archive action and
saves an archiving workflow.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
