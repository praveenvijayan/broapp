# 05 — Candidate releases, supervision and activation

## What was built

- **Core (both changes named in the prompt).** `RunningApp.attached`, computed
  from the same "is any endpoint open" question the idle logic asks.
  `Gate.pause(reason)` / `resume()` / `paused`: while paused, `write` and
  `external` are refused with `unavailable` *before* anything is decided and
  nothing is recorded — a pause is not a decision — and `read` still runs.
- `src/child/module.ts` — `AppStartContext`, `AppInstance`, `AppModule`,
  `assertAppModule`. `src/child/run-child.ts` — the generic child runtime, in
  both `--child` and `--migrate` modes.
- `src/launcher/` — `supervisor.ts`, `candidate.ts`, `snapshot.ts`,
  `journal.ts`, `activate.ts`, `recover.ts`, `client.ts`, `main.ts`, `index.ts`.
- `ipc/messages.ts` gained `Migrate`; the codec validates it.
- Notes split into `src/host/app.ts` (the module) and `src/host/main.ts` (the
  standalone binary, which now calls `start` and `startApp` itself), plus
  `examples/notes/autoapp.json`.
- `tests/fixtures/autoapp-app/` — a source workspace with three migrations and
  one route per effect. `tests/autoapp-activation.test.ts` — 20 tests.
  `tests/autoapp-gate.test.ts` gained the four pause cases.

## Deviations, and why

1. **`isPublicError` replaces `instanceof PublicError`** in `wrap`, in the
   gate's failure record, and in the AI run loop — a new export from
   `broapp/shared`. This is a **correctness fix the child architecture forces**,
   found by the manual run. A release bundles its own copy of `broapp`, while
   the child runtime has the copy compiled into the launcher, so a `PublicError`
   thrown by the gate in one and caught by `runOperation` in the other is a
   different class object with the same shape. `instanceof` was false, and every
   deliberate refusal — the preview policy's included — was being reduced to
   "The application could not complete that operation." The check is narrow: the
   `name`, plus a `code` from the known set.
2. **`connectToChild` in `src/launcher/client.ts`.** The prompt says to reuse
   the pattern from `tests/harness.ts`; that pattern needs a cookie jar and a
   socket that can set headers, and `ws` is not a dependency of this package.
   Bun's own `WebSocket` accepts `{ headers }`, so the helper is plain platform
   plus that one thing. It satisfies exactly the checks a browser tab does;
   nothing about the trust fence is weakened.
3. **Acceptance examples run over one connection**, not one per example. A
   launch URL carries a *single-use* token: the second `connect` to the same URL
   is refused with 403. Found by the manual run — see below.
4. **`Bun.build` runs in the launcher's process** for the host bundle, as the
   prompt's fallback allows. It bundles the application's modules; it does not
   execute them. Report 02 established the `BUN_BE_BUN=1` route if that ever
   needs isolating further.
5. **`buildCandidate` returns `rebuilt: boolean`**, so a caller can tell "built
   it" from "it was already there" — both are `ok: true`.
6. **The child creates its own data directory.** Nothing else did, and the
   standalone Notes binary had been getting it from `ensureDataDir`.
7. **`react` and `react-dom` added to the root `devDependencies`.** The fixture
   workspace's page bundle needs them resolvable; the root had only the
   `@types`. Also `tests/.autoapp-run/` (gitignored) is where a test's launcher
   root goes, for the reason `tests/build.test.ts` already documents.
8. The commit trailer names Claude Opus 5, per this session's attribution
   instruction.

## Crash injection

`AUTOAPP_TEST_CRASH_AT` is honoured only under `NODE_ENV=test`, so a stray
variable on a real machine cannot abandon somebody's data halfway through.
Each row: inject, stop every child (what restarting the launcher does), run
`recover`.

| Injected after | What was on disk | Recovery | Result |
|---|---|---|---|
| `snapshotted` | `data` intact, `data-next` copied | discarded the copy, `failed-before-switch` | A serving, 1 row, `current` = A |
| `migrated` | `data` intact, `data-next` migrated | discarded the copy, `failed-before-switch` | A serving, 1 row, `current` = A |
| `checked` | `data` intact, candidate had run on the copy | discarded the copy, `failed-before-switch` | A serving, 1 row, `current` = A |
| `switched-half` (first rename only) | `data` gone, `data-prev-*` and `data-next` present | finished the second rename, `setCurrent(B)`, `done` | B serving, 1 row, `current` = B |
| `switched-both` (both renames) | `data` and `data-prev-*` present | wrote `current`, `done` | B serving, 1 row, `current` = B |
| `serving` | switch complete, nothing started | started `current`, `done` | B serving, `current` = B |

No `data-prev-*` directory and no snapshot is ever removed by recovery; a
separate test asserts both survive.

## The manual Notes activation

`bun run --cwd packages/broapp-autoapp build:launcher` →
`dist/broapp-autoapp` (65,363,570 bytes = 65.4 MB).

| Step | What happened |
|---|---|
| `import ./examples/notes --as notes --grant` | git repository initialised; release `9a0c7997…` |
| `serve notes --no-open` | printed the launch URL once; the browser showed Notes, "Connected" |
| Create a note | "Under the launcher" appeared in the table |
| Edit the workspace | added `pinned` to the contract's note, to `db.ts`'s row, select and mapper, and a `Pinned` column to the views |
| `build notes` | release `2358dae3…` |
| `activate notes 2358dae3…` | `migrated 2 → 2 on a copy`; `notes is now on 2358dae3…, was 9a0c7997…`; exit 0 |
| `status notes` | `current: 2358dae3…`, the activation `done` |
| Reload the tab | headers `Title, Done, **Pinned**, Updated`; the note written under the previous release is still there |
| The directory | `data`, `data-prev-1788751917145`, `snapshots/`, `current`, `grants.json` |

**Three bugs the manual run found, all fixed.** Every test passed with the first
two of them in.

- The child never created its data directory, so Notes started and every
  operation failed with the internal message. Invisible until the supervisor
  streamed child stderr line by line instead of reading the whole pipe at the
  end — a whole-stream read does not resolve while the child is alive, which is
  precisely when its diagnostics are wanted.
- `instanceof PublicError` across the release/launcher module boundary
  (deviation 1). This is why the error above said nothing useful.
- The single-use launch token, and a one-shot CLI command hanging afterwards
  because a live child's IPC channel keeps the event loop open. Every command
  but `serve` now stops its children before returning.

## Commands run

```
bun run typecheck                          exit 0
bun test tests/autoapp-gate.test.ts        27 pass, 0 fail
bun test tests/autoapp-activation.test.ts  20 pass, 0 fail
cd examples/notes && bunx tsc --noEmit     exit 0
cd examples/notes && bun test tests        23 pass, 0 fail
cd examples/notes && bun run build         bin release/notes 69.6 MiB
bun run check                              exit 0 - 349 pass, 0 fail (24 files)
```

## Acceptance criteria

- **The launcher never imports a release's `host.js`** — pass. The grep is
  empty; `entry.host` appears only in `src/spec/validate.ts` (validating the
  field) and `src/child/run-child.ts` (the child's own import):

  ```
  $ grep -rn "entry.host" packages/broapp-autoapp/src/launcher
  $
  ```
- **Every phase is journaled before the action it names** — pass. One helper,
  `reach()`, advances the journal and is the only way a phase is entered; the
  crash hook fires inside it, after the write.
- **Crash injection at every phase recovers to a serving application** — pass;
  the table above.
- **A drain that times out leaves the previous release serving** — pass. The
  test opens a stream that never ends, activates with `drainDeadlineMs: 300`,
  and asserts the stream is still producing afterwards.
- **A snapshot under concurrent writes passes `integrity_check`** — pass, with
  a row count between the counts observed before and after.

## Open questions

- **`activate` from the CLI cannot drain an application another process is
  serving.** It finds the running child through its own supervisor, and a
  separate `broapp-autoapp activate` has none. It works because the manual
  sequence stops `serve` first. Prompt 07's single launcher process, holding
  both the supervisor and the engineer, is where this becomes true in general.
- **A copied source workspace cannot resolve its dependencies.** `import` copies
  the tree without `node_modules`, so `buildCandidate` fails unless the copy
  sits somewhere that can walk up to an install. Both the tests and the manual
  run put the launcher root inside this repository for exactly that reason.
  This is prompt 09's subject, and the prompt says so.
- `data-prev-*` directories and snapshots accumulate. `prune` is prompt 10's
  backlog item, as the prompt says.
- The fixture's schema-version variants are produced by rewriting `db.ts` before
  the build. A real application would ship the cap in its own manifest.
