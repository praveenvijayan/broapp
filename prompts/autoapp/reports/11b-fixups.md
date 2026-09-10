# 11b — Fix-ups from the review of 11

## What was built

- `src/launcher/starter-asset.d.ts`, the ambient declaration for
  `*/dist/starter-template.json`, verbatim from the prompt. `files` ships `src`.
- `apps.create` is `effect: 'external'`; the comment says why, and
  `docs/autoapp/security.md`'s creation paragraph is rewritten around it, the
  fetch sentence moved up to be the reason. The gate test names no effect.
- `instructions.ts`: steps 2, 3 and the migrations paragraph back to their 08c
  wording, word for word. 69 lines.

Item 1 both ways, `tsc -b --force`: with `dist/starter-template.json` moved
aside, **exit 0**; moved back, **exit 0**. Before the declaration the first was
`error TS2307: Cannot find module '../../dist/starter-template.json'`.

## What the workspace list lost

The test asserts ≤ 70 lines and restoring the wording cost four, so the list
paid. The `styles.css` bullet lost its example properties and the `.input`
sentence, as the prompt allowed, then merged with the `main.tsx`/`index.html`
bullet into one `src/ui/` bullet — a line more than the two cuts could find. The blank line before the list is gone, and the creation paragraph
is two lines: "It needs the network once", dropping "installs dependencies",
which its tool description says twice over. No bullet lost a fact; the prompt's
fallback was not needed.

**Decision:** `launcher.appCreate` is still a `write` — the prompt names only
`apps.create`, and on channel `user` the gate allows every effect either way.
The same install makes it `external` by the rules' own definition, so the
security document now reads asymmetrically about one function. Open. The commit
trailer names Claude Opus 5, per this session's attribution rule.

## Commands, and acceptance

`bun run typecheck` exit 0; `bun test tests/autoapp-{create,engineer,gate}.test.ts`
88 pass, 0 fail; `bun install && bun run check` exit 0, 598 pass. All three
criteria pass: a fresh checkout typechecks without the artefact; `apps.create`
is `external`, reason in the comment and the document, no test loosened; 08c's
measured sentences are back, at 69 lines.
