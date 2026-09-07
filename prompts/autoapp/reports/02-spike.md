# 02 — Spike: compiled supervision

macOS (Darwin 25.6.0, arm64). Bun 1.4.0 (34cbb9a40).

All five behavioural criteria pass. Criteria 6–8 are recorded below.

## What was built

- `packages/broapp-autoapp/`: `package.json` exactly as the prompt gives it,
  `tsconfig.json`, `README.md`, `src/index.ts` (empty, with a note).
- `src/ipc/messages.ts`: the six message types, `IPC_VERSION`,
  `MAX_MESSAGE_BYTES`.
- `src/ipc/codec.ts`: `parseMessage` and `isMessage`. Size is checked first,
  then `v`, then `id`, then `type`, then every field of that type.
- `spike/launcher.ts`, `spike/child.ts`, `spike/app-v1/index.ts`,
  `spike/README.md`.
- `tests/autoapp-spike.test.ts`: 14 tests — 5 over the compiled binary, 9 unit
  cases for `parseMessage`.

## The happy path

```
$ BROAPP_DATA_DIR=$(mktemp -d) packages/broapp-autoapp/spike/dist/launcher \
    "$PWD/packages/broapp-autoapp/spike/app-v1/index.ts" app-1 rel-1
{"hello":true,"ready":true,"schemaVersion":1,"health":"serving","drained":true,"exitCode":0,"killed":false,"elapsedMs":15}
$ cat $BROAPP_DATA_DIR/spike.log
started
```

## Acceptance criteria

1. **Compiled launcher spawns compiled child over IPC, `PATH=/nonexistent`** —
   **pass**. All six messages round-trip; the child's environment is built by
   `childEnv()` and contains only `PATH=/nonexistent`, `HOME`, `TMPDIR`/`TEMP`,
   `BROAPP_DATA_DIR` and `AUTOAPP_SPIKE_MISBEHAVE`.
2. **Child imports an artifact by absolute path that is not in the bundle** —
   **pass**. `spike.log` contains `started`, written by the artifact from inside
   the child. `bun build` reports `bundle 4 modules`, which is
   launcher + child + codec + messages; the artifact is not among them.
   TypeScript source is transpiled at runtime by the compiled binary, with no
   Bun on the path.
3. **A child ignoring `shutdown` is killed and the launcher still reports** —
   **pass**: `{"…","exitCode":143,"killed":true,"elapsedMs":2013}`, launcher
   exits 0.
4. **A missing `hello` is caught by deadline, no child left behind** — **pass**:
   `{"error":"timed out waiting for hello","pid":98666,"childExit":143}`,
   launcher exits 1. The test probes the pid with signal 0 and finds it gone.
5. **`v: 2` is refused with exit code 3** — **pass**:
   `{"error":"message protocol version 2 is not 1","pid":98671,"childExit":3}`,
   launcher exits 1.
6. **Binary size** — `spike/dist/launcher` is **63,976,562 bytes = 64.0 MB
   (61.0 MiB)**, built with `--compile --bytecode --minify`. `--bytecode` was
   accepted; nothing had to be removed.
7. **`BUN_BE_BUN=1 <launcher> install --offline`** — **works**:

   ```
   $ cd "$(mktemp -d)"   # package.json depends on @types/react-dom@19.2.7
   $ BUN_BE_BUN=1 /…/spike/dist/launcher install --offline
   bun install v1.4.0 (34cbb9a40)
   Resolving dependencies
   Resolved, downloaded and extracted [2]
   Saved lockfile

   + @types/react-dom@19.2.7

   3 packages installed [614.00ms]
   ```

   `node_modules/` was created with `@types` and `csstype`. Caveat: the machine
   had a warmed global cache and the network was not severed, so this shows the
   flag is accepted and satisfied from cache, not that no socket was opened.
   `is-odd` is not in this workspace; `@types/react-dom@19.2.7` was chosen
   because it is present and has no `dependencies`.
   `BUN_BE_BUN=1 <launcher> --version` prints `1.4.0`.
8. **`BUN_BE_BUN=1 <launcher> build --target=browser`** — **works**:

   ```
   $ BUN_BE_BUN=1 /…/spike/dist/launcher build --target=browser page.ts --outfile out.js
   Bundled 1 module in 4ms

     out.js  113 bytes  (entry point)
   ```

   The output is transpiled, browser-target JavaScript.

## Decisions I made

- **A `fatal` sent launcher → child.** The common rules say an unknown `v` is
  "rejected with `fatal` and exit code 3", but the launcher must exit 1, and
  `fatal` is documented child → launcher. So the launcher answers an unreadable
  message by sending the child a `fatal`, and the child treats an inbound
  `fatal` as a refused channel and exits 3. That gives the prompt's required
  outcome (child 3, launcher 1) without inventing a seventh message type.
- **The launcher reports a child's `fatal` immediately** rather than waiting out
  the `ready` deadline. A child that has declared itself lost will not send what
  is being waited for, and its reason is far more useful than a timeout.
- **The child calls `process.disconnect()` before returning.** Without it the
  open IPC channel keeps the event loop alive and the child never exits, which
  is what the first run of the happy path showed (`exitCode: 143, killed: true`).
- **`tests/autoapp-spike.test.ts` compiles at module load**, not in `beforeAll`:
  `describe.skipIf` is evaluated at registration, so whether the binary exists
  has to be known before then. It skips with a printed reason rather than
  failing every case.
- **`packages/*/spike/**/*.ts` added to the root `tsconfig.json` `include`.**
  That file lists globs, not `references`, and the spike is real code that
  should be typechecked. This is the only change to a root file.
- The commit trailer names Claude Opus 5, per this session's attribution
  instruction, rather than the model named in the prompt.

## One thing that cost fifteen minutes, and matters for prompt 05

The launcher gives its child `stderr: 'inherit'`. A child that outlives the
launcher therefore keeps the launcher's stderr descriptor open, and in a parent
that spawned the launcher with `stderr: 'pipe'`, `Subprocess.exited` does not
settle until that descriptor closes. The first version of the test drained only
stdout, and the `no-hello` case hung for 916 seconds against a 20-second test
timeout — the timeout was reported but the pending promise was not cancelled.
The test now drains both pipes. **Prompt 05 has to decide** whether the real
launcher pipes and drains its children's stderr itself instead of handing them
an inherited descriptor.

## Commands run

```
bun install                          exit 0
bun run typecheck                    exit 0
bun test tests/autoapp-spike.test.ts 14 pass, 0 fail [11.13s]
bun run check                        exit 0 - 259 pass, 0 fail (20 files) [21.55s]
```

## Open questions

- Whether `--offline` genuinely avoids the network cannot be settled without a
  machine that has none. Prompt 09 should test it with the interface down.
- The 64 MB binary is one copy of the Bun runtime per compiled artifact. If each
  candidate release is compiled separately, disk grows by that much per release;
  prompt 05 or 09 needs a position on retention.
