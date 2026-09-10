# 11b — Fix-ups from the review of 11

Three small things. No new design. Read `prompts/autoapp/reports/11-new-application.md`
first; commit `9d37f8d` is the subject.

## 1 — typecheck fails on a fresh checkout (blocker)

`src/launcher/main.ts` imports `../../dist/starter-template.json`, a build
artefact. With `resolveJsonModule` on, a missing file is `TS2307`, so
`bun run typecheck` is red on any checkout that has not run `build:template`
— which is the CI job "Typecheck and test", where typecheck runs before any
build. The page import survives the same situation only because `bun-types`
declares `*.html` as an ambient module.

Verified fix: an ambient declaration for the artefact's path. Add
`packages/broapp-autoapp/src/launcher/starter-asset.d.ts`:

```ts
/**
 * `dist/starter-template.json` is a build artefact — `scripts/build-template.ts`
 * writes it, and it is not in git. Without this declaration a checkout that has
 * not built it cannot typecheck, because `resolveJsonModule` makes a missing
 * JSON file an error. The shape here is `StarterTemplate`; `main.ts` casts to
 * the real type at the import.
 */
declare module '*/dist/starter-template.json' {
  const template: { readonly files: Readonly<Record<string, string>> };
  export default template;
}
```

Prove it the way the review did: move the artefact aside, run
`bun run typecheck` (exit 0), move it back, run it again (exit 0). Put both
lines in the report. `files` already ships `src`, so the declaration reaches
the tarball.

## 2 — `apps.create` is `external`, not `write`

The gate's table in `00-common-rules.md`: `external` "reaches outside the
machine or the data directory (network, …)". Creation installs from the
registry. Change the effect and the comment above it to say why; on channel
`ai` it still asks, and the launcher's gate is never in preview, so nothing
observable changes for a person — the classification is the point. Update
the sentence in `docs/autoapp/security.md` and the test that drives the tool
through the gate if it names the effect.

## 3 — the engineer's instructions were reworded to make room

Report 08c measured specific sentences ("copy the lines and do not worry
about the spaces"; the whole-file-rewrite warning). Restore the original
wording of steps 2 and 3 and the migrations paragraph, and make room for the
new creation paragraph by shortening the **workspace** list instead (the
`styles.css` bullet can lose its example properties; the `.input` sentence
can go). Stay under 70 lines. If it does not fit, say so in the report and
keep the creation paragraph over the `.input` sentence.

## Verification

```bash
bun run typecheck            # once with dist/starter-template.json moved aside, once with it back
bun test tests/autoapp-create.test.ts tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts
bun run check
```

## Report

`prompts/autoapp/reports/11b-fixups.md`, under 40 lines.

## Commit

```
Let a fresh checkout typecheck without the starter artefact

An ambient declaration stands in for dist/starter-template.json until the
build writes it. apps.create is classified external, which is what an
install from the registry is. The engineer's measured wording is restored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
