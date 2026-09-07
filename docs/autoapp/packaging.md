# Autoapp: packaging, platforms and offline

The design is in [design.md](design.md); what the gate protects and what it does
not is in [security.md](security.md). This file is about the artifacts: what is
built, where it has actually been run, and which of the offline claims have
evidence behind them.

## The launcher binary

One binary supervises every application on a machine, hosts the engineer, and
serves the MCP adapter. It is built the way an application is — one compiled
Bun executable with its page inlined and its content-security policy pinned to
the hashes the build computed.

```bash
bun run --cwd packages/broapp-autoapp build:launcher            # this machine
bun run --cwd packages/broapp-autoapp build:all                 # every target
bun run --cwd packages/broapp-autoapp scripts/build-launcher.ts --target linux-x64
```

| Target | Suffix | Size | Smoke-tested in CI |
| --- | --- | --- | --- |
| `darwin-arm64` | — | 72.2 MB | yes — `macos-latest` |
| `darwin-x64` | — | 78.6 MB | no runner; compiled only |
| `linux-x64` | — | 89.9 MB | yes — `ubuntu-latest` |
| `linux-arm64` | — | 89.8 MB | no runner; compiled only |
| `linux-x64-musl` | — | 83.9 MB | no runner; compiled only |
| `windows-x64` | `.exe` | 95.9 MB | yes — `windows-latest` |

Sizes are from Bun 1.4.0 with `--compile --bytecode --minify`, measured on
macOS. A Notes binary built from the same tree is 69.9 MB, so the launcher costs
about 2 MB more than an application: almost all of both numbers is the Bun
runtime.

**A cross-compiled binary is compiled, not run.** `bun:sqlite` links a platform
SQLite into the executable, so the only evidence a target works is a run on that
platform. The release workflow keeps "compiled" and "smoke-tested" in separate
columns for the launcher exactly as [../packaging.md](../packaging.md) does for
an application, and the release notes say which is which.

## What runs where

| Check | What it does | Runs on |
| --- | --- | --- |
| `bun test tests/autoapp-*.test.ts` | The modules, over real bridges and real child processes | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| `scripts/autoapp-smoke.ts` | The **compiled binary**: import, serve, the loopback control connection, build, activate, a crash past the switch, recovery, and the control file's removal | the same three |
| `scripts/autoapp-dry-run.ts` | Packs every publishable package, installs them outside the workspace, imports the Notes workspace through them and builds a candidate | the same three |
| `bun run --cwd packages/broapp-autoapp build:all` | Compiles all six targets | `ubuntu-latest` |

The CI job is `autoapp` in `.github/workflows/ci.yml`. Nothing is skipped by
platform; if a case ever has to be, it belongs in the table below with its
reason, not behind a silent `skipIf`.

| Skipped test | Platform | Why |
| --- | --- | --- |
| — | — | Nothing is skipped. |

## Windows

Four differences, each with a comment where the code makes the choice.

- **Moving the `current` pointer.** `renameSync` over an existing file is atomic
  on POSIX; on Windows it goes through `MoveFileEx` with
  `MOVEFILE_REPLACE_EXISTING`, which replaces but can fail against a reader
  holding the file open. `tests/autoapp-spec.test.ts` moves the pointer between
  two releases and runs in the Windows matrix job for that reason. The activation
  journal, not the pointer file, is the record of what was being activated, so a
  torn pointer is recoverable.
- **File modes.** `0600` is not enforced on Windows. `<root>/launcher.json`
  holds the control port and secret, and its protection there is the user
  profile directory's ACL rather than the mode bits. This is stated again in
  [security.md](security.md).
- **`PATH` in the supervision spike.** The spike gives its child a `PATH` that
  leads nowhere, to prove nothing in the chain falls back to a `bun` on the
  path. On Windows `PATH` is also the DLL search path, so the value is empty
  there rather than `/nonexistent`. The child still starts, because it is
  spawned by absolute path from `process.execPath`.
- **Stopping.** A Windows console process is not delivered `SIGTERM` the way a
  POSIX one is, so the launcher also kills its children from
  `process.on('exit')` — `Supervisor.killAll`, synchronous, because an exit
  handler cannot await. The smoke script stops a background launcher with
  `taskkill /F /T` for the same reason: nothing else takes the child tree with
  it.

## Dependencies, and why there is no offline flag

A candidate build must resolve its imports without a network. It does that from
a **vendored dependency directory per application**, not from a warmed cache:

- `<root>/apps/<appId>/source/node_modules` is created at `import` time, by
  `BUN_BE_BUN=1 <launcher> install --production --frozen-lockfile` run in the
  source workspace. That is the one moment dependencies may be fetched.
- Before bundling, `buildCandidate` checks that every top-level dependency in
  the workspace's `package.json` resolves. A missing one is a `host` build
  problem naming the package: *"dependencies are installed when an application
  is imported; re-import to add one"*. The engineer's instructions say the same
  sentence.
- **No flag prevents a socket from opening.** Bun 1.4.0 has no `BUN_OFFLINE`;
  `--offline` is accepted and still downloads, and `--prefer-offline` only skips
  staleness checks. Nothing in this repository claims otherwise, and no
  guarantee here rests on one.

A built release resolves nothing at run time: `Bun.build` inlines every
dependency into `host.js`, and the only specifiers left in it are `bun:sqlite`
and Node builtins. `tests/autoapp-offline.test.ts` asserts both — it deletes the
entire source workspace and starts the release anyway.

## The three offline tiers

| Tier | What is claimed | The evidence | Tested in CI on |
| --- | --- | --- | --- |
| **Run offline** | An installed application's local features work with no network. | A release serves a read and a write with its whole source workspace deleted, and its host bundle imports only `bun:` and Node builtins. | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| **Edit offline** | Changes to an application's source build and activate with no network — as long as they use dependencies that are already installed. The engineer needs a model: with a remote provider it is unavailable offline; with a local one (Ollama) it works. | A source change rebuilds to a new release identity with no network involved, and with a `fetch` that refuses, the provider test and the engineer's chat both report the provider as unreachable rather than hanging. | the same three |
| **Extend dependencies offline** | Refused. Adding a dependency needs the network and a re-import. | A build with a package that was never installed fails with the sentence above, naming the package. | the same three |

What these cases do **not** do is sever the interface — a test may not, and a
flag cannot be trusted to. Each proves the part that is under Broapp's control
and says so in the file's own comment. The one thing genuinely outside it,
`bun install` reaching the registry, is confined to `import` by design and
stated as such rather than tested.

## Publishing

`broapp-autoapp` is published from `.github/workflows/publish.yml`, manually,
with a reviewer on the environment, like every other package here.

Two things are particular to it. Its page is a build artifact — not in git — and
`src/launcher/main.ts` imports it, so the workflow builds the page before
publishing and `files` names `dist/launcher-page.html` explicitly. And it is the
one package with Broapp packages as runtime dependencies rather than peers,
because the launcher binary really does contain them; they are declared by
version range, so they resolve to the workspace copies here and to the registry
everywhere else.

`scripts/autoapp-dry-run.ts` is the check that both of those hold. It packs the
tarballs, installs them in a project outside this repository, and drives the
installed launcher through `import` and `build` against the Notes workspace. A
`files` list that omits the page, or a dependency that only resolves inside the
monorepo, fails there rather than after publication.
