# Publishing

Nothing in this repository publishes anything automatically. This page lists
what a maintainer has to do, and what they have to decide.

## Status

Published on npm from the `Publish to npm` workflow, each with provenance:
`broapp` at 0.4.2, `create-broapp`, `broapp-ai-anthropic` and
`broapp-ai-compatible` at 0.4.1, `broapp-ai-elements` at 0.4.4, and
`broapp-autoapp` at 0.3.7 (2026-09-13). Earlier: 0.4.7 with the launcher at 0.3.6, 0.4.6 with the launcher at 0.3.5 and the panel at 0.4.3, 0.4.5 with the launcher at 0.3.4, 0.4.4 with 0.3.3, 0.4.3 with the launcher at 0.3.2 and the panel at 0.4.2, then 0.4.2 with 0.3.1, 0.4.1 with 0.3.0, and
0.4.0 with 0.2.0, all on 2026-09-11; 0.3.0 on 2026-09-08; 0.2.0 and 0.1.0
before that. To generate from an unreleased checkout instead, see
[troubleshooting.md](troubleshooting.md).

Repository release v0.4.8 ships the launcher binaries built from the same
commit; it moves the core, for the per-run transcript and the optional
`runId` on a history turn (additive, so a patch), the AI panel, which names
the run, and the launcher, which depends on both. v0.4.7 before it moved only
the launcher: the apps directory listing ignores stray files, an unanswered
question is reported as expired, and a strip shows while one waits. v0.4.6 moved the AI panel, for the running
mark that stays the whole turn, and the launcher, which depends on it and
whose engineer stops walking lesson ids. v0.4.5 moved only the launcher, for removal, the blank
template and the design topic; v0.4.4 only the launcher, for its banner; v0.4.3 moved two
packages: the launcher, because a created application installs
`broapp-autoapp@^<the launcher's version>` and 0.3.2 carries the theme contract
its starter now relies on; and the AI panel, because its portalled components
and its corner radius were fixed. The launcher's peer range on the panel is
`>=0.4.4`. A created application installs `broapp@^0.4.2` and
`broapp-autoapp@^0.3.7`.

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

**Bump the version.** The names are claimed; a version that already exists
cannot be published again, and cannot be republished after an unpublish. Raise
the version in all four `package.json` files, in `VERSION` in
`packages/create-broapp/src/main.ts`, and in `skills/broapp/SKILL.md` before
running the workflow. The provider packages declare a `broapp` peer range;
raise it whenever they start needing something newer.

**Publish `broapp` first, the provider packages second, `create-broapp` last.**
The providers import `broapp/ai/host` and the generator's default range points
at the `broapp` it was released with, so nothing may reference a `broapp` that
is not on npm yet.

```bash
bun run scripts/stage-template.ts     # the generator ships the template
cd packages/broapp               && npm publish --provenance --access public
cd ../broapp-ai-anthropic        && npm publish --provenance --access public
cd ../broapp-ai-compatible       && npm publish --provenance --access public
cd ../create-broapp              && npm publish --provenance --access public
```

Or use the **Publish to npm** workflow, which runs the checks first, requires a
`npm-publish` environment approval, and defaults to `--dry-run`.

**Verify `bun create broapp` resolves.** Bun maps `bun create broapp` to the npm
package `create-broapp`. Test it from a clean machine or a container:

```bash
bun create broapp /tmp/verify-me
```

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
