# 11 — A starter in the binary, a create route, a button

## What was built

- `templates/autoapp-starter/` — 12 files, in git. One page, one table, one form;
  five `items.*` routes, each with an `effect` and a `summary`; one migration; one
  acceptance example; `capabilities: []`; no AI panel, and the README says why.
- `scripts/build-template.ts` — `packTemplate` and `build:template`, run by
  `build-launcher.ts` after `build:page`. `files`, `publish.yml` and the dry run's
  installed-package check all name `dist/starter-template.json`.
- `src/launcher/starter.ts` (`writeStarter`), `workspace.ts` (`prepareWorkspace`,
  `adopt`), `create.ts` (`createApplication`).
- `launcher.appCreate`; `apps.create`; `create <appId> [--name] [--description]`;
  the **New application** button, form and empty-state sentence in `AppsTable.tsx`;
  selection and the first suggestion in `App.tsx`.
- `tests/autoapp-create.test.ts` (15 tests), `tests/autoapp-template.ts`.

## Step 3: the deadline, and the shape

**No deadline under ten minutes exists,** so `appCreate` is synchronous and there
is no `launcher.createStatus`. `brobridge/dist/options.d.ts` has no per-call
timeout: `handshakeTimeoutMs` (10 s) is the request line and `HELLO`,
`closeTimeoutMs` (2 s) is shutdown, `sessionTtlMs` (60 s) is retention after a
disconnect. `@brobridgejs/client` has `connectTimeoutMs` and `heartbeatTimeoutMs`
and nothing per call; `packages/broapp/src/host/app.ts` has no timeout at all.

What it does impose: `heartbeatTimeoutMs` is 45 s, and heartbeats are the
launcher's own event loop. `importApp`'s install was `Bun.spawnSync`, which would
have held that loop for the whole install and had the tab call the connection
dead. The shared install is `Bun.spawn` plus `await exited`.

## Deviations, and why

1. **The shared install has no `--frozen-lockfile`, so `import` lost it.** The
   prompt fixes creation's flags, asks for one implementation, and names a test
   that greps `main.ts` for a second install spawn — one spawn cannot carry two
   flag sets. A copied workspace with a stale lockfile now installs rather than
   refusing, which is the best-effort behaviour the comment there already claimed.
   `docs/autoapp/packaging.md` is corrected.
2. **Substitution encodes the value for the file it enters** — JSON-escaped in
   `.json`, entity-escaped in `.html` — rather than bare `replaceAll`. The prompt
   guards TypeScript string literals and treats JSON as safe; it is not. A name
   containing `"` produced an `autoapp.json` that would not parse, surfacing as a
   `spec` problem about a manifest rather than about a name. A test creates
   `A "difficult" \ name` and reads it back out of the manifest unchanged.
3. **The starter's `views.ts` names no marker at all, not even in a comment.**
   Spelled out, substitution would have put the person's name inside a block
   comment, where `*/` breaks the file. The comment says it without the token, and
   a test asserts no `.ts` file carries one.
4. **`items.list` returns `nextDone` beside `done`.** A view specification has no
   expressions, so a row action can only pass a value the row already carries, and
   "toggle" needs `!done`. The row carries it.
5. **The install-grep test matches a spawn, not the word**
   (`PrepareOptions['install']` is a type index), and **`SOURCE` is exported from
   `candidate.ts`**, so the test checks the starter against the list the build
   reads rather than a copy of it.
6. **`tests/autoapp-create.test.ts` joins the CI autoapp matrix.** The offline
   table gains a *Create offline* row, and prompt 09's criterion is that no
   document claims what the matrix did not exercise. It is also the one platform
   question the template raises: packed with forward slashes, written with `join`.
7. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Decisions I made

- **The tool's output says nothing about a tab.** A model told one had opened
  would say so to somebody whose screen had not changed.
- **`App.tsx` reads the created id from the call's `input`**: `ToolCallState`
  exposes both, and the output says what was built rather than what it was called.
- **`AppsTable` owns the form and calls the route**, the way `CandidatePanel` owns
  activation, and tells `App.tsx` only the new id — which is selected once the
  list contains it, since selecting an id with no row puts the panels on nothing.

## The manual run

Compiled binary, driven through the in-app browser.

| Step | What happened |
|---|---|
| `create dream --name "Dream journal"` | `installed the application’s dependencies` **from the registry** — `broapp@0.3.0` and `broapp-autoapp@0.1.0` are both published, so it built against the real packages; `dream 648b74f4…` |
| `serve dream`, open it | Tab titled **Dream journal** — the marker reached the document; form, headers, empty text, `0 items, 0 of them done.` |
| Add, toggle twice, remove | Row with its note and time; Done `No → Yes → No` with the counts following; back to the empty message |
| `serve` with an **empty root** | `No applications yet. Create one above, or import a workspace with broapp-autoapp import.`, **New application** beside the heading |
| Type "Weekly review!", Create | The id fills itself `weekly-review`; then `Weekly review! · fad937aa · schema 1 · yes (pid 47664)`, selected, releases panel showing it, a browser tab opened, `current` and an empty `grants.json` on disk |
| The same id again, then Escape | `weekly-review already exists.` under the id field, form still open with what was typed; Escape closes it and focus returns to the button |

A workspace created this way also typechecks: `tsc --noEmit` in it exits 0.

## Commands run

```
bun run typecheck                                    exit 0
bun run --cwd … build:template                       12 files  23.7 KiB
bun test tests/autoapp-create.test.ts                15 pass, 0 fail
bun test tests/autoapp-{engineer,gate}.test.ts       73 pass, 0 fail
bun test tests                                       598 pass, 0 fail (38 files)
bun run --cwd … build:launcher                       dist/broapp-autoapp 75.1 MB
bun run scripts/autoapp-smoke.ts                     every step passed
bun run dryrun:autoapp                               Autoapp dry run passed.
bun install && bun run check                         exit 0
cd examples/notes && bunx tsc --noEmit && bun test tests   exit 0; 23 pass
```

**The smoke test's create step:** `✓ create — 6d9a32e1…, dependencies installed
from the registry`, then one release marked current and `granted: nothing`. The
versions the starter names are published, so this run took the registry path
rather than the resolve-upward one.

**What the template costs the binary:** 66,048 bytes — 64.5 KiB. Compiled twice,
once with the real `starter-template.json` and once with `{"files":{}}`:
78,771,314 against 78,705,266.

## Acceptance criteria

- **Empty root, button, an application current, open, selected, `refs` on it** —
  pass; the manual run's last three rows.
- **`create` and `apps.create` through the same function** — pass. Both call
  `createApplication`; a test drives the tool through the gate, and the CLI is the
  smoke test's create step.
- **In git, packed at build time, in every target's binary, in the tarball,
  checked by the dry run** — pass. `build-launcher.ts` packs before it compiles,
  for every target; `files` ships it; the dry run fails without it.
- **A failed install or build leaves a workspace, never a deleted directory and
  never a `current` pointing at nothing** — pass, in two tests: one where the
  build still passes (`installed: false`, `ok: true`), one where it does not
  (problems returned, no `current`, workspace intact).
- **`import` behaves exactly as before** — pass: the smoke test's import step is
  unchanged and green. Its one change is deviation 1, the lockfile flag.
- **`bun run check` green, every command exits 0** — pass.

## Open questions

- **`create` cannot be told to work offline**, and there is no `--no-install`. A
  person with no network gets a workspace, no release and a sentence. The
  backlog's *Create offline* row says so rather than a flag pretending otherwise.
- **Nothing removes an application.** Creation is a click now; the backlog has
  `remove` beside `prune` for that reason.
- **The starter's migration `checksum` is 64 zeroes.** Nothing computes or
  verifies one yet — prompt 03 left that open, and a plausible-looking hash
  nobody checks would be worse than one that obviously is not.
