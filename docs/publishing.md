# Publishing

Nothing in this repository publishes anything automatically. This page lists
what a maintainer has to do, and what they have to decide.

## Status

Neither package is on npm yet. `broapp` and `create-broapp` are both
unregistered, so `bun create broapp` does not work until someone publishes them.

Until then, generate from a checkout — see
[troubleshooting.md](troubleshooting.md).

## Before publishing

1. `bun run check` — typecheck and the full suite.
2. `bun run dryrun` — packs both packages, generates a project outside the
   workspace from the **tarballs**, installs, typechecks, builds an executable,
   and runs it from an unrelated directory. This is the check that catches a
   package that works from the monorepo and not from npm.
3. Decide the version. Both packages share one, and `create-broapp` writes
   `^<its own version>` as the generated project's `broapp` dependency — so a
   `create-broapp` published ahead of a matching `broapp` generates projects
   that cannot install.

## Steps requiring human authorisation

These are the things a person has to do. None of them happen from a push.

**Register the names.** `broapp` and `create-broapp` are both free on npm as of
2026-09-05. Publishing claims them. Check again first — an unpublished name is
not a reservation.

**Publish `broapp` first, then `create-broapp`.** Never the other way round.

```bash
bun run scripts/stage-template.ts     # the generator ships the template
cd packages/broapp        && npm publish --provenance --access public
cd ../create-broapp       && npm publish --provenance --access public
```

Or use the **Publish to npm** workflow, which runs the checks first, requires a
`npm-publish` environment approval, and defaults to `--dry-run`.

**Verify `bun create broapp` resolves.** Bun maps `bun create broapp` to the npm
package `create-broapp`. Test it from a clean machine or a container:

```bash
bun create broapp /tmp/verify-me
```

**Drop the `overrides` workaround when upstream is fixed.** Every generated
project carries `"overrides": { "@brobridgejs/core": "0.2.0" }` because
`brobridge@0.2.0` shipped an unresolved `workspace:^` specifier. When a fixed
`brobridge` is released, remove the override from the template, from this
repository's `package.json`, raise the dependency floor, and delete the section
in the generated README. See [upstream-blockers.md](upstream-blockers.md).

**Decide about signing.** Release binaries are unsigned. macOS notarisation
needs an Apple Developer account and must run on macOS; Windows needs a
code-signing certificate. Neither is set up. Until they are, releases should
keep saying so — [packaging.md](packaging.md).

**Publish a release.** The release workflow builds, smoke-tests the native
targets, and creates a **draft**. Reviewing and publishing it is manual, on
purpose.

## Version policy

Pre-1.0, so a minor bump may break things. Say so in the release notes.

The generated project depends on `broapp` by caret range, so a project generated
today picks up compatible fixes. A breaking change to the runtime therefore
needs a minor bump pre-1.0 and a note in the release.

## What is intentionally not automated

- Publishing to npm on a tag. Publication is irreversible for a version.
- Publishing a GitHub release. The workflow drafts one; a person publishes it.
- Signing. Nothing here has credentials, and it should not.
