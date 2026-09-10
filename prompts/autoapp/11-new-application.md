# 11 — New application: a starter inside the binary, a create route, a button

## Goal

Today a person who downloads the launcher, starts it and sees the tab has
nowhere to go. The applications table is empty, the engineer can only change
an application that already exists, and the one way to add one is
`broapp-autoapp import <sourceDir> --as <appId>` in a terminal, pointed at a
Broapp source workspace they do not have. After this prompt: the launcher
carries a starter application inside its own binary; a **New application**
button in the tab writes it to disk, installs its dependencies, builds it,
makes it current and opens it; the same thing is a `create` command and an
`apps.create` tool, so a person can also say "make me a recipe tracker" to
the engineer and have it create the application before shaping it.

Nothing about releases, activation, the gate or the renderer changes. The
starter is an ordinary Autoapp source workspace; once it exists it is
imported in every sense that matters and every existing tool works on it.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far, `09-packaging.md` and `08c-usability.md` with care.
- `packages/broapp-autoapp/src/launcher/main.ts` — `importApp` is the function this prompt generalises; `HELP`; how `launcherPage` is inlined with `with { type: 'text' }`.
- `packages/broapp-autoapp/src/launcher/contract.ts`, `app.ts` (`openTab`, `launcher.appOpen`), `apps.ts`, `tab.ts`.
- `packages/broapp-autoapp/src/launcher/candidate.ts` — the fixed `SOURCE` shape, `checkDependencies`, `MISSING_DEPENDENCY`.
- `packages/broapp-autoapp/src/spec/layout.ts` and `types.ts` (`APP_ID_PATTERN`).
- `packages/broapp-autoapp/src/engineer/tools.ts`, `instructions.ts`.
- `packages/broapp-autoapp/src/launcher/ui/App.tsx`, `AppsTable.tsx`, `CandidatePanel.tsx`, `launcher.css`.
- `packages/broapp-autoapp/scripts/build-page.ts`, `build-launcher.ts`, `package.json` (`files`, `bin`).
- `tests/fixtures/autoapp-app/` — the smallest Autoapp workspace that builds; the starter is modelled on it.
- `examples/notes/` — `package.json`, `tsconfig.json`, `src/ui/styles.css`, `README.md`, for the parts the fixture leaves out.
- `packages/create-broapp/src/scaffold.ts` and `scripts/stage-template.ts` — the marker substitution and the "no shell, nothing pre-existing destroyed" properties. Reuse the ideas, not the code: `broapp-autoapp` must not depend on `create-broapp`.
- `scripts/autoapp-smoke.ts`, `scripts/autoapp-dry-run.ts`, `tests/autoapp-launcher.ts`, `tests/autoapp-engineer.test.ts` (how a test gets a root and a workspace).
- `.github/workflows/ci.yml` (`autoapp` job), `publish.yml` (where the page is built before publishing), `release.yml` (`launcher` job).

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Where the starter lives | `templates/autoapp-starter/`, at the repository root beside `templates/react-ts`, reviewed in git. |
| How it reaches the binary | `packages/broapp-autoapp/scripts/build-template.ts` packs it into `dist/starter-template.json` — `{ "files": { "<relative path>": "<utf8 text>" } }`, paths with forward slashes, `_gitignore` renamed to `.gitignore` on the way out (npm will not ship a `.gitignore`). `src/launcher/main.ts` imports it `with { type: 'json' }`, exactly as it imports the page. The script refuses a file that is not valid UTF-8 text and a tree with `node_modules`, `dist` or `release` in it. |
| What the starter is | One page, one table, one form: a list of items with `label`, `note`, `done` and `createdAt`, in SQLite, with **one** migration. Routes `items.list`, `items.add`, `items.update`, `items.remove`, `items.status`, every one with `effect` and `summary`. `capabilities: []`, and one acceptance example that reads the list. No AI panel in the application's own tab: the engineer in the launcher is the AI, and a starter that pulled in `broapp-ai-elements` and two provider packages would triple what `install` has to fetch for a person who has not asked for any of it. Say so in the starter's README. |
| Routes are not renamed | The route group stays `items` whatever the application is called. An application's name and id are data; a route group is code, and rewriting identifiers with string substitution is how a starter breaks the first time somebody names their application "list". |
| Markers | `__APP_ID__`, `__APP_NAME__`, `__APP_DESCRIPTION__`, `__BROAPP_VERSION__`, `__AUTOAPP_VERSION__`. Substituted at create time, on the host, in `.ts`, `.tsx`, `.json`, `.md`, `.html` and `.css` files only. A marker left over after substitution is a thrown error, never a written file. |
| Dependency ranges | The starter's `package.json` depends on `broapp`, `broapp-autoapp`, `react` and `react-dom`. `__BROAPP_VERSION__` is the `broapp` range from `packages/broapp-autoapp/package.json`'s own `dependencies`, and `__AUTOAPP_VERSION__` is `^` plus that file's `version` — so an application is always built against the same packages as the launcher that created it. Read them from the package manifest imported `with { type: 'json' }`; do not hard-code a number. |
| Installing | `BUN_BE_BUN=1 <self> install --production`, in the new workspace, the way `importApp` does — **without** `--frozen-lockfile`, because a workspace that was just written has no lockfile to freeze; the lockfile the install writes becomes the workspace's. This is the one moment creation touches the network. It is best effort exactly as in `importApp`: a failure is reported, the workspace stays, and the build says which package is missing. |
| When install fails | The workspace is kept, no `current` is written, and the route returns the problems. The application appears in the list with no release, its Open button disabled, and the engineer can `candidate.build` it once the person has fixed the network. Nothing is deleted on failure; a directory that was half-created is somebody's work now. |
| Grants | The starter asks for no capabilities, so `grants.json` is written empty and `current` is set without a question. If a template ever asks for a capability, creation **refuses** with a `spec` problem — a starter is not allowed to ask, and a person is not asked to approve something they have not read. |
| One implementation | Import and create share the steps after the source is on disk: install, `git init`, build, grants, current. Factor them out of `importApp` into `src/launcher/workspace.ts`; `importApp` keeps only its copy, its capability prompt and its console output. |
| Route effect | `launcher.appCreate` is `write`, like `appOpen`: a person's click, and it opens a tab. `apps.create` on the engineer is `write` too, so on channel `ai` it asks first. No route or tool returns a launch URL or a path outside the root. |
| Concurrency | The application directory is made with a non-recursive `mkdirSync`, and `EEXIST` is the lock: the second of two creates for the same id gets `conflict`, and nothing else is checked first. |

## Step 1 — the starter

`templates/autoapp-starter/`:

```
autoapp.json          appId __APP_ID__, name __APP_NAME__, schemaVersion 1, one migration, one acceptance example
package.json          name __APP_ID__, description __APP_DESCRIPTION__, the four dependencies, no scripts beyond typecheck
tsconfig.json         copied from examples/notes
README.md             what this is, where its data lives, "no AI panel in this tab and why", how the engineer changes it
_gitignore
src/shared/contract.ts
src/shared/views.ts   form (label, note) + table (label, done, added) with a row action to toggle done and one to remove
src/host/app.ts       start and migrate, modelled on the fixture's
src/host/db.ts        openStore with the one migration, list/add/update/remove/count
src/ui/main.tsx       the fixture's, plus styles.css
src/ui/index.html     title __APP_NAME__
src/ui/styles.css     the `--autoapp-*` properties the renderer reads (see instructions.ts), light and dark
```

Copy the Notes `tsconfig.json` and check that the root `tsconfig.json` does
not pick the template up (`templates/react-ts` is not typechecked either;
follow whatever keeps it out). Substituted values in `.ts` files must be
written so that a name containing a quote or a backslash cannot break the
file: put `__APP_NAME__` and `__APP_DESCRIPTION__` only in JSON, HTML text,
Markdown and comments, never inside a TypeScript string literal. Say so in a
comment at the top of `views.ts`.

`packages/broapp-autoapp/scripts/build-template.ts` writes
`dist/starter-template.json` and prints the file count and bytes.
`package.json`: `"build:template"`, and `build-launcher.ts` runs it right
after `build:page`. Add `dist/starter-template.json` to `files`. Add the
step to `publish.yml` beside "Build the launcher's page", and to
`autoapp-dry-run.ts`'s check of the installed package (a tarball without the
template is a launcher whose button cannot work — the same fault the page
check exists for).

Verify: `bun run --cwd packages/broapp-autoapp build:template` produces the
file; a test in `tests/autoapp-create.test.ts` reads `templates/autoapp-starter`
from disk, packs it with the same function the script uses (export it from
`scripts/build-template.ts` or from `src/launcher/starter.ts` — one place),
and asserts every path in `SOURCE` is present and no marker is missing from
the files that must carry one.

## Step 2 — `src/launcher/starter.ts` and `src/launcher/workspace.ts`

`starter.ts`:

```ts
export interface StarterTemplate { readonly files: Readonly<Record<string, string>> }
export interface StarterValues { appId; name; description; broappVersion; autoappVersion }
/** Substitute and write. Refuses to overwrite: `target` must not exist. Throws with the marker's name if one is left. */
export function writeStarter(template: StarterTemplate, target: string, values: StarterValues): readonly string[]
```

Substitution is `replaceAll` over the five markers, nothing else; the file
list is whatever the template carries. The function makes `target` with a
non-recursive `mkdirSync` and lets `EEXIST` propagate.

`workspace.ts` — the steps import and create share:

```ts
export interface PrepareOptions {
  readonly layout: Layout; readonly appId: string; readonly logger?: HostLogger;
  /** Install dependencies in the workspace. Defaults to `BUN_BE_BUN=1 <self> install --production`; tests inject one. */
  readonly install?: (sourceDir: string) => Promise<{ ok: boolean; detail: string }>;
  /** `git init` the workspace. Defaults to the real thing; tests inject one. */
  readonly initGit?: (sourceDir: string) => boolean;
}
export type PrepareResult =
  | { ok: true; releaseId: string; spec: AppSpec; installed: boolean; notes: readonly string[] }
  | { ok: false; installed: boolean; problems: readonly BuildProblem[]; notes: readonly string[] };
export async function prepareWorkspace(options: PrepareOptions): Promise<PrepareResult>
```

`notes` are the sentences `importApp` prints today ("installed the
application's dependencies", "git is not available; …"), returned rather
than printed so the route and the tool can show them. `prepareWorkspace`
builds, and returns the build's problems verbatim when it fails. It does
**not** write grants or `current`: whether to ask about capabilities is the
caller's business. Add a second function for the part that follows a
decision:

```ts
/** Record the grant and make the release current. */
export function adopt(layout: Layout, appId: string, releaseId: string, capabilities: readonly Capability[]): void
```

`importApp` in `main.ts` becomes: copy, `prepareWorkspace`, print notes and
problems, ask about capabilities as today, `adopt`. Its console output and
exit codes do not change; `scripts/autoapp-smoke.ts` step "import" is the
test of that.

`create.ts`:

```ts
export interface CreateOptions extends Omit<PrepareOptions, 'appId'> {
  readonly template: StarterTemplate; readonly versions: { broapp: string; autoapp: string };
  readonly appId: string; readonly name: string; readonly description?: string;
}
export type CreateResult =
  | { ok: true; releaseId: string; installed: boolean; notes: readonly string[] }
  | { ok: false; installed: boolean; problems: readonly BuildProblem[]; notes: readonly string[] };
export async function createApplication(options: CreateOptions): Promise<CreateResult>
```

Order: validate the id against `APP_ID_PATTERN` (`invalid_input`, naming the
rule in the message the way `layout.ts` does); `writeStarter` into
`layout.app(appId).source` after making `layout.app(appId).dir` with the
non-recursive `mkdirSync` (`EEXIST` → `conflict`: "<appId> already exists");
`prepareWorkspace`; if the built spec asks for any capability, return a
`spec` problem and stop; `adopt` with `[]`. A thrown error from `writeStarter`
after the directory was made leaves the directory: report it in the result
as a `spec` problem rather than throwing, so the tab sees a sentence and
the id is not silently burned. Name and description: trim, `name` 1–200
characters, `description` up to 400, defaults `name = appId`,
`description = ''`.

## Step 3 — the route, the command, the tool

`contract.ts`:

```ts
'launcher.appCreate': {
  effect: 'write',
  input: s.object({ appId: s.string({ min: 3, max: 40 }), name: s.string({ min: 1, max: 200 }), description: s.optional(s.string({ max: 400 })) }),
  output: s.object({ ok: s.boolean(), releaseId: s.nullable(s.string({ max: 64 })), installed: s.boolean(), problems: s.array(buildProblem, { max: 200 }), notes: s.array(s.string({ max: 400 }), { max: 20 }), opened: s.boolean() }),
  summary: 'Create an application from the starter, build it, make it current, and open it in a browser tab.',
},
```

`app.ts`: `CreateLauncherAppOptions` gains `template`, `versions` and the
optional `install`/`initGit` hooks; the route calls `createApplication`,
then on success starts the child and opens the tab the way `launcher.appOpen`
does — one function, not a copy — and reports `opened`. On failure `opened`
is `false` and `releaseId` is `null`.

**Before writing the route**, check whether a Brobridge call or a Broapp
operation has a deadline: search `node_modules/brobridge/dist/index.d.ts` and
`@brobridgejs/core` for `timeout`, and `packages/broapp/src/host/app.ts` for
one. An install can take a minute on a slow connection. If no deadline under
ten minutes exists, the route is synchronous and that is the design. If one
does, make `appCreate` return at once with `{ ok: true, releaseId: null, … }`
and add `launcher.createStatus` (`read`, `appIdInput`) that the panel polls
the way `CandidatePanel` polls `candidateStatus`; record which shape you
built and the deadline you found in the report. Do not guess.

`main.ts`: `create <appId> [--name <name>] [--description <text>]` in `HELP`
and the switch. Prints the notes, then the problems to stderr with exit 1, or
`<appId> <releaseId>` with exit 0 — the same lines `import` prints. It does
not open a browser, like `import`. `tab.ts` and `openLauncher` pass the
template and versions through.

`engineer/tools.ts`: `apps.create` (`write`), input `{ appId, name,
description? }`, output the route's minus `opened`. It shares
`createApplication` and takes the template from `EngineerToolsOptions`.
`instructions.ts`, in "How to work", before step 1: *"If the person asks for
an application that does not exist yet, create it with `apps.create` — choose
a short id from its name — and then continue below with that id. Creation
installs dependencies and needs the network once."* Keep the file under the
line limit 08c set. In "What you may not do": nothing changes; the dependency
sentence still holds for a created application.

## Step 4 — the tab

`AppsTable.tsx`: a **New application** button in the card's header (a `Plus`
icon and the words; the rail already uses `lucide-react`). Clicking it opens
an inline form under the heading: *Name* (required), *Id* (derived from the
name as it is typed — lowercase, non-alphanumerics to hyphens, collapsed,
trimmed, prefixed with `app-` if it does not start with a letter, cut to 40
— and editable once the person touches it), *Description* (optional). The
submit button reads *Create* and, while the route is running, *Creating…*
with a sentence under it: "Installing dependencies and building. This can
take a minute the first time." Escape closes the form; focus goes to the
name field on open and back to the button on close, the way `App.tsx` does
for Settings. The form's fields carry the same `max` the contract does.

On success: refresh the list, select the new application, close the form. On
`ok: false`: keep the form open, show `notes` then `problems` in a
`launcher__message--error` block (a `<ul>`, one line per problem, `stage:
message`), and keep what was typed. On a thrown `conflict` or
`invalid_input`, show its message under the id field. If `opened` is false,
show the same "could not open a browser" sentence `appOpen` already shows.

The empty-state row becomes: *No applications yet. Create one above, or
import a workspace with `broapp-autoapp import`.*

`App.tsx`: `ENGINEER_SUGGESTIONS` gains *"Create a new application for…"* as
its first entry — the person completes the sentence. In `onToolResult`, a
finished `apps.create` refreshes the list; once the rows arrive, select the
created id if it is among them (read it from the call's output if the
`BroappChat` callback exposes it — check `broapp-ai-elements`' types — and
otherwise select the row that was not there before).

## Step 5 — the binary, the smoke test, the docs

`scripts/autoapp-smoke.ts`: a step after "import": `create dream --name
"Dream"` exits 0 and prints an id and a release; `releases dream` lists
exactly one, marked current; `status dream` says `granted: nothing`. This
installs from the registry inside the repository's tree, where resolution
still finds the workspace packages, so the step proves the command and the
embedding, not the registry. Say that in the script's comment. If the
registry does not yet carry the versions the starter asks for, the install
fails and the build still passes through the workspace's `node_modules`; the
step must pass either way and print which of the two happened.

Docs, each one paragraph, no new files:

- `docs/autoapp/design.md`: creation beside import as the two ways in; the starter is a source workspace like any other.
- `docs/autoapp/packaging.md`: the template is a build artefact embedded in the binary like the page; creation is the second moment (after import) that may reach the network, and why there is still no offline flag. The offline tiers table gains a row: *Create offline* — refused today; the starter's dependencies come from the registry.
- `docs/autoapp/security.md`: `appCreate` is a person's click; `apps.create` asks. Neither returns a path or a URL.
- `packages/broapp-autoapp/README.md`: the button, in two sentences.
- `skills/broapp/SKILL.md`, Autoapp section: the `create` command.
- `docs/autoapp/backlog.md`: three rows — an `.app` bundle and signing (the other half of "download and double-click"); an AI panel in a created application's own tab, opt-in; a `remove` command, which does not exist and which creation will make people want.

## Verification

```bash
bun run typecheck
bun run --cwd packages/broapp-autoapp build:template
bun test tests/autoapp-create.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run dryrun:autoapp
bun run check
```

Tests, in `tests/autoapp-create.test.ts`, with the root under
`tests/.autoapp-run/create-*` — inside the repository, for the reason
`scripts/autoapp-smoke.ts` gives at its `root`, and say so in the file's
comment since it departs from the common rule — and `install` and `initGit`
injected so nothing reaches the network or needs git:

- the on-disk template packs, contains every `SOURCE` path, and carries each marker where it must;
- `createApplication` builds, writes empty grants, sets `current`, and `listApps` shows the name that was given;
- `writeStarter` leaves no marker and refuses an existing target;
- a bad id is `invalid_input` and makes no directory; a second create of the same id is `conflict` and changes nothing on disk (compare a directory listing before and after);
- an install that reports failure leaves the workspace, writes no `current`, and returns `installed: false` with the build's result — run it twice: once where the build still passes (the repository's `node_modules` is above the root, so it will) and once with a template whose `contract.ts` is broken, to prove problems come back rather than a throw;
- a template that declares a capability is refused with a `spec` problem and no `current`;
- the route over a real bridge (`tests/harness.ts`, the way the launcher's routes are tested elsewhere) returns `ok: true` and calls the injected opener once; `apps.create` on channel `ai` asks before it creates and creates nothing when refused;
- `prepareWorkspace` is what `importApp` uses: the smoke test's "import" step is the assertion, so do not duplicate it here, but do assert that `main.ts` no longer contains a second install spawn (grep for `'install'` occurrences, expect one, in `workspace.ts`).

Every test removes its root in `afterEach`, including on failure, and stops
any child it started.

## Acceptance criteria

- A launcher started with an empty root shows a **New application** button; clicking it, typing a name and pressing Create ends with the application current, open in a tab, and selected in the list — with the engineer's `refs` pointing at it.
- `broapp-autoapp create` and `apps.create` produce the same result through the same function.
- The starter is in git, packed at build time, embedded in every target's binary, present in the published tarball, and checked by the dry run.
- A failed install or build leaves a workspace the engineer can build later, never a deleted directory, and never a `current` that points at nothing.
- `import` behaves exactly as before: the smoke test's import step passes unchanged.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/11-new-application.md`. Include the deadline you
found (or did not) in step 3 and which route shape you built; the registry
outcome of the smoke test's create step; and the size the template adds to
`dist/broapp-autoapp`.

## Commit

```
Create an application from a starter inside the launcher

The launcher carries a starter workspace in its binary. A New application
button, a create command and an apps.create tool write it to disk, install
its dependencies, build it, make it current and open it. Import and create
share one implementation of the steps after the source is on disk.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
