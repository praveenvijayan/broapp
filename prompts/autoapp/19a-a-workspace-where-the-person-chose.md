# 19a — A workspace where the person chose to put it

## Goal

Every application's source workspace is `<root>/apps/<appId>/source/`, inside
the launcher's own data directory (`~/Library/Application Support/…` on macOS,
`%APPDATA%` on Windows). A person who wants their project beside their other
projects — in `~/Projects`, on another drive, in a folder their editor already
has open — cannot have that. They can only go looking for it.

After 19a and 19b the New application form has one more field: where the
project lives. Left alone, everything is exactly as today. With a folder
chosen, the source workspace is written to `<chosen folder>/<appId>/` and every
command, tool and panel works on it there.

This prompt is the host's half: the pointer, the checks, creation, the guard
for a workspace that has gone, removal, finding it again, the routes and the
CLI. When it lands, `broapp-autoapp create … --at <dir>` works and the routes
answer, and **the page is unchanged** — it posts no `location` and draws
nothing new. 19b is the form, the system's folder dialog and the row.

Only the **source workspace** moves. `releases/`, `data/`, `data-next/`,
`data-prev-*/`, `snapshots/`, `current`, `grants.json`, `candidate.json`, the
journal and the trash stay under `<root>`. This is not a shortcut, it is the
design: activation swaps `data-next` → `data` with `renameSync`
(`activate.ts` ~363) and removal is one `renameSync` into `<root>/trash`
(`remove.ts` ~120). Both are atomic only on one volume, and `appIds()` and
`recover.ts` find applications by reading `<root>/apps`. Moving the whole
application directory would break all four. Moving the source breaks none.

The hard part is not the happy path. A folder a person chose is a folder a
person can rename, delete, unplug or lose permission to, and the launcher
must say what happened in a sentence, keep serving the application, and never
quietly make a new empty folder where the old one was. Most of this prompt is
about that.

## Read first

- `prompts/autoapp/00-common-rules.md`, whole. You will amend its *Data
  layout* row (one sentence, see *Fixed decisions*).
- `src/spec/layout.ts`, whole. `source: join(dir, 'source')` at line ~92 is
  the only place the path is made. Confirm that with
  `grep -rn "'source'" src` and say so in the report; if you find a second
  place, it is a finding, fix it through the layout.
- `src/launcher/create.ts`, whole, including its header comment: the directory
  is the lock, nothing is checked first that two callers could both pass, and
  nothing that fails deletes anything. `src/launcher/starter.ts`
  `writeStarter`: its **first act is a non-recursive `mkdirSync(target)`**, so
  an `EEXIST` from it means it wrote nothing.
- `src/launcher/workspace.ts` `prepareWorkspace`; `src/launcher/candidate.ts`
  `buildCandidate` (line ~186, where a missing `autoapp.json` becomes a
  `spec` problem reading `autoapp.json: ENOENT…`).
- `src/launcher/app.ts`: `launcher.appCreate` (~228), `openApplication`, and
  how `install`, `initGit` and `openBrowser` are options a test replaces.
- `src/launcher/contract.ts`: `launcher.appsList`, `appSummary`,
  `launcher.appCreate`, `launcher.appRemove` and its receipt (`hadSource`,
  `trashPath`).
- `src/launcher/apps.ts` (`AppRow`, `listApps`, and the `.DS_Store` comment —
  one bad entry must never fail the whole list), `src/launcher/remove.ts`
  (`describeRemoval`, the receipt, the log line ~256),
  `src/launcher/recover.ts`.
- `src/launcher/main.ts`: `createApp` (~753), `importApp` (~695), the usage
  text (~120).
- `src/engineer/workspace.ts` lines ~85–120 and ~279: confinement takes
  `realpathSync(sourceDir)` of whatever it is given. `src/engineer/tools.ts`
  `apps.create` (~819) and every `source.*` tool.
- Every other reader of `.source`: `intent/executor.ts` (~1006, ~1149),
  `knowledge/path.ts`, `ids.ts`, `serve.ts`, `links.ts`, `replay.ts`,
  `harness.ts`, `evaluate.ts`. For each, know what it does today when the
  directory is not there.
- `src/launcher/ui/AppsTable.tsx`: read only, to know what it posts to
  `launcher.appCreate` and reads from `launcher.appsList` and the removal
  receipt, so that every contract change here is one an unchanged page still
  parses. It is not edited in this prompt.
- `tests/autoapp-create.test.ts`, `autoapp-remove.test.ts`,
  `autoapp-spec.test.ts`, `autoapp-engineer.test.ts`: how a test makes a root,
  replaces `install`, and reads a route.

## Fixed decisions

| Decision | Value |
|---|---|
| What moves | The source workspace only. See *Goal*. No option, flag or file moves anything else. |
| The pointer | `<root>/apps/<appId>/location.json`, mode `0600`: `{ "version": 1, "source": "<absolute path>" }`. Absent means `join(dir, 'source')`, so every existing application, every test root and every evaluation root behaves byte-for-byte as today. Written atomically (temporary file, then `renameSync`, as `control.ts` does). It lives in the application directory so it goes to the trash with it and comes back with it. |
| Who reads it | `layout.app()` and nothing else. `AppLayout` keeps `source: string` and gains `sourceLocation: { kind: 'default' } \| { kind: 'chosen'; path: string } \| { kind: 'unreadable'; reason: string }`. `layout.app()` **never throws** because of this file. Unparseable JSON, a `version` that is not `1`, a `source` that is not an absolute string, or one that resolves inside `<root>`: `kind: 'unreadable'`, and `source` is the default path. It is not a fallback anyone builds from — see *The guard*. |
| The target | `<location>/<appId>`. Never `<location>` itself: a person who picks `~/Projects` gets `~/Projects/notes`, and picking a folder with things in it is safe. The target must not exist. Not "must be empty": must not exist. |
| Normalising | On the host, in one function, in this order: reject a NUL character; expand a leading `~` or `~/` with `homedir()` (`~name` is refused); `resolve()`; then the checks. The stored value is this resolved path, not its `realpath` — a person is shown what they chose. Length cap 1024 in the schema. Spaces and non-ASCII are ordinary. |
| The checks, before the lock | One exported function, `checkLocation(root, appId, location)`, returning `{ ok: true, target }` or `{ ok: false, problem }`, used by the route, the CLI, the form's live check and `appLocate`. It refuses, each with its own sentence (*The words*): not absolute; does not exist; not a directory; not writable (`accessSync(W_OK)`); `realpath` inside `realpath(<root>)`; `realpath` inside any listed application's workspace (one application's engineer must never be confined to a folder that contains another's); target already exists. These run **before** `mkdirSync(app.dir)`: they are about the person's folder, not about the id, and a refusal must not burn the id. They are racy and that is fine — the next row is what is not. |
| The order of creation | 1. validate id, name, description (today). 2. `checkLocation` if a location was given; refusal throws `publicError.invalidInput` (or `conflict` for *target exists*) and nothing has been written. 3. `mkdirSync(app.dir)` — the lock, unchanged. 4. `writeStarter(template, target, …)`. 5. Only once `writeStarter` has made the target: write `location.json`. 6. `prepareWorkspace`, as today. |
| When step 4 fails | `EEXIST` (somebody made the target between the check and now): `writeStarter` wrote nothing, so the folder is **not ours** — never write a pointer to it. `rmdirSync(app.dir)` — non-recursive, which can only succeed on the empty directory this call made a moment ago, so it cannot tidy away anything — then throw `publicError.conflict`. This is the one exception to "nothing that fails deletes anything"; write the reason in the comment. Any other failure (`ENOSPC`, `EACCES`, `EROFS`, `ENAMETOOLONG`, `EPERM`): if the target now exists it is ours and half-written — write the pointer, then return `ok: false` with a `spec` problem, as today's `writeStarter` failure does. If it does not exist, `rmdirSync(app.dir)` as above and return the problem. |
| Permissions | The target is made as `writeStarter` makes it today. Do not `chmod` a folder inside a place the person chose. |
| Who may choose | A person. `launcher.appCreate` gains `location: s.optional(s.string({ min: 1, max: 1024 }))`. The CLI gains `create … --at <dir>`. The engineer's `apps.create` input **does not change**: a model does not decide where on a disk files are written. A test holds that its JSON schema has no `location`. `INTENT_REFUSES` is untouched. `launcher.appCreate` arriving on channel `ai` (MCP, a workflow) is already asked about as a write — read what the approval shows and make sure `location` is in it, in full. |
| The guard | One function, `requireSource(layout, appId)`, in a new `src/launcher/location.ts`, returning the directory or throwing `publicError.unavailable` with the sentence for its state: `present`, `missing` (pointer fine, directory not there), `not-a-directory`, `unreadable` (the pointer itself), `denied` (`EACCES`/`EPERM` on `statSync`). A sibling `sourceState(layout, appId)` returns `{ state, dir, chosen }` without throwing, for lists. **State is computed when asked, never cached**: a drive plugged back in is `present` on the next call with no restart. |
| Nothing recreates a chosen folder | No code path may `mkdir` a missing workspace, recursively or not. A drive that is unplugged leaves `/Volumes/X/…` missing, and a helpful `mkdirSync(…, { recursive: true })` would write a new empty project onto the boot disk under a name that is about to be shadowed. Grep for `mkdirSync` and `cpSync` near `.source` and say in the report what you found. |
| Where the guard goes | `buildCandidate` when `params.sourceDir` is absent: a `spec` problem carrying the guard's sentence, instead of `autoapp.json: ENOENT`. Every `source.*` engineer tool and anything else in `tools.ts` that touches the workspace: the tool fails with the sentence, which the model reads and can repeat. `intent/executor.ts`: a task on an application whose workspace is not `present` stops **before any model call**, with the sentence as its reason, and is not counted as a model failure or a repeated refusal (read how 15f counts and keep this out of it). `knowledge/*` readers: they must not throw — orientation for such an application says one line, the sentence, in place of the file list. `main.ts` `build`, `import` and anything else that takes `app.source`. `prepareWorkspace` needs nothing: it runs straight after `writeStarter`. |
| What is not guarded | `launcher.appOpen`, `restoreServing`, activation of an already-built release, rollback, snapshots, removal. A release is self-contained. **An application whose workspace is gone still opens and still serves**, and a test says so. |
| The list | `appSummary` gains `workspace: s.object({ chosen: s.boolean(), dir: s.nullable(s.string({ max: 1100 })), state: s.enum(['present','missing','not-a-directory','unreadable','denied']) })`. `dir` is `null` for a default workspace: the launcher's own directory is not something the page needs. Additive; nothing existing is renamed. The engineer's `apps.list` gains the same `state` and, for a chosen one, `dir` — a path is not a credential, and a model told "missing" without being told where cannot tell the person anything useful. |
| Finding it again | `launcher.appLocate`, effect `'write'`, input `{ appId, sourceDir }` — the workspace itself this time, not its parent. It accepts only a directory that holds an `autoapp.json` whose `appId` is this application's, passes the same inside-`<root>` and inside-another-workspace checks, and then rewrites `location.json`. It works whatever the current state is, including `present` (a person moved it on purpose) and `default` → refused: a default workspace is not relocated by this prompt. CLI: `broapp-autoapp locate <appId> <dir>`. No engineer tool. |
| Removal | The application directory goes to the trash exactly as today; **a chosen workspace is left where it is, untouched** — it is in the person's folder, among the person's things, and the launcher's trash is on another volume as often as not. `describeRemoval` and the receipt gain `workspaceLeftAt: string \| null` (the path, for a chosen workspace, whether or not it is there) and keep `hadSource` meaning what it means. Removal never fails because a chosen workspace is missing, unreadable or denied. |
| Creating the same id again | After removal the old folder is still at `<location>/<appId>`, so choosing the same location again hits *target exists*. That is correct. The sentence says what to do. |
| `import` | Unchanged: it copies into the default place. `import --at` is a row in `docs/autoapp/backlog.md`. |
| Evaluation and copied roots | `evaluate.ts`, `harness.ts` and `replay.ts` never pass `location`; a test holds that `createApplication` without one writes no `location.json`. A root copied by hand carries its pointers, so both copies share a chosen workspace — one sentence in `docs/troubleshooting.md` and one in the by-hand notes of the report. |
| The live check | `launcher.locationCheck`, effect `'read'`, input `{ appId, location }`, output `{ ok: s.boolean(), target: s.nullable(s.string({ max: 1100 })), problem: s.nullable(s.string({ max: 600 })) }`: a thin wrapper on `checkLocation`, so 19b's form can say where the project will be made before Create is pressed. It writes nothing and takes no lock. |
| What creation says | `notes` gains `the workspace is at <target>`, first, when a location was given, so the CLI, the engineer panel and 19b's form all say it. |
| The page | Not edited. Every contract change is additive and optional on input, so the page built before this prompt still parses every answer; a test holds that the old `appSummary` and receipt shapes are subsets of the new. |
| Synced folders | A path containing `Mobile Documents`, `OneDrive`, `Dropbox` or `Google Drive` is **allowed**, and creation adds one note (*The words*). `node_modules` in a synced folder is slow and occasionally corrupt, a person should hear that once, and it is theirs to decide. |
| Common rules | The *Data layout* row gains: "`source/` is there unless `location.json` beside it names another directory (19a); nothing else may live outside `<root>`." |
| No release | No version bump, no publish. |
| Left for 19b | The form field, `launcher.folderChoose` and the system's dialog, the `Locate…` button, the row's path and sentence, the removal confirmation's words. Do not start them. |
| Not in scope, each a backlog row | Moving an existing application's workspace from the launcher (copy, verify, repoint). `import --at`. "Show in folder". A default location in Settings. Relocating a default workspace. Watching the folder for changes. |

## The words

One module holds them, `src/launcher/location-words.ts`, importable by the
page (no `node:` import in it — 19b draws some of these), so the route, the
CLI, the tools and the page cannot disagree. House style: a sentence that says what the rule is or what happened,
and what a person can do. No error codes on screen, no stack.

| When | Sentence |
|---|---|
| Not absolute | `A folder has to be given as a full path, such as /Users/you/Projects. "{input}" is not one.` |
| `~name` | `"{input}" starts with another person’s home folder, which cannot be worked out here. Write the full path.` |
| Does not exist | `{location} does not exist. Choose a folder that is already there; the application’s own folder is made inside it.` |
| Not a directory | `{location} is a file, not a folder.` |
| Not writable | `Nothing can be written in {location}. Choose a folder you can save into.` On macOS add: `If it is in Desktop, Documents or Downloads, the system may not have given the launcher permission to use it.` |
| Inside `<root>` | `{location} is inside the launcher’s own folder. Leave the choice empty to keep the application there, or choose somewhere else.` |
| Inside another workspace | `{location} is inside the workspace of {otherAppId}. Choose a folder that is not part of another application.` |
| Target exists | `{target} already exists. Choose another folder, or move or rename that one first.` |
| Lost the race (step 4 `EEXIST`) | The same sentence. |
| Disk full | `There was not enough room at {target} to write the application. What was written is still there.` |
| Path too long | `{target} is a longer path than this system allows. Choose a folder nearer the top of the drive.` |
| Read-only volume | `{location} is on a volume that cannot be written to.` |
| Synced folder, note | `{location} looks like a folder that is synced to the cloud. The application will work, but installing its dependencies there can be slow.` |
| `missing` | `Its workspace at {dir} cannot be found. It may have been moved, renamed or deleted, or be on a drive that is not connected. {name} still opens; it cannot be changed until the folder is back or you say where it went.` |
| `not-a-directory` | `{dir} is where its workspace should be, and it is a file.` |
| `denied` | `Its workspace at {dir} cannot be read. The system has not given the launcher permission to use that folder.` |
| `unreadable` | `The file that says where {appId}’s workspace is cannot be read ({reason}). Use Locate, or broapp-autoapp locate, to say where it is.` |
| Removal, left | `Its workspace at {dir} was left where it is.` |
| Removal, was missing | `Its workspace at {dir} could not be found, and nothing there was touched.` |
| Locate, wrong folder | `{sourceDir} does not hold {appId}: there is no autoapp.json there with that id.` — and when there is one with another id, say whose. |
| Locate, default workspace | `{appId}’s workspace is in the launcher’s own folder and is not moved from here.` |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-create.test.ts tests/autoapp-remove.test.ts tests/autoapp-spec.test.ts
bun test tests/autoapp-engineer.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests. Every one uses a temporary directory for the location; none opens a
dialog; none needs the network (replace `install` as the file already does).

Unchanged behaviour:

1. `createApplication` with no `location`: no `location.json`, `app.source` is
   `<root>/apps/<id>/source`, `sourceLocation.kind === 'default'`. The existing
   create, remove, spec and engineer suites pass **unedited** — if one needs an
   edit, that is a finding for the report, not a fix.
2. `layout.app()` for an id whose directory does not exist at all returns the
   default paths and does not throw — creation calls it before the directory
   is made.

The happy path:

3. With a location whose name has a space and a non-ASCII character: the
   starter is at `<location>/<id>`, `location.json` holds the resolved path and
   is mode `0600` (skip the mode on Windows), `<root>/apps/<id>/source` does not
   exist, the first release builds and becomes current, and `notes[0]` names
   the target.
4. `~/x` is expanded with a replaced `homedir`/env; `a/../b` is normalised
   before the checks; a trailing separator changes nothing.
5. `launcher.appsList` reports `chosen: true`, the `dir`, `present`; a default
   application reports `chosen: false`, `dir: null`.
6. The engineer's `source.read`, `source.edit` and `source.list` work in a
   chosen workspace; a path to `<location>/sibling/file` is refused; a symlink
   inside the workspace pointing out of it is refused; a chosen location that
   is itself a symlink works.

Refusals at creation — for **each**, assert the sentence, that
`<root>/apps/<id>` does not exist afterwards (the id is not burnt), and that
nothing was written under the location:

7. Relative path; NUL; `~other`; does not exist; is a file; not writable
   (`chmod 0500`, skipped on Windows and as root); inside `<root>`; inside
   `<root>` through a symlink; inside another application's chosen workspace;
   inside another application's **default** workspace; target exists as a
   folder; target exists as a file; target differs only by case on a
   case-insensitive volume (skip where the volume is case-sensitive).
8. The race: a `writeStarter` replaced to throw `EEXIST` after the check
   passed — `conflict`, `<root>/apps/<id>` gone, **no `location.json` was ever
   written**, and the pre-existing target's contents are untouched.
9. `writeStarter` replaced to make the target, write one file, then throw
   `ENOSPC`: `ok: false`, a `spec` problem with the disk-full sentence,
   `location.json` present and pointing at the target, the one file still
   there, nothing deleted.
10. Two creations of the same id at once, one with a location and one without:
    exactly one wins; the loser wrote nothing anywhere.

Afterwards — make the application, then break it:

11. Rename the workspace away. `appsList` says `missing` and does not throw;
    a second application in the list is unaffected. `launcher.appOpen` starts
    the child and it answers. A build returns a `spec` problem with the
    `missing` sentence and not the word `ENOENT`. `source.read` fails with the
    sentence. An intent task stops before any model call — the fake model's
    call count is zero — with the sentence, and the refusal counters 15f reads
    are unchanged. Orientation for it renders and contains the sentence.
    **After all of that, the missing path still does not exist**: nothing
    recreated it.
12. Rename it back: the very next `appsList` says `present` and a build
    succeeds, with no restart and no new launcher.
13. Replace the workspace with a file: `not-a-directory`. `chmod 000` it:
    `denied` (skipped on Windows and as root).
14. `location.json` holding `not json`, `{"version":2,…}`, a relative
    `source`, a `source` inside `<root>`, and an empty file: each is
    `unreadable`, `layout.app()` does not throw, the list still lists
    everything, a build is refused with the `unreadable` sentence, and **no
    build runs against the default path**.
15. `launcher.appLocate`: to the renamed folder — accepted, `present`, builds.
    To a folder with no `autoapp.json`; to one whose `autoapp.json` names
    another id (the sentence says whose); to one inside `<root>`; to one inside
    another workspace; for a default application — each refused with its
    sentence and the pointer unchanged. The rewrite is atomic: a `renameSync`
    replaced to throw leaves the old pointer whole.
16. Removal of an application with a chosen workspace: the application
    directory is in the trash with its `location.json` inside, the workspace is
    byte-for-byte where it was, the receipt carries `workspaceLeftAt`, the log
    line says it. The same with the workspace already missing: removal
    succeeds. Moving the trashed directory back to `<root>/apps/<id>` by hand
    lists it as `present` again.
17. After removal, creating the same id at the same location is *target
    exists*; at another location, or at the default, it succeeds.
18. A launcher restarted with one chosen workspace missing: it starts,
    `restoreServing` serves that application, `recover` does not throw.

The boundary:

19. `apps.create`'s JSON schema has no `location` property, and calling it with
    one is rejected by the schema. The engineer's `apps.list` carries `state`.
20. `launcher.locationCheck` agrees with `launcher.appCreate` for every case in
    7: same `ok`, same sentence.
21. The CLI: `create … --at <dir>` makes it there and prints the target;
    `--at` with a bad folder exits non-zero with the sentence and makes
    nothing; `locate` works and refuses as 15. `remove` prints the *Removal* sentence.

The page:

22. The launcher page built from the unchanged `AppsTable.tsx` renders a list
    holding a chosen, `missing` application, and a removal receipt carrying
    `workspaceLeftAt`, without error.

By hand, on a copy of the root, from the CLI and the unchanged page; notes in
the report:

- `create notes2 --name … --at "<a folder with a space in its name>"`. Open
  the workspace in an editor, change a label by hand, ask the engineer in the
  launcher to change another, and record that both are in one `git log`.
- With the application serving, rename its folder in Finder. Record: that it
  still opens from the page; what the engineer says when asked for a change;
  what `broapp-autoapp build notes2` prints. Rename it back; record that the
  next build works with no restart.
- Rename it away again, `locate` it; then `locate` the wrong folder.
- `create … --at ~/Desktop` on a machine where the launcher has not been given
  that folder: record what the system asked and what was printed.
- `remove` it; record the line. `create` the same id `--at` the same place;
  record the refusal.

## Acceptance criteria

- A person who never touches the new field sees, stores and runs exactly what
  they did before. Existing suites pass unedited.
- `create --at` and `launcher.appCreate` with a `location` make the workspace
  there, and `launcher.locationCheck` says where it will be beforehand.
- Every refusal happens before anything is written, keeps the id free, and
  says what to do.
- A workspace that goes missing never stops its application opening, never
  takes the list or the launcher down, is never recreated, is described in one
  sentence wherever a person or a model meets it, and comes back by itself when
  the folder does — or by `launcher.appLocate` when it moved.
- The launcher never deletes or moves anything in a folder the person chose.
- A model cannot choose a location.
- The page is unedited and still works against every changed route.
- `releases/`, `data*/`, `snapshots/`, the journal and the trash are where
  they were; `activate.ts` and `recover.ts` are untouched apart from anything
  test 18 forces, and the report says what.
- `bun run check` green.

## Docs

`docs/troubleshooting.md`: "An application says its workspace cannot be
found" — the four causes, `broapp-autoapp locate`, and the sentence
about copied roots. `docs/autoapp/design.md`, the layout section: the pointer
and why only the source moves. `docs/autoapp/security.md`: who may choose a
location and the inside-another-workspace rule. `packages/broapp-autoapp/README.md`: one line under creating an
application, and `--at` and `locate` in the command list. The backlog rows
from *Not in scope*. `prompts/autoapp/00-common-rules.md`: the *Data layout*
sentence.

## Report

`prompts/autoapp/reports/19a-a-workspace-where-the-person-chose.md`: the
result of the `'source'` grep and of the `mkdirSync`/`cpSync` grep; a table of
every reader of `.source` — what it did with a missing directory before, and
what it does now; whether any existing test needed an edit and why; what the
approval for `launcher.appCreate` on channel `ai` shows; the by-hand notes,
including what macOS asked about protected folders; what 19b will need from
the page's side that this prompt could not see; and anything in *Fixed decisions* you found to be wrong, with
what you did instead and why — do not quietly differ.

## Commit

```
Let a person choose where an application's workspace lives

Every workspace was inside the launcher's own data directory, where
nobody keeps their projects. Creation now takes a folder: the workspace
is made at <folder>/<appId>, a pointer beside the application's releases
says so, and everything that reads the workspace reads it through that.
Only the source moves; releases, data, snapshots and the trash stay on
the launcher's volume, because activation and removal are renames.
A folder is checked before anything is written, so a refusal costs
nothing and keeps the id. A workspace that later goes missing is said
in one sentence wherever it is met, never recreated, and never stops
its application opening; locate says where it went. Removal leaves a
chosen workspace where it is. A model cannot choose a location. The
page does not offer the choice yet: create --at does, and with it left
out nothing changes.
```

End the commit with the co-author trailer your session's rules give you.
