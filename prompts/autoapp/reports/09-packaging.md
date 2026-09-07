# 09 — Packaging matrix and offline tiers

CI run: <https://github.com/praveenvijayan/broapp/actions/runs/34106141643>

`Autoapp — ubuntu-latest`, `— macos-latest` and `— windows-latest`: **success**,
all three, as is every other job in the run. The branch is pushed; the run
instruction said "The owner says: push." CI triggers on `main` and on pull
requests, so each run was started with `workflow_dispatch` against `autoapp`;
no pull request was opened.

## What was built

Steps 1 to 3 were already committed as `914583c` — the prompt's "Before
starting" was rewritten mid-session to say so, and the stash it first described
was popped with identical content. This session did their gaps, steps 4 and 5,
and the fixes the matrix found.

- **Steps 1 to 3, completed.** `checkDependencies` drops a `vendored` flag nobody
  read. Three cases join `tests/autoapp-offline.test.ts`: a release serving with
  its **whole source workspace deleted**, a host bundle importing nothing but
  `bun:` and Node builtins, and the edit-offline "unavailable" sentence (with a
  refusing `fetch`, `ai.connectionTest` answers `ok: false, "Could not reach
  Ollama…"` and the turn ends with an error rather than hanging).
  `Supervisor.killAll()` runs from `process.on('exit')`; the spike's child `PATH`
  is empty on Windows, where it is also the DLL search path; and
  `tests/autoapp-spec.test.ts` joins the matrix for moving `current` onto an
  existing pointer — `MoveFileEx` there.
- **Step 4.** `broapp-autoapp` is publishable: `private` gone, plus
  `publishConfig`, `files`, `repository.directory`, keywords, a LICENSE, and
  Broapp dependencies moved from `workspace:*` to `^0.2.1`. New
  `scripts/build-launcher.ts` (`build:all`, `--target`) and
  `scripts/autoapp-dry-run.ts`, called from the dry-run CI job, `publish.yml` and
  `release.yml`. `release.yml` gains `launcher` (six cross-compiled targets) and
  `launcher-smoke` (the binary through `autoapp-smoke.ts` on three runners).
- **Step 5.** `docs/autoapp/packaging.md` (new); `security.md` gains the control
  connection, MCP, attachment, the rollback boundary and what is deferred;
  `design.md`'s offline section is the tested table and its stale `releaseId`
  paragraph (08c's open question) is corrected; a README paragraph and package
  row; an Autoapp section in `skills/broapp/SKILL.md`; the three documents in the
  site.

**What the matrix found that one machine could not**, each its own commit: a URL
`pathname` used as a filesystem path (`D:\D:\a\…`); a binary named without the
`.exe` Bun adds; `mkdtempSync` under a run root nothing had created; four test
files each recompiling the launcher, which on Windows fails `EPERM` and **skips a
whole file silently**; a fixture edited with a literal ending in `\n`, which
matches nothing in a CRLF checkout, so the test asserted against a build with
nothing wrong with it; and a killed launcher's leftover `launcher.json`.

## Deviations, and why

1. **`scripts/autoapp-dry-run.ts` rather than extending `release-dry-run.ts`**,
   which the prompt allows and asks me to say: that script is one narrative about
   a generated application; the launcher needs a different project shape.
2. **The smoke script does not `SIGKILL` mid-activation.** `AUTOAPP_TEST_CRASH_AT`
   stops the process from inside at the named phase, identically on all three
   platforms, where a kill from outside would race it.
3. **The site's link rewriter resolves a relative link from its own document's
   directory**; without it `packaging.md` inside `docs/autoapp/` pointed at the
   root guide.
4. **Six commits, not one.** The prompt's is `b2cd549`; four are the matrix's
   findings, each pushed on its own, and one is this report — squashing would
   have hidden which platform found what. `docs/autoapp/backlog.md` (prompt 10)
   was swept into `a69b6df` while CI ran; prompt 10's commit finishes it.
   Trailers name Claude Opus 5, per this session's rule.

## Commands run

```
bun run typecheck                 exit 0
bun test tests                    466 pass, 0 fail (30 files)
bun run --cwd … build:launcher    dist/broapp-autoapp 72.2 MB
bun run scripts/autoapp-smoke.ts  every step passed
bun run dryrun                    Dry run passed.
bun run dryrun:autoapp            Autoapp dry run passed.
bun run site                      19 files, the three Autoapp pages present
bun run check                     exit 0
```

## Acceptance criteria

- **CI green on Linux, macOS and Windows for the `autoapp` job** — pass. One
  check is skipped on Windows, with its reason in `docs/autoapp/packaging.md`:
  the smoke script's "the control file is gone once nothing is serving", because
  a terminated console process runs no exit handler.
- **No test or document claims an offline guarantee the matrix did not
  exercise** — pass. Every tier names its case, and both documents say plainly
  that no flag prevents a socket from opening.
- **A release directory serves with `source/node_modules` removed** — pass, in
  the stronger form: the whole workspace is deleted and it still answers a read
  and a write.
- **The dry run builds a candidate from the published packages, outside the
  workspace** — pass: five tarballs installed in a temporary project, the Notes
  workspace imported through them, a second release from a changed view.

## Open questions

- `bun install` at `import` cannot satisfy a `workspace:*` dependency, so an
  application imported from inside a monorepo builds by resolving upward.
- Nothing proves the launcher runs on `linux-arm64`, `linux-x64-musl` or
  `darwin-x64`: no runner, and labelled compiled-only.
