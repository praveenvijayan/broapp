# 08b — Fix-ups from the first pass

## Goal

Three design flaws surfaced by the reports of prompts 05 and 07, fixed
before the packaging matrix locks anything in, and the prompt 07 demo run
again with a hosted model so steps 5 to 8 are exercised by a model at
least once. After this prompt: a release's identity covers everything a
release contains; the engineer edits files by hunk, not by rewriting them;
nothing uses `instanceof` across the release boundary; and the demo log
records how far a capable model gets unaided.

Read `00-common-rules.md` again first: three rows changed (Release
identity, Module identity across the release boundary, Engineer edits).

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far, especially `05-activation.md` deviation 1 and `07-engineer.md` "Where the large request stalls" and the release-identity finding.
- `packages/broapp-autoapp/src/spec/release-id.ts`, `store.ts`, `validate.ts`.
- `packages/broapp-autoapp/src/launcher/candidate.ts` (the refusal at the identity check, around the `rebuilt` branch).
- `packages/broapp-autoapp/src/engineer/workspace.ts`, `tools.ts`, `instructions.ts`, `state.ts`.
- `packages/broapp/src/shared/errors.ts` (`isPublicError`).
- `tests/autoapp-spec.test.ts`, `tests/autoapp-activation.test.ts`, `tests/autoapp-engineer.test.ts`.

## Step 1 — release identity covers the specification

`spec/release-id.ts`: `ReleaseParts` becomes
`{ page: Uint8Array; host: Uint8Array; spec: AppSpec }`. The digest is
page, separator, host, separator, `canonicalJson(stripIdentity(spec))`
where `stripIdentity` returns the spec with `manifest.releaseId` and
`manifest.createdAt` removed (deleted, not set to null). Export
`stripIdentity` for the test.

`candidate.ts`: compute the identity after the whole `AppSpec` is
assembled (it already is, at step 4), then set `manifest.releaseId` and
write. Remove the "does not alter the page, the host bundle or the
contract" refusal and the branch behind it; an identical rebuild
(`rebuilt: false`) remains the only same-identity case, and it is detected
by comparing `stripIdentity` of the stored spec with the new one — they
must be deep-equal or the build throws, because that would mean the hash
is broken.

`store.ts`: `writeRelease` recomputes the identity from the written files
and the written spec exactly as `candidate.ts` did, before the rename.
`readRelease` keeps verifying the directory name.

Existing on-disk releases built under the old rule have names that no
longer match their content. Do not migrate them: `readRelease` of a
release whose recomputed identity differs from its directory name throws
`conflict` with the sentence "this release was built by an earlier
version of broapp-autoapp; import the application again". Add
`broapp-autoapp releases <appId>` marking such releases `stale`. The
launcher's `serve` refuses to start a stale `current` with the same
sentence.

Tests to change and add in `tests/autoapp-spec.test.ts`:

- The determinism case now varies one acceptance example and expects a different id; varies `createdAt` and expects the same id.
- Round-trip and directory-name checks pass under the new rule.
- A hand-built release directory whose name was computed the old way reads as `conflict` with the sentence.

`tests/autoapp-activation.test.ts`: the "views-only change" and
"acceptance-only change" each produce a new release and activate. The
regression test prompt 07 added for the old refusal is replaced, not
kept.

## Step 2 — hunk edits for the engineer

`engineer/workspace.ts`:

```ts
export interface Hunk {
  readonly path: string;
  /** Exact text to find. Must occur exactly once in the file. */
  readonly find: string;
  readonly replace: string;
}
export interface EditResult {
  readonly changed: readonly string[];
  readonly undo: string;          // same shape applyChange returns
}
export function applyEdits(sourceDir: string, hunks: readonly Hunk[], message: string): EditResult;
```

Rules: every hunk is checked before any is applied; a `find` that occurs
zero times fails with "not found in <path>: <first 40 chars>…", more than
once with "ambiguous in <path>: N matches, include more context"; the
file must exist; the same containment as `applyChange`; all hunks are
applied atomically (compute every new content in memory, then write, then
commit or write the history directory exactly as `applyChange` does). Two
hunks on one file are applied in order to the same buffer.

`engineer/tools.ts`: add `source.edit` (`write`) with input
`{ appId, message, hunks: Hunk[] }`, returning the same `{ changed, undo, diff }`
shape as `source.change`. `source.change`'s description now says: "Create
a file, or replace one that is under 60 lines. For anything else use
source.edit." Enforce the 60-line limit on replacement of an existing
file (creation is unlimited) with a `rejected` `PublicError` that names
`source.edit`.

`engineer/instructions.ts`: step 3 of the loop becomes: read the file,
then `source.edit` with the smallest hunks that make the change; include
two or three lines of surrounding context in `find` so it matches once;
use `source.change` only for a new file. Keep the file under 70 lines.

Tests in `tests/autoapp-engineer.test.ts`: single hunk; two hunks on one
file in order; not-found; ambiguous; one bad hunk among three leaves all
files untouched; containment; git and no-git history paths; the 60-line
rule on `source.change`; the scripted fake model uses `source.edit` and
the build succeeds.

## Step 3 — no `instanceof` across the release boundary

Audit every `instanceof` in `packages/broapp-autoapp/src` and
`packages/broapp/src` against the rule. The ones allowed are on values
that never cross the boundary: `Error`, `TypeError`, `AbortSignal`,
`Uint8Array`, `Map`, the launcher's own `InjectedCrash` and
`LauncherNotRunning`, the browser's `BroappError` (one bundle), and
`AdapterError` inside the AI layer. Fix any other, and for each one fixed
say in the report which value crosses and how.

Add `tests/autoapp-boundary.test.ts`: reads every `.ts`/`.tsx` under the
two source trees, finds `instanceof <Name>`, and fails on any `Name` not
in an allow-list kept in the test with a one-line reason per entry. The
test is the rule's enforcement; the allow-list is the rule's exceptions.

Also add, to `run-child.ts`, a startup assertion that the release's
`host.js` exported `start` returned an object whose `register` is a
function and whose `schemaVersion` is a number — `assertAppModule`
already checks the module; this checks the instance, because the module
may have been compiled by a different `broapp` version and the shape is
all the child can trust.

## Step 4 — the demo, with a capable model

Provider rule: use the provider the person has already configured in the
launcher tab. **Never enter, paste or look for an API key yourself.** If
no hosted provider is configured when you reach this step, run the demo
against the local Ollama model as prompt 07 did, record that, and mark
steps 5 to 8 as "not attempted by a model in this pass" in the report.
Do not stop the prompt for it.

Then rerun prompt 07, Step 6, steps 3 to 8 exactly, with the large
request. Record per step: which tools were called, in what order, how
many `source.edit` hunks, how many build iterations, every approval
shown and answered, wall-clock time from message to "open the preview",
and whether the model requested activation only after being told the
preview was fine. If it stalls, record where and for how long, then run
the smaller request from report 07 to confirm the tool path still works.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-spec.test.ts tests/autoapp-activation.test.ts tests/autoapp-engineer.test.ts tests/autoapp-boundary.test.ts
bun test tests
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

## Acceptance criteria

- Changing only an acceptance example, only a view, only a migration entry or only a capability each produces a new release identity; changing only `createdAt` does not.
- A release directory from before this prompt is refused with the stated sentence, not misread.
- `source.edit` refuses ambiguous and missing hunks before touching any file.
- `tests/autoapp-boundary.test.ts` passes and its allow-list has a reason per entry.
- The demo log in the report has one row per step 3 to 8 with an outcome.

## Report

`prompts/autoapp/reports/08b-fixups.md`.

## Commit

```
Fix release identity, add hunk edits, enforce the module boundary

A release's identity now covers the whole specification, so a change to
views, migrations, acceptance or capabilities is a new release. The
engineer edits files by exact hunk instead of rewriting them, which is
what local models were measured to stall on. No code uses instanceof on
a value that can cross the release boundary, and a test keeps it so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
