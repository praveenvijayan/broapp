# 11c — What CI found in 11 and 11b

CI run <https://github.com/praveenvijayan/broapp/actions/runs/34508881634> on `4eeb958`: every
job green, Linux, macOS and Windows. The run on the prompt's own commit `e995a3f`
(<https://github.com/praveenvijayan/broapp/actions/runs/34507867482>) fixed both named faults
and, by getting past them, uncovered a third.

1. **The tarball with no template.** `broapp-autoapp` gains `build:assets` (`build:page`
   then `build:template`). `pack-local.ts` prepares with it, `publish.yml`'s two steps
   become one, `build-launcher.ts` calls it rather than the two scripts. With both
   artefacts deleted, `dryrun:autoapp` passes and `build:launcher` builds them on its way.
2. **The run root nothing made.** `mkdirSync(runRoot, { recursive: true })` before
   `mkdtempSync(join(runRoot, 'pack-'))` in `tests/autoapp-create.test.ts`. The seven
   other `mkdtempSync` calls under a run root, in five files, already make their parent.
3. **Windows only, found by the fixed run.** Its smoke ran for the first time and said
   `[child] unknown command "D:\a\...\src\launcher\main.ts"`. `isCompiled()` matched
   `Bun.main`'s virtual root by regexp, right on POSIX and wrong there, so the binary spawned
   itself as if from source. `Bun.isStandaloneExecutable` is the runtime's own answer;
   `isCompiledEntry` and its string test are gone, and a test asks a probe binary instead.

**Deviations.** Two commits, not one: `4eeb958` keeps the third fault separate, as report 09
kept its four. Trailers name Claude Opus 5, per this session's rule, not Claude Fable 5.1.

**Commands.** `bun test tests/autoapp-create.test.ts` 15 pass with no `tests/.autoapp-run`;
`dryrun:autoapp` passed with no `dist` artefacts; `build:launcher` 75.1 MB;
`scripts/autoapp-smoke.ts` every step passed; `bun run check` exit 0, 598 pass, 0 fail.

**Acceptance.** Dry run from a tree with no built artefacts — pass, all three runners. The
create test alone with no run root — pass. CI green — pass. **Open:** the smoke's Windows
cleanup check stays skipped, for report 09's reason: a terminated console runs no handler.
