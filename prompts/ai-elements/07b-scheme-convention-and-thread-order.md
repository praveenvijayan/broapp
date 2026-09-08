# 07b — A scheme convention that survives the bundler, and stable thread order

## Why

Report 07 found that Bun's CSS bundler downlevels `light-dark()` into a
`prefers-color-scheme` query with `--buncss-light` / `--buncss-dark`
toggles. Every built page shows it: the launcher page carries 25
`buncss-dark` tokens, the notes page 24. So prompt 04d's rule — *the panel
follows the page's `color-scheme`, never the OS* — is true in
`styles.css` and false in every page that ships. The launcher hides it by
defining all of the panel's variables under `data-scheme`; any other
application gets OS-keyed fallbacks. The CSS test passes only because it
reads the pre-bundle file.

Report 07 also left `tests/ai-threads.test.ts` flaky: `ai.threadsList`
orders by `updated_at DESC, id DESC`, and two writes in the same
millisecond are ordered by a random UUID.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 04d, 06, 07.
- `packages/broapp-ai-elements/src/ui/tailwind.css`, all of it.
- `packages/broapp-autoapp/src/launcher/ui/launcher.css` — the three
  `data-scheme` blocks 07 wrote; `main.tsx` — how the attribute is set
  before first render; `BroappSchemeToggle` usage in `App.tsx`.
- `examples/notes/src/ui/styles.css` — its own `prefers-color-scheme`
  block.
- `packages/broapp/src/cli/build-page.ts` lines 150–210 — the `Bun.build`
  call; check whether a `target`/`css` option controls downleveling
  (search the Bun docs in `node_modules/bun-types` for `Bun.build`'s CSS
  options). If an option turns it off, **do not use it**: the fix below
  must work regardless, and a page's author does not control Broapp's
  bundler flags.
- `packages/broapp/src/ai/host/threads.ts` — schema, migrations, the
  list query, `touch`/save paths.
- `tests/ai-elements-css.test.ts`, `tests/build.test.ts`, `tests/ai-threads.test.ts`.

## Step 1 — the convention

Three states, decided by the page, never by the panel alone:

| `<html data-scheme>` | Panel |
|---|---|
| `"light"` | light tokens |
| `"dark"` | dark tokens |
| absent | follows `prefers-color-scheme` |

In `tailwind.css`, remove every `light-dark()`. Write the light literals
in the base `.broapp-chat` block as today, then:

```css
:root[data-scheme="dark"] .broapp-chat { /* dark literals */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-scheme="light"]) .broapp-chat { /* the same dark literals */ }
}
```

Keep the `var(--bg, …)` indirection so an application's own variables
still win in every state. Put the dark literals in one `@layer base`
block used twice rather than two copies (a Tailwind `@utility` or a
plain CSS custom-property set both work; pick the one whose built output
is smallest and say which). The regression-guard wording in
`00-common-rules.md` item 13 changes to this table; edit it.

Tailwind's `dark:` variant: 07 pointed it at an attribute nothing sets.
Point it at `[data-scheme="dark"]` now (`@custom-variant dark
(&:where([data-scheme="dark"], [data-scheme="dark"] *))`) so vendored
`dark:` classes agree with the convention in the forced state; in the
"absent" state they stay light, which is acceptable for the few places
they appear — list them in the report.

Launcher: `launcher.css` already keys on `data-scheme`; make sure its
"absent" state is the OS media query with the `:not([data-scheme="light"])`
guard, not "light". `BroappSchemeToggle` "system" must **remove** the
attribute, never set `"system"`. Notes example: it declares its own
`prefers-color-scheme` block and sets no attribute, so it lands in the
"absent" row and keeps behaving; add `data-scheme` support only if it is
one line.

`docs/ai.md` "The chat panel": the table above, and one sentence that
`light-dark()` must not be used in a Broapp page because the bundler
rewrites it (a limitation of today's Bun, worth a version note).

## Step 2 — prove it on the built page

`tests/build.test.ts`: build a page that imports
`broapp-ai-elements/styles.css` and assert the HTML contains **no**
`buncss-` and no `light-dark(`, and does contain `data-scheme="dark"`.
This is the test 04d should have had. Keep the pre-bundle assertions in
`tests/ai-elements-css.test.ts` and drop its `light-dark(` expectation.

Also rebuild the launcher page and assert the same three things on
`dist/launcher-page.html` in whatever test already opens it (or add one
to `tests/autoapp-*.test.ts` that does).

## Step 3 — stable thread order

`threads.ts` migration 2: `ALTER TABLE threads ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
then backfill `seq` in `updated_at, rowid` order. Every write that bumps
`updated_at` (create, save, update) also sets `seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM threads)`
inside the same transaction. `ai.threadsList` orders by `seq DESC` only.
`updated_at` stays for display.

`tests/ai-threads.test.ts`: a test that creates three threads and saves
them in the order 1, 3, 2 within one tick (`Promise.all` is not enough —
call them sequentially without awaiting a timer), then asserts the list
is `[2, 3, 1]`; run it in a loop of 30 inside the test. The existing
restart test proves migration 2 applies to a version-1 file: add a
fixture written under migration 1 (a copied `.sqlite` from a test run at
`46e7a61`, checked in under `tests/fixtures/`) and assert it opens,
lists in the old order, and has `seq` afterwards.

## Verify

```bash
cd packages/broapp-ai-elements && bun run build:css && cd ../..
bun run typecheck
for i in 1 2 3 4 5 6; do bun test tests/ai-threads.test.ts || break; done
bun test tests/build.test.ts tests/ai-elements-css.test.ts
bun run --cwd packages/broapp-autoapp build:page
bun run check
```

The loop must pass six times in a row.

## Manual run

Launcher, compiled. Rows 12 and 13 from prompt 07 again (dark, system
with macOS light and dark), plus: notes example built and opened with
macOS dark — panel dark; with macOS light — panel light; then add
`data-scheme="light"` to its `<html>` by hand in `index.html`, rebuild,
open with macOS dark — panel **light**.

## Report

`prompts/ai-elements/reports/07b-scheme-order.md`: which Bun option, if
any, would have disabled the downleveling and why it was not used; the
`dark:` class sites; the six-run result; the fixture's origin.

Commit:

```
Key the panel's scheme on a data attribute the bundler cannot rewrite, and order threads by a sequence
```
