# 02 — Spike: compiled supervision

## Goal

Prove, with compiled binaries and not with `bun run`, that the chain the
launcher depends on works on this machine: a compiled launcher spawns a
compiled child of itself over IPC, the child loads a versioned application
artifact from outside its bundle with no Bun installation on `PATH`, the
six IPC messages round-trip with deadlines, and a child that ignores
`shutdown` is killed.

This is a spike. It produces the package skeleton, one spike directory,
one test file and a report. It does not produce the launcher. If any
acceptance criterion fails, **stop, write the report, do not continue to
prompt 03.**

## Read first

- `prompts/autoapp/00-common-rules.md` and `reports/01-gate.md`.
- `node_modules/bun-types/bun.d.ts`: search `spawn(`, `ipc`, `serialization`, `Subprocess`, `send(`, `disconnect(`, `exited`, `kill(`. Confirm every name before use.
- `packages/broapp/src/cli/build-binary.ts` — how the repository compiles today.
- `examples/notes/src/host/main.ts` — the `main().then(...)` shape.
- `scripts/smoke-binary.ts` — how a binary is exercised in CI.
- `tests/harness.ts`.

## Step 1 — the package skeleton

Create `packages/broapp-autoapp/`:

```
package.json
tsconfig.json
README.md              three sentences; says "trusted local code" where relevant
src/index.ts           export {} for now; a comment says what will live here
src/ipc/messages.ts    the six message types, below
src/ipc/codec.ts       parse/validate an incoming message; reject unknown v
spike/launcher.ts      the spike's launcher entry
spike/child.ts         the spike's child entry
spike/app-v1/index.ts  a fake application artifact: exports `start()`
spike/README.md        what the spike proves, how to rerun it
```

`package.json`:

```json
{
  "name": "broapp-autoapp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "A Broapp application its owner can reshape while using it: launcher, renderer, specification, engineer, activation",
  "license": "MIT",
  "engines": { "bun": ">=1.4.0" },
  "exports": {
    ".": "./src/index.ts",
    "./package.json": "./package.json"
  },
  "dependencies": { "broapp": "workspace:*" },
  "peerDependencies": { "react": ">=18" },
  "peerDependenciesMeta": { "react": { "optional": true } }
}
```

`tsconfig.json` extends `../../tsconfig.base.json` exactly as
`packages/broapp/tsconfig.json` does. Add the package to the root
`tsconfig.json` `references` if that file lists packages; otherwise leave it.
Run `bun install` and confirm `bun run typecheck` still passes with the
empty package.

## Step 2 — messages

`src/ipc/messages.ts`:

```ts
export const IPC_VERSION = 1 as const;

interface Base {
  readonly v: typeof IPC_VERSION;
  /** Unique per message. A reply carries the request's id in `re`. */
  readonly id: string;
  readonly re?: string;
}

/** Child → launcher, first message, within `helloTimeoutMs` of spawn. */
export interface Hello extends Base {
  readonly type: 'hello';
  readonly appId: string;
  readonly releaseId: string;
  readonly pid: number;
}

/** Child → launcher, when its bridge is bound and serving. */
export interface Ready extends Base {
  readonly type: 'ready';
  /** The launch URL, token included. Never persisted by the launcher. */
  readonly url: string;
  readonly schemaVersion: number;
}

/** Launcher → child request, and child → launcher reply with the same type and `re`. */
export interface Health extends Base {
  readonly type: 'health';
  readonly state?: 'starting' | 'serving' | 'draining' | 'stopping';
  readonly activeWork?: number;
  readonly attached?: boolean;
}

/** Launcher → child: stop admitting new work; reply when `activeWork` is 0 or the deadline passes. */
export interface Drain extends Base {
  readonly type: 'drain';
  readonly deadlineMs: number;
  readonly drained?: boolean;
}

/** Launcher → child: exit cleanly within the deadline or be killed. */
export interface Shutdown extends Base {
  readonly type: 'shutdown';
  readonly deadlineMs: number;
}

/** Child → launcher: something unrecoverable; the child exits after sending. */
export interface Fatal extends Base {
  readonly type: 'fatal';
  /** One sentence, no stack, no secret. */
  readonly reason: string;
}

export type Message = Hello | Ready | Health | Drain | Shutdown | Fatal;
export const MAX_MESSAGE_BYTES = 16_384;
```

`src/ipc/codec.ts` exports `parseMessage(raw: unknown): Message` which
throws `TypeError` for: not an object; `v !== 1`; unknown `type`; missing
`id`; any field of the wrong type; a serialized size over
`MAX_MESSAGE_BYTES`. And `isMessage(raw): raw is Message`.

## Step 3 — the spike entries

`spike/child.ts`. Invoked as `<binary> --child <artifactPath> <appId> <releaseId>`.
On start: `process.send` is required; if absent, print one line and exit 2.
Send `hello`. Then `await import(artifactPath)` and call its `start()`,
which returns `{ schemaVersion: number, stop(): Promise<void> }`. Send
`ready` with `url: 'spike://none'`. Answer `health`. On `drain`, set state
`draining`, reply `drained: true` immediately (the spike has no work). On
`shutdown`, call `stop()`, reply nothing, exit 0. On a message that fails
`parseMessage`, send `fatal` and exit 3.

The child also honours an environment variable `AUTOAPP_SPIKE_MISBEHAVE`:
`ignore-shutdown` means it never exits on `shutdown`; `no-hello` means it
never sends `hello`; `bad-version` means its `hello` carries `v: 2`.
These exist for the tests and are documented in `spike/README.md`.

`spike/launcher.ts`. One entry file that is both roles: if
`process.argv[2] === '--child'` it runs the child code (import
`./child.ts` and call its `main`), otherwise it is the launcher. The
launcher: spawns `process.execPath` with `['--child', artifact, appId, releaseId]`,
`ipc` handler, `serialization: 'json'`, `env` = a **clean** environment
containing only `PATH=/nonexistent`, `HOME`, `TMPDIR`/`TEMP`, `BROAPP_DATA_DIR`
and `AUTOAPP_SPIKE_MISBEHAVE` when set. `PATH=/nonexistent` is deliberate:
it proves no `bun` on `PATH` is used. Waits for `hello` (deadline 5 000 ms)
and `ready` (10 000 ms), sends `health` and awaits the reply, sends `drain`
and awaits `drained`, sends `shutdown` with `deadlineMs: 2000`, waits for
exit; if exit has not happened by the deadline, `kill()` and record
`killed: true`. Prints one JSON line to stdout:

```json
{"hello":true,"ready":true,"schemaVersion":1,"health":"serving","drained":true,"exitCode":0,"killed":false,"elapsedMs":123}
```

Every wait has a deadline; the launcher never hangs. On any failure it
prints `{"error":"<one sentence>"}` and exits 1, killing the child first.

`spike/app-v1/index.ts` exports `start()` returning `schemaVersion: 1`, and
writes `started\n` to `join(process.env.BROAPP_DATA_DIR, 'spike.log')` so the
test can see it ran in the child, not the launcher. Note: this file is
imported by absolute path at runtime and must **not** be reachable from the
launcher's bundle by a static import, or the spike proves nothing. Keep it
out of every `import` statement.

## Step 4 — compile

```bash
cd packages/broapp-autoapp
bun build --compile --bytecode --minify spike/launcher.ts --outfile spike/dist/launcher
```

If `--bytecode` rejects something, remove it, record why, and add a line to
the report: bytecode compilation is what `broapp build` uses by default, so
the launcher's real build will need the same fix.

## Step 5 — the test

`tests/autoapp-spike.test.ts`. It compiles the launcher once in
`beforeAll` (skip the whole file with `test.skip` and a printed reason if
`bun build --compile` is unavailable, never fail silently), then:

1. Happy path: runs `spike/dist/launcher <absolute app-v1 path> app-1 rel-1`
   with a temp `BROAPP_DATA_DIR`; asserts the JSON line has `hello`,
   `ready`, `schemaVersion: 1`, `health: 'serving'`, `drained: true`,
   `exitCode: 0`, `killed: false`; asserts `spike.log` contains `started`.
2. `ignore-shutdown`: `killed: true`, launcher still exits 0 within 5 s.
3. `no-hello`: launcher prints `{"error": ...}` mentioning `hello`, exits 1, no child remains (check by pid from the error line or by the process table via `ps -p`).
4. `bad-version`: child exits 3 (the launcher reports it), launcher exits 1.
5. Wrong artifact path: launcher reports the child's `fatal`, exits 1.
6. `parseMessage` unit cases: each rejection reason above.

Every test kills any child it started in `afterEach`, even on failure.

## Step 6 — dependency install with `BUN_BE_BUN`

Not part of the launcher yet, but part of what this spike must establish.
In a temp directory with a `package.json` naming one tiny dependency
already in the workspace's `node_modules` (pick `is-odd` only if it is
present; otherwise choose the smallest package under `node_modules` that
has no dependencies and record which), run:

```bash
BUN_BE_BUN=1 packages/broapp-autoapp/spike/dist/launcher install --offline
```

Record whether `--offline` works from the warmed cache, and separately
whether `BUN_BE_BUN=1 <launcher> build --target=browser <file>` produces
output. These two facts decide prompt 09's design. Do not build anything
on them here.

## Verification

```bash
bun install
bun run typecheck
bun test tests/autoapp-spike.test.ts
bun run check
```

## Acceptance criteria

State each with pass or fail in the report:

1. Compiled launcher spawns compiled child via `process.execPath`, IPC round-trips all six messages, with `PATH=/nonexistent` in the child.
2. Child dynamically imports an artifact by absolute path that is not in the bundle; proof is `spike.log`.
3. A child ignoring `shutdown` is killed within the deadline and the launcher still reports.
4. A missing `hello` is detected by deadline, and no child process is left behind.
5. `v: 2` is refused with exit code 3.
6. Binary size of `spike/dist/launcher` recorded, in MB.
7. `BUN_BE_BUN=1 <launcher> install --offline` result recorded.
8. `BUN_BE_BUN=1 <launcher> build` result recorded.

Criteria 1 to 5 must pass to continue. 6 to 8 are recorded facts.

## Report

`prompts/autoapp/reports/02-spike.md`. Include the OS and Bun version, the
JSON line from the happy path, the size, and the exact commands for 7 and 8
with their final output lines. If any of 1 to 5 failed, write **STOP** as
the first line and the reason in the next.

## Commit

```
Spike compiled supervision for the Autoapp launcher

A compiled launcher spawns a compiled child of itself over IPC with no
Bun on PATH, the child loads an application artifact by absolute path,
the six lifecycle messages round-trip with deadlines, and a child that
ignores shutdown is killed. Package skeleton for broapp-autoapp.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
