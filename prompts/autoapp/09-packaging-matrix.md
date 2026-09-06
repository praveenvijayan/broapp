# 09 — Packaging matrix and offline tiers

## Goal

What prompts 02 and 05 proved on one machine is proved on every supported
platform, in CI, and the offline guarantees the documentation makes are
exactly the ones that were tested. After this prompt: the supervision
chain, candidate build, activation and crash recovery run in CI on Linux,
macOS and Windows; dependencies for a candidate build come from a fixed
packaged set, not a warmed cache; the three offline tiers are documented
with the evidence; and `broapp-autoapp` is publishable.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far, especially `02-spike.md` criteria 6 to 8 and any Windows notes in 03 and 05.
- `.github/workflows/ci.yml`, `release.yml`, `publish.yml`.
- `scripts/release-dry-run.ts`, `scripts/smoke-binary.ts`, `scripts/pack-local.ts`.
- `packages/broapp/src/cli/targets.ts`.
- `docs/packaging.md`, `docs/limitations.md`.

## Step 1 — the fixed dependency set

A candidate build must resolve `import`s without network. The design is
**a vendored dependency directory per application**, not a warmed cache:

- `<app>/source/node_modules` is created at `import` time (prompt 05's
  command) by `BUN_BE_BUN=1 <launcher> install --production --frozen-lockfile`
  run in the source workspace, with the network. That is the one moment
  dependencies may be fetched; the report from prompt 02 says whether
  `--offline` from a warmed cache also works, but nothing here relies on
  it.
- `buildCandidate` runs with the environment variable `BUN_OFFLINE=1`
  if Bun honours it (check `bun-types` and `bun --help` output for the
  current offline flag; record what exists) and, regardless, asserts
  before bundling that every top-level dependency in `package.json`
  resolves under `source/node_modules`. A missing one is a `host` build
  problem naming the package, with the sentence "dependencies are installed
  when an application is imported; re-import to add one".
- The engineer's instructions (prompt 07) already forbid adding
  dependencies; add the same sentence there.

Copy semantics for `Bun.build`: bundling inlines dependencies into
`host.js`, so the release directory carries everything it needs and never
resolves `node_modules` at runtime. Assert that in a test: move
`source/node_modules` away, start the release, it serves.

## Step 2 — the CI matrix

Add a job `autoapp` to `ci.yml`:

```yaml
  autoapp:
    name: Autoapp — ${{ matrix.os }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: bun install --frozen-lockfile
      - run: bun run --cwd packages/broapp-autoapp build:launcher
      - run: bun test tests/autoapp-spike.test.ts tests/autoapp-activation.test.ts tests/autoapp-mcp.test.ts
      - run: bun run scripts/autoapp-smoke.ts
```

`scripts/autoapp-smoke.ts`: with the compiled launcher and the prompt 05
fixture, from a temporary root: `import`, `serve --no-open` in the
background, wait for the control file, `describe` over the control
connection, build a second release from a modified fixture, `activate`,
kill the launcher with `SIGKILL` (on Windows, `taskkill /F`) during an
activation started with `AUTOAPP_TEST_CRASH_AT=switched`, start `serve`
again, assert recovery reached `done`, stop cleanly. Exit non-zero on any
deviation with a one-line reason. This is the test that runs the real
binary end to end where the unit tests use `bun test` processes.

Windows specifics to resolve, each with a code comment and a report line:

- `renameSync` over an existing `current` file: verify it replaces; if it
  does not, write `current.tmp` and use `fs.renameSync` after
  `unlinkSync` inside a try, and journal the pointer in `journal.sqlite`
  as the source of truth so a torn pointer file is recoverable.
- File mode `0600` is not enforced; the control secret's protection on
  Windows is the user profile directory's ACL. Say so in `docs/autoapp/security.md`.
- `Bun.spawn` with `ipc` and `PATH=/nonexistent` in the spike: use an
  empty `PATH` on Windows and confirm the child still starts from
  `process.execPath`.
- `SIGTERM` handling: the supervisor's `stopAll` must run on
  `process.on('exit')` as well, because Windows has no `SIGTERM` delivery
  to a console process in the same way.

Record any test that had to be skipped on a platform, with the reason, in
`docs/autoapp/packaging.md`. A skipped test is documented, never hidden.

## Step 3 — the three tiers, tested

Add `tests/autoapp-offline.test.ts`, run in the matrix job. Each case
runs the compiled launcher with the environment variable `BUN_OFFLINE=1`
(or whatever Step 1 found) **and** with a `fetch` that would fail (the
launcher passes `fetch` into `createAi`; in tests the launcher accepts
`AUTOAPP_TEST_NO_NETWORK=1` to install a failing `fetch` there):

| Tier | Test | Documented guarantee if it passes |
|---|---|---|
| Run offline | `serve` an imported app and call `items.list` and `items.add` through the harness | An installed application's local features work with no network. |
| Edit offline | `buildCandidate` after a source change that uses only already-installed dependencies | Changes to an application's source build and activate with no network. The engineer needs a model; with a remote provider it is unavailable offline, with a local provider (Ollama) it works. Test the "unavailable" sentence appears in the launcher's chat when `fetch` fails. |
| Extend dependencies offline | `buildCandidate` after a source change importing a package not in `node_modules` | Refused with the sentence from Step 1. Adding a dependency needs the network and a re-import. |

## Step 4 — release and publish

- `packages/broapp-autoapp/package.json`: remove `private`, add
  `publishConfig.access: public`, `files`, `repository.directory`,
  keywords. Version stays `0.1.0`.
- `scripts/release-dry-run.ts`: include `broapp-autoapp` in the packed set
  and, from the packed tarballs, generate a project outside the workspace
  that imports the Notes workspace through the published packages and
  builds a candidate. If the dry run script's structure makes that
  invasive, add `scripts/autoapp-dry-run.ts` and call it from the same CI
  job; say which you did.
- `release.yml`: add the launcher binary for the six targets to the
  release artifacts, named `broapp-autoapp-<target>`, cross-compiled from
  Linux like the examples, with the native smoke (`autoapp-smoke.ts`) on
  the three runners that exist. Cross-compiled binaries are labelled as
  such, following the existing convention in `docs/packaging.md`.
- `publish.yml`: include the package if the workflow enumerates packages.

## Step 5 — documentation

- `docs/autoapp/packaging.md`: the launcher binary, size, targets, what is
  smoke-tested where, the Windows notes, the offline tiers table with a
  "tested in CI on" column filled from the matrix.
- `docs/autoapp/security.md`: what the gate protects, what it does not; the
  trusted-local-code statement; the control connection; MCP; approvals
  and attachment; the rollback boundary; what is deferred (OS sandbox,
  capability enforcement) with a pointer to prompt 10.
- `docs/autoapp/design.md`: update the offline section from "untested" to
  the tested table, and link both new documents.
- `README.md` root: one paragraph and one link under "What Broapp
  contributes", worded as optional and as trusted local code.
- `skills/broapp/SKILL.md`: a short section on Autoapp if the skill
  describes the AI layer; keep it under 30 lines; run `bun test tests/skill.test.ts`.
- `site/` generation: run `bun run site` and confirm the new documents appear.

## Verification

```bash
bun run typecheck
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run dryrun
bun run site
bun run check
```

Push the branch and confirm the `autoapp` CI job is green on all three
operating systems; paste the run URL and the per-OS status into the
report. If a platform is red, the report says which test and why, and the
documentation says the platform is not yet supported for that feature.

## Acceptance criteria

- CI green on Linux, macOS, Windows for the `autoapp` job, or a documented skip per failing test.
- No test or document claims an offline guarantee that the matrix did not exercise.
- A release directory serves with `source/node_modules` removed.
- The dry run builds a candidate from the published packages, outside the workspace.

## Report

`prompts/autoapp/reports/09-packaging.md`, with the CI run URL.

## Commit

```
Prove the Autoapp packaging chain on every platform

Vendored per-application dependencies, a three-OS CI job running the
compiled launcher through import, activation, crash and recovery, and
the three offline tiers tested and documented as tested. broapp-autoapp
becomes publishable and the launcher joins the release artifacts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
