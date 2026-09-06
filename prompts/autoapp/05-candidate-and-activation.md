# 05 — Candidate releases and activation

## Goal

A change becomes an immutable candidate release, is previewed against a
copy of the user's data with external effects refused, and is activated as
a consistent release-and-data pair with a recovery path. After this prompt:
the launcher exists as a library and a binary; it supervises one child per
application over the prompt 02 IPC; it builds a candidate from the source
workspace; it snapshots SQLite consistently; it runs the eight-step
activation with a journal that survives a crash at any step; and on start
it recovers whichever step was interrupted.

No AI in this prompt. The engineer that drives this loop is prompt 07.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far, especially `02-spike.md` for what compiled supervision proved and the facts recorded under criteria 6 to 8.
- `packages/broapp-autoapp/src/ipc/*`, `spike/*`, `src/spec/*`, `src/views/*`, `src/host/views.ts`.
- `packages/broapp/src/host/runtime.ts`, completely. Note how attachment is tracked from the session hook and how `isBusy` is consulted.
- `packages/broapp/src/host/gate.ts` and `app.ts` after prompt 01.
- `packages/broapp/src/cli/build-page.ts`, `build-binary.ts`, `config.ts`, `dev.ts`.
- `examples/notes/src/host/db.ts`, `main.ts`.
- `node_modules/bun-types/sqlite.d.ts`: `Database`, `.run`, `.query`, `.prepare`, `.close`, `.serialize`, `.exec`. Confirm `VACUUM INTO` is run through `.run` or `.exec`.
- `node_modules/bun-types/bun.d.ts`: `Bun.build` `BuildConfig` (`target`, `entrypoints`, `outdir`, `naming`, `external`, `minify`), `Bun.spawn` again.

## Step 1 — two small core changes

Both are named here and allowed by the common rules.

`packages/broapp/src/host/runtime.ts`: `RunningApp` gains
`readonly attached: boolean` — true while at least one endpoint is `open`,
computed from the same session-hook bookkeeping the idle logic uses. No
polling, no new state.

`packages/broapp/src/host/gate.ts`: `Gate` gains `pause(reason: string): void`
and `resume(): void`, and `readonly paused: boolean`. While paused, `guard`
throws `publicError.unavailable(reason)` for `write` and `external` before
deciding anything, and allows `read`. Record nothing for a paused refusal;
it is not a decision. Add four cases to `tests/autoapp-gate.test.ts`:
paused write refused with `unavailable`, paused read allowed, resume
restores, pause during a pending approval does not affect that approval.

## Step 2 — the application module contract

What a release's `host.js` must export, so the child runtime can start it
without knowing what the application is. `packages/broapp-autoapp/src/child/module.ts`:

```ts
import type { Bridge } from 'brobridge';
import type { Gate } from 'broapp/host';

export interface AppStartContext {
  readonly dataDir: string;
  readonly mode: 'live' | 'preview';
  readonly gate: Gate;
  readonly logger: { warn(m: string): void; error(m: string): void };
}

export interface AppInstance {
  register(bridge: Bridge): void | Promise<void>;
  isBusy(): boolean;
  shutdown(reason: string): void | Promise<void>;
  /** The database schema version the opened data is at. */
  readonly schemaVersion: number;
}

export interface AppModule {
  /** Open data, run migrations, prepare handlers. Throws when the data cannot be opened. */
  start(context: AppStartContext): Promise<AppInstance>;
  /** Migrate the databases in `dataDir` forward and report. Must not start serving. */
  migrate(context: { dataDir: string; logger: AppStartContext['logger'] }): Promise<{ from: number; to: number }>;
}
```

`assertAppModule(mod: unknown): AppModule` throws a `TypeError` naming the
missing export.

Rewrite `examples/notes/src/host/main.ts` as two files: `app.ts` exporting
`start` and `migrate` in this shape (using `openStore`, `createApp`,
`createNotesAi`, `createViewsHost`, and the `gate` from the context via
`createHostApp(contract, { gate })`), and `main.ts` for the standalone
binary, which keeps working exactly as before by calling `start` itself
and then `startApp`. The Notes `broapp.config.ts` keeps `main.ts` as the
host entry. The candidate build in Step 5 bundles `app.ts`.

## Step 3 — the child runtime

`packages/broapp-autoapp/src/child/run-child.ts`, invoked by the launcher
binary as `<launcher> --child <releaseDir> <appId> <releaseId> <mode>` with
`BROAPP_DATA_DIR` set. Sequence:

1. Require `process.send`; exit 2 otherwise.
2. Send `hello`.
3. Read `spec.json` (`readRelease`), assert the directory name and the argument agree.
4. `await import(join(releaseDir, spec.manifest.entry.host))`, `assertAppModule`.
5. Build the gate: `createGate({ appId, releaseId, mode, recorder })`. The recorder is a no-op in this prompt; prompt 06 supplies one.
6. `instance = await module.start({...})`. On throw: send `fatal` with a one-sentence reason, exit 4.
7. `startApp({ page: readFileSync(join(releaseDir, entry.page), 'utf8'), appName: spec.manifest.name, version: releaseId, mode: 'background', openBrowser: false, register: instance.register, isBusy: instance.isBusy, onShutdown: instance.shutdown })`.
8. Send `ready` with `url: running.bridge.url` and `schemaVersion`.
9. Answer `health` with `state`, `activeWork` (`instance.isBusy() ? 1 : 0` plus `app.activeStreams` if reachable through the instance; keep the field an integer), `attached: running.attached`.
10. On `drain`: `gate.pause('the application is being updated')`, state `draining`; poll `isBusy()` every 100 ms; reply `drained: true` when idle, or `drained: false` at the deadline.
11. On `shutdown`: `await running.stop('requested')`, exit 0.
12. On `migrate` (new message: `{ type: 'migrate', dataDir }` from the launcher, reply `{ type: 'migrate', re, from, to }` or `{ type: 'fatal' }`): this is a separate invocation mode `<launcher> --migrate <releaseDir> <appId> <releaseId>` that imports the module, calls `migrate`, replies and exits 0. It never calls `start`. Add `Migrate` to `ipc/messages.ts`.

The child's environment is built by the launcher: `PATH` as the launcher
has it (the application is trusted local code and may need tools), `HOME`,
`TMPDIR`/`TEMP`, `BROAPP_DATA_DIR`, `BROAPP_LIFECYCLE=background`,
`BROAPP_OPEN_BROWSER=0`. Nothing else. Say in a comment that this is
tidiness, not containment.

## Step 4 — the supervisor

`packages/broapp-autoapp/src/launcher/supervisor.ts`:

```ts
export interface ChildHandle {
  readonly appId: string;
  readonly releaseId: string;
  readonly mode: 'live' | 'preview';
  readonly pid: number;
  /** From `ready`. Never written to disk. */
  readonly url: string;
  readonly schemaVersion: number;
  health(): Promise<Health>;
  drain(deadlineMs: number): Promise<boolean>;
  shutdown(deadlineMs: number): Promise<{ exitCode: number | null; killed: boolean }>;
  readonly exited: Promise<number | null>;
}

export interface SupervisorOptions {
  readonly execPath?: string;          // default process.execPath
  readonly helloTimeoutMs?: number;    // 5_000
  readonly readyTimeoutMs?: number;    // 30_000
  readonly logger?: HostLogger;
}

export interface Supervisor {
  start(params: { appId; releaseDir; releaseId; dataDir; mode }): Promise<ChildHandle>;
  migrate(params: { appId; releaseDir; releaseId; dataDir }): Promise<{ from: number; to: number }>;
  /** Every child still alive. */
  readonly children: readonly ChildHandle[];
  /** Shut everything down; used at launcher exit. */
  stopAll(deadlineMs: number): Promise<void>;
}
export function createSupervisor(options?: SupervisorOptions): Supervisor;
```

Deadlines on every wait. A child that exits before `ready` rejects
`start` with the `fatal` reason if one arrived, else the exit code. A
`shutdown` past its deadline kills. `stopAll` is registered on
`SIGINT`/`SIGTERM` and `beforeExit` of the launcher so no child outlives it.

## Step 5 — building a candidate

`packages/broapp-autoapp/src/launcher/candidate.ts`:

```ts
export interface BuildCandidateParams {
  readonly layout: Layout;
  readonly appId: string;
  /** Defaults to the app's source workspace. */
  readonly sourceDir?: string;
  readonly logger?: HostLogger;
}
export interface BuildProblem { readonly stage: 'contract' | 'views' | 'page' | 'host' | 'spec'; readonly message: string }
export type BuildCandidateResult =
  | { readonly ok: true; readonly releaseId: string; readonly spec: AppSpec }
  | { readonly ok: false; readonly problems: readonly BuildProblem[] };
export function buildCandidate(params): Promise<BuildCandidateResult>;
```

The source workspace has a fixed shape, which the engineer is told in
prompt 07 and which Notes is converted to in Step 8:

```
<source>/autoapp.json           { appId, name, schemaVersion, capabilities, migrations, acceptance }
<source>/src/shared/contract.ts
<source>/src/shared/views.ts    export const views: ViewsSpec
<source>/src/host/app.ts        exports start, migrate
<source>/src/ui/main.tsx        the browser entry (renderer + chat)
<source>/src/ui/index.html
<source>/package.json           dependencies must already be resolvable; see prompt 09
```

Steps, each producing a `BuildProblem` on failure instead of throwing:

1. Bundle `src/shared/contract.ts` and `src/shared/views.ts` for `target: 'bun'` into a temporary directory and import them from there to obtain `contract` and `views`. Importing straight from the source tree would let the workspace's `node_modules` resolution differ from the bundle's; bundling first keeps it honest. Then `exportContract` and `parseViews`, and `checkViewsAgainstContract`.
2. `buildPage` from `broapp/build` with the workspace's entry and template into the temporary directory.
3. `Bun.build` `src/host/app.ts` with `target: 'bun'`, `format: 'esm'`, `external: ['bun:sqlite']` and, if `BUN_BE_BUN`-based builds were proven in report 02, run the build through the launcher's own binary; otherwise call `Bun.build` in-process and record in the report that the launcher process ran the bundler (not application code — the bundler does not execute the modules it bundles).
4. Compose the `AppManifest` (runtime versions from the packages' `package.json` files and `Bun.version`), compute `releaseId`, assemble the `AppSpec`, `parseSpec`.
5. `writeRelease`. A second build of identical sources produces the same `releaseId` and is a no-op success.

## Step 6 — snapshots

`packages/broapp-autoapp/src/launcher/snapshot.ts`:

- `snapshotDirectory(dataDir, targetDir)`: creates `targetDir` (must not exist), then for every regular file directly under `dataDir`: if its name ends in `.sqlite`, open it read-only with `bun:sqlite` and `VACUUM INTO '<target path>'`; otherwise `copyFileSync`. Subdirectories are copied recursively with the same rule. `-wal` and `-shm` files are skipped (their content is folded in by `VACUUM INTO`). Returns the list of files with sizes.
- Runs while a child may still hold the database open; that is why it is `VACUUM INTO` and not a copy. It is still called only **after** drain in activation, so the copy is quiescent as well as consistent.
- `snapshotToFile(dataDir, dbName, targetFile)` for a single database, used by the preview path and by Step 8's tests.

## Step 7 — activation

`packages/broapp-autoapp/src/launcher/journal.ts`: `journal.sqlite` with
one table:

```sql
CREATE TABLE activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT    NOT NULL,
  from_release  TEXT,
  to_release    TEXT    NOT NULL,
  phase         TEXT    NOT NULL,       -- see list
  data_prev     TEXT,                   -- directory name once renamed
  snapshot_dir  TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  error         TEXT
);
```

Phases, in order: `requested`, `drained`, `snapshotted`, `migrated`,
`checked`, `switched`, `serving`, `done`; and terminal failures
`failed-before-switch`, `failed-after-switch`, `rolled-back`. Every phase
transition is one `UPDATE` inside a transaction with `updated_at`.

`packages/broapp-autoapp/src/launcher/activate.ts`:

```ts
export interface ActivateParams {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly appId: string;
  readonly releaseId: string;
  readonly drainDeadlineMs?: number;   // 10_000
  readonly logger?: HostLogger;
}
export type ActivateResult =
  | { readonly ok: true; readonly child: ChildHandle; readonly previousRelease: string | null }
  | { readonly ok: false; readonly phase: string; readonly reason: string; readonly recovered: 'previous-serving' | 'stopped' };
export function activate(params: ActivateParams): Promise<ActivateResult>;
```

The eight steps, each advancing the journal before it acts (write-ahead):

1. `requested`: `readRelease(to)`, check the capability diff against
   `readGrants`; if `added` is non-empty, fail with reason "release asks
   for capabilities that have not been granted" — the grant is prompt 07's
   job, this function only checks. Check `spec.manifest.schemaVersion >= current child's schemaVersion`.
2. `drained`: `child.drain(deadline)`. `false` → fail, `resume` is
   implicit because the child is left running; result `recovered: 'previous-serving'`.
3. `snapshotted`: `child.shutdown(deadline)`; then `snapshotDirectory(data, snapshots/<startedAt>-<from>)`; then `snapshotDirectory(data, data-next)`.
4. `migrated`: `supervisor.migrate({ releaseDir: to, dataDir: data-next })`. On failure: remove `data-next`, restart the previous release on `data`, `failed-before-switch`, `recovered: 'previous-serving'`.
5. `checked`: start the candidate on `data-next` in mode `live` but with the gate **paused** (add a `paused: true` start option that the child honours by calling `gate.pause` before `ready`); `health()` must return `serving`; run every `acceptance` example from the spec against it through a Brobridge client (`@brobridgejs/client`, reuse the pattern from `tests/harness.ts`; the launcher is the one process allowed to hold a child's launch URL in memory) with channel `user` semantics — they are read-only checks unless an example names a write, and a write against `data-next` before the switch is harmless because `data-next` is discarded on failure. Failure: shut the candidate down, remove `data-next`, restart previous on `data`, `failed-before-switch`.
6. `switched`: shut the candidate down (so no process holds `data-next` open), `renameSync(data, data-prev-<startedAt>)`, `renameSync(data-next, data)`, `setCurrent(to)`. Journal `data_prev`. This is the point of no return for the pair; record it as such in a comment.
7. `serving`: start the new release on `data` unpaused. Failure here is `failed-after-switch`: attempt the reverse rename and `setCurrent(from)` **only if** the new child never sent `ready`; if it did, leave it, because a write may already have happened, and mark the journal so recovery knows.
8. `done`.

## Step 8 — recovery on launcher start

`packages/broapp-autoapp/src/launcher/recover.ts`: `recover(layout, journal, supervisor)`
reads every activation not in a terminal phase or `done` and resolves it:

| Interrupted at | Action |
|---|---|
| `requested`, `drained` | Mark `failed-before-switch`. Start `current` on `data`. |
| `snapshotted`, `migrated`, `checked` | Remove `data-next` if present. Mark `failed-before-switch`. Start `current` on `data`. |
| `switched` | Both renames done? (`data` exists and `data-prev` exists and `current` = `to`) → continue to serve `to`, mark `serving` then `done`. Only the first rename done? (`data` missing, `data-prev` present, `data-next` present) → finish the second rename, `setCurrent(to)`, serve. |
| `serving` | Serve `current` on `data`, mark `done`. |

Recovery never deletes a `data-prev-*` directory or a snapshot. Cleanup
is a separate, explicit `prune` in prompt 10's backlog.

## Step 9 — the launcher binary

`packages/broapp-autoapp/src/launcher/main.ts`, compiled by
`bun build --compile --bytecode --minify`. Dispatch on `argv[2]`:

- `--child ...` → `run-child.ts`. `--migrate ...` → the migrate mode.
- `serve <appId>` → recover, then start `current` on `data`, print the child's URL once (it is a credential; do not log it elsewhere), open the browser unless `--no-open`, keep the launcher alive until the child exits or a signal arrives.
- `import <sourceDir> --as <appId>` → copy the source workspace into `apps/<appId>/source`, `git init` there if `git` is on `PATH` (record that it is optional; the launcher must work without git), build a candidate, write grants for the requested capabilities **only after** printing them and reading `y` from stdin (or `--grant` to skip in tests), set current, and exit. This is the developer's way in; the engineer's way is prompt 07.
- `build <appId>` → `buildCandidate`, print `releaseId` or problems.
- `activate <appId> <releaseId>` → `activate`, print the result.
- `releases <appId>`, `status <appId>` → lists from the store and the journal.

The launcher's own Broapp tab (apps list, engineer chat) is prompt 07; here
the launcher is a CLI plus supervisor. Add `"bin": { "broapp-autoapp": "src/launcher/main.ts" }`
and a script `"build:launcher"` that compiles it to `dist/broapp-autoapp`.

## Step 10 — tests

`tests/autoapp-activation.test.ts`. Uses the compiled launcher for child
processes (compile once in `beforeAll` like prompt 02) and a small fixture
application under `tests/fixtures/autoapp-app/` in the Step 5 workspace
shape: one table `items`, three migrations, `items.list` (read),
`items.add` (write), `items.ping` (external, returns `{ ok: true }` without
touching anything), one acceptance example calling `items.list`.

1. `buildCandidate` on the fixture yields a release; rebuilding is a no-op with the same id; a fixture variant with a route lacking `effect` yields a `contract` problem; a variant whose views name a missing route yields a `views` problem.
2. `snapshotDirectory` while a child is serving and writing (a loop calling `items.add` over the harness client) produces a copy that opens with `PRAGMA integrity_check` = `ok` and a row count between the counts observed before and after the snapshot.
3. Preview mode: start the fixture in `preview`; `items.ping` from a client is `rejected`; `items.add` succeeds; the live data directory is untouched.
4. Happy activation from release A (schema 2) to B (schema 3): journal reaches `done`; the child reports `schemaVersion: 3`; `data-prev-*` exists with schema 2; the pre-activation snapshot exists; `readCurrent` is B.
5. Migration failure (fixture variant whose migration 3 throws): journal `failed-before-switch`; release A serving on unchanged `data`; no `data-next` left.
6. Acceptance failure (variant whose `items.list` output contradicts the example): same recovery as 5.
7. Drain timeout: a fixture stream that never ends, `drainDeadlineMs: 300` → `recovered: 'previous-serving'`, the stream is still open afterwards.
8. Crash injection: an environment variable `AUTOAPP_TEST_CRASH_AT=<phase>` makes `activate` throw immediately after journaling that phase; for each of `snapshotted`, `migrated`, `checked`, `switched` (after the first rename and after both), `serving`: run, observe the throw, run `recover`, assert the table in Step 8. The variable is honoured only when `NODE_ENV === 'test'`; say so in a comment.
9. Capability diff: a release adding a `network` capability without a grant fails at `requested`.
10. `pause`/`resume` cases from Step 1.
11. `stopAll` on launcher `SIGTERM` leaves no child; verify by pid.

Every test removes its temp root and kills stray children in `afterEach`.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-gate.test.ts
bun test tests/autoapp-activation.test.ts
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run check
```

Then by hand: `bun run --cwd packages/broapp-autoapp build:launcher`,
`dist/broapp-autoapp import ../../examples/notes --as notes --grant`,
`dist/broapp-autoapp serve notes`, use Notes in the browser. Then edit the
Notes source workspace to add the `pinned` column to `notes.list` output
and the table, `build notes`, `activate notes <id>`, reload the tab, see
the column. Record it.

## Acceptance criteria

- The launcher process never imports a release's `host.js`; `grep -rn "entry.host" packages/broapp-autoapp/src/launcher` shows only path construction passed to a child.
- Every activation phase is journaled before the action it names.
- Crash injection at every phase recovers to a serving application, and the report lists each phase with the observed recovery.
- A drain that times out leaves the previous release serving.
- Snapshot under concurrent writes passes `integrity_check`.

## Report

`prompts/autoapp/reports/05-activation.md`. Include the crash-injection table and the manual Notes activation notes.

## Commit

```
Add candidate releases, supervision and activation

The launcher supervises one child per application over IPC, builds a
candidate release from the source workspace, snapshots SQLite with
VACUUM INTO, and activates a release-and-data pair through a journaled
eight-step sequence that recovers from a crash at any step. Preview mode
refuses external effects through the gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
