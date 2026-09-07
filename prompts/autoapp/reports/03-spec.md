# 03 — The application specification and release store

## What was built

`packages/broapp-autoapp/src/spec/`, exported as `broapp-autoapp/spec`:

- `types.ts` — `AppSpec`, `AppManifest`, `Capability`, `ContractExport`,
  `ExportedRoute`, `MigrationSpec`, `AcceptanceExample`, `Grants`,
  `CapabilityDiff`, `SPEC_VERSION`, `APP_ID_PATTERN`. Exactly the shapes the
  prompt gives.
- `validate.ts` — `parseSpec` and `parseGrants`. Shape checking through `s`,
  then a cross-check pass for everything that is about more than one field.
- `export-contract.ts` — `exportContract`, refusing a route with no `effect`,
  no `summary`, or a validator with no `toJsonSchema()`.
- `release-id.ts` — `releaseId({ page, host, contract })`, and `canonicalJson`
  re-exported.
- `layout.ts` — `layout(root)`, `defaultRoot(env)`, and the two id patterns
  enforced where a path is derived from an id.
- `store.ts` — `writeRelease`, `readRelease`, `listReleases`, `readCurrent`,
  `setCurrent`, and the `writeAtomic` helper they share.
- `capabilities.ts` — `capabilityKey`, `diffCapabilities`, `isGranted`,
  `readGrants`, `writeGrants`.

`tests/autoapp-spec.test.ts`: 33 tests.

## Deviations, and why

1. **`canonicalJson` is exported from `broapp/host`, not written a second
   time.** The prompt says not to write a second sorter if one is importable —
   and the one in `gate.ts` was private. It is now `export function
   canonicalJson`, re-exported from `packages/broapp/src/host/index.ts`, and
   `argumentsHash` uses it unchanged. New exports in `host/index.ts` are on the
   allowed list in `00-common-rules.md`.
2. **`broapp-autoapp` added to the root `package.json` `devDependencies`** as
   `workspace:*`. The `packages/*` glob makes it a workspace member but does not
   put a symlink in `node_modules`, so `import … from 'broapp-autoapp/spec'`
   did not resolve from `tests/`. This is how `broapp` and the two AI provider
   packages are already reachable from tests; nothing in `workspaces` changed.
3. **`parseGrants` was added** — not named by the prompt, but `readGrants` reads
   a file from disk and returning it unvalidated would defeat the point of
   validating everything else.
4. **A local `Path` alias in `validate.ts`.** `broapp/shared` exports `Issue`
   but not `IssuePath`; a one-line alias was cheaper than another core export.
5. **`writeRelease` also refuses a manifest whose `releaseId` is not the hash of
   the files handed to it**, before writing anything. The prompt asks for the
   recompute-before-rename check; doing it up front as well means a mismatched
   manifest never creates a directory at all.
6. The commit trailer names Claude Opus 5, per this session's attribution
   instruction.

## Decisions I made

- **`closed()`** wraps the capability schema to refuse unknown fields. `s.object`
  *drops* what it does not know, which is right for an operation input and wrong
  for a permission: a field nobody read is a permission nobody granted.
- **`record()`** is hand-written, because `s` has no record constructor and a
  contract's two tables are records keyed by route name. The key pattern is
  Broapp's own route pattern, so a bad route name is refused as a key rather
  than reaching the cross-check.
- **Staging directory is `<releaseId>.incomplete`**, a sibling of the target, so
  the rename stays on one filesystem and a crash leaves something recognisable.
  `writeRelease` clears a stale one before starting rather than refusing.
- **`listReleases` reads each release back** and skips anything that does not
  parse or whose manifest disagrees with its directory name. A hand-copied or
  half-written directory is therefore not listed as a release.
- **`capabilityKey` excludes `reason`** and sorts paths and hosts. A reworded
  justification is not an escalation, and re-asking for one would train a person
  to click through the question that matters.
- **`isGranted` ignores `removed`.** An application asking for less is not a
  decision anybody has to make.
- **`readCurrent` returns `null` for a pointer that is not 32 hex characters**
  rather than throwing, so a corrupted pointer reads as "nothing is active"
  and activation can proceed.

## Commands run

```
bun install                          exit 0
bun run typecheck                    exit 0
bun test tests/autoapp-spec.test.ts  33 pass, 0 fail [20ms]
bun run check                        exit 0 — 292 pass, 0 fail (21 files)
```

## Acceptance criteria

- **A release can be described, written, read and pointed at without running any
  application code** — pass. Nothing in `src/spec/` imports application code,
  spawns a process or opens a bridge; the tests only touch data and directories.
- **A route without an explicit `effect` cannot enter an Autoapp release** —
  pass, at both doors: `exportContract` throws naming the route, and `parseSpec`
  refuses a `contract` entry without one.
- **Every disk write is atomic or refused** — pass. Release directories are
  staged and renamed; `current` and `grants.json` are written to `.tmp` and
  renamed. Tests plant a stale staging directory and a stale `current.tmp` and
  confirm the next call succeeds.

## Open questions

- `renameSync` over an existing `current` is atomic on POSIX. On Windows it
  replaces through `MoveFileEx`, but a reader holding the file open can make it
  fail. Noted in a comment at `setCurrent` and for prompt 09's platform list.
- `MigrationSpec.checksum` is validated as 64 hex characters but nothing yet
  computes or verifies it against migration content — that belongs with the
  migration runner in prompt 05.
- `views` and `workflows` are validated for shape only, as the prompt says.
  Prompts 04 and 06 replace those two schemas.
