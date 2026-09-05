# Contributing

## Getting set up

```bash
git clone https://github.com/praveenvijayan/broapp
cd broapp
bun install
bun run check      # typecheck + tests
```

Bun 1.2 or newer. Nothing else.

## Layout

```
packages/broapp          Runtime and build tooling. The published dependency.
packages/create-broapp   The generator.
templates/react-ts       The canonical template.
examples/*               Generated from the template by scripts/new-example.ts.
tests/                   Cross-cutting tests, including a real bridge harness.
scripts/                 Packing, staging, the dry run, the binary smoke test.
docs/                    Prose.
```

**The examples are generated, not hand-written.** `scripts/new-example.ts` runs
the actual generator and then repoints `broapp` at the workspace. An example
built by hand would stop testing whether the published tooling is enough to
build a real application, which is the reason the examples exist.

## Running things

```bash
bun run check                                  # typecheck + tests
bun test tests/bridge.test.ts                  # one file
bun run scripts/pack-local.ts                  # pack both packages
bun run scripts/release-dry-run.ts --keep      # full dry run, keep the output
bun run scripts/smoke-binary.ts ./path/to/bin  # native smoke test
cd examples/notes && bun run dev               # run an example
```

## What a change needs

**A test that would have failed before.** Behaviour, not implementation:
`tests/bridge.test.ts` connects a real client to a real bridge over a real
socket, and that is the level to write at.

**Typecheck clean.** `bun run check`, and `bunx tsc --noEmit` inside any example
you touched.

**The dry run passing** if you changed anything in `packages/` or `templates/`.
It is the only thing that catches a package which works from the monorepo and
not from npm.

## House style

**Comments explain why, not what.** The code says what it does. A comment earns
its place by recording a decision, a constraint, or a trap — why cancellation is
wired from `stream.closed` and not from the iterator, why the CSP hash is
computed after escaping, why the launch token is printed to the terminal but
never to a file. If a comment would be obvious from the line below it, delete it.

**Prose, not shouting.** No bold-per-sentence, no emoji in code or docs. British
spelling in prose; code and API names as upstream spells them.

**Be honest in documentation.** Do not describe something as verified unless it
ran. "Cross-compiled, not run" is a phrase this repository uses on purpose.

## Boundaries that are not negotiable

**Brobridge stays independent.** Consume its published packages and public API.
Do not fork, vendor, patch, or reimplement its protocol, authentication or
streaming. If it lacks something, write a small adapter on public API and record
the gap in [docs/upstream-blockers.md](docs/upstream-blockers.md).

**Do not weaken a security default.** No permissive CORS, no `'unsafe-inline'`,
no LAN binding, no skipping authentication in development. If a workflow is
awkward because of a security property, the answer is a better workflow — or a
documented limitation.

**No shell execution operations, and no unrestricted filesystem operations.**
Not in the template, not in an example. They turn a local application into
remote code execution the moment anything else goes wrong.

**The browser bundle must not import host code.** There is a test.

## Adding an example

```bash
bun run scripts/new-example.ts my-example "My Example" "One-line description."
```

Then replace the contract, the host operations and the UI. An example should
demonstrate one thing well and say in its README what that thing is.

## Commits and pull requests

Present tense, imperative, explaining why where it is not obvious. Small and
focused. Say in the description what you ran and what the result was.

## Reporting security problems

Transport, trust fence, or authentication issues belong to
[Brobridge](https://github.com/praveenvijayan/brobridge/security). Issues in the
generator, the build, the contract layer or the lifecycle belong here — open a
private security advisory rather than a public issue.
