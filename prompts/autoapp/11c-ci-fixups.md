# 11c — What CI found in 11 and 11b

CI run <https://github.com/praveenvijayan/broapp/actions/runs/34506669453>
on `8aeebf1`: five jobs red, two causes. Both are the kind of fault report 09
listed — an artefact one machine had and a fresh runner did not, and a
`mkdtempSync` under a directory nothing had made. Read that report's "What
the matrix found" before starting.

## 1 — the dry run's tarball has no template (three OSes)

```
FAIL  the installed package: the starter template is missing from the tarball
FAIL  import: error: Cannot find module '../../dist/starter-template.json' from …/node_modules/broapp-autoapp/src/launcher/main.ts
```

`scripts/pack-local.ts` builds the page before packing `broapp-autoapp`
(`'broapp-autoapp': ['bun', 'run', 'build:page']`) and nothing builds the
template. It passed locally because `dist/starter-template.json` was already
there. The dry-run check that 11 added did exactly its job.

Fix: one script that builds every artefact the tarball ships, used
everywhere the tarball is made.

- `packages/broapp-autoapp/package.json`: `"build:assets": "bun run build:page && bun run build:template"`.
- `scripts/pack-local.ts`: `'broapp-autoapp': ['bun', 'run', 'build:assets']`, and the comment above the map names both artefacts.
- `.github/workflows/publish.yml`: the two separate steps become one `build:assets` step; keep the comment that says why it exists.
- `scripts/build-launcher.ts`: keep calling both, or call `build:assets` — one of the two, not a third arrangement.

Verify by deleting `packages/broapp-autoapp/dist/starter-template.json` and
`dist/launcher-page.html`, then `bun run dryrun:autoapp`. It must pass from
nothing.

## 2 — a `mkdtempSync` under a run root nothing made (macOS and Windows)

```
error: ENOENT: no such file or directory, mkdtemp
      at tests/autoapp-create.test.ts:176
(fail) the starter template > refuses a tree with somebody else’s build in it
```

`mkdtempSync(join(runRoot, 'pack-'))` assumes `tests/.autoapp-run` exists.
It passed on Ubuntu and locally only because another test in the file had
already made it; on the two other runners this test ran first.

Fix: `mkdirSync(runRoot, { recursive: true })` immediately before that
`mkdtempSync`, and check every other `mkdtempSync` in the file makes its
parent the same way — report 09's finding was the same line in a different
file, and it should not be found a third time. Run the file alone,
`bun test tests/autoapp-create.test.ts`, on a tree where `tests/.autoapp-run`
does not exist.

## Verification

```bash
rm -rf tests/.autoapp-run packages/broapp-autoapp/dist/starter-template.json packages/broapp-autoapp/dist/launcher-page.html
bun test tests/autoapp-create.test.ts
bun run dryrun:autoapp
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

## Report

`prompts/autoapp/reports/11c-ci-fixups.md`, under 30 lines. Then push
`autoapp` and dispatch CI with `gh workflow run ci.yml --ref autoapp`; put
the run URL in the report.

## Commit

```
Build the starter template wherever the launcher is packed, and make the test's run root first

The dry run packed a tarball without dist/starter-template.json because
only the page was built before packing; one build:assets script now makes
both, everywhere a tarball is made. The create test's scratch directory is
made under a run root that exists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
