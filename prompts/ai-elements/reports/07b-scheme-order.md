# 07b — A scheme convention that survives the bundler, and stable thread order

## What was built

`tailwind.css` carries no `light-dark()`. The panel's tokens read two toggle
variables, set light in the base block and dark by `:root[data-scheme="dark"]`
and, inside a `prefers-color-scheme: dark` query,
`:root:not([data-scheme="light"])`. `@custom-variant dark` points at
`[data-scheme="dark"]`. `examples/notes` gained the `:not()` guard.
`threads.ts` has migration 2 — a `seq` column, backfilled and bumped by every
write — and lists by `seq DESC` alone. New tests: the built page in
`build.test.ts` and `autoapp-offline.test.ts`; the same-millisecond order and a
version-1 fixture in `ai-threads.test.ts`. `docs/ai.md` carries the table and
the rule.

## Which Bun option would have turned the downlevelling off

**None.** `BuildConfig` in `bun-types@1.4.1` has no CSS, browserslist or
target-baseline key — `target: 'browser'` selects a runtime, not a CSS
baseline. Even if one existed the prompt forbids it, and rightly: it would live
in `broapp/src/cli/build-page.ts`, which a page's author does not control, and
`bun build` may not always be what bundles this stylesheet.

## Which shape, and why

Both were written and built. **Toggles: 61,422 bytes. Dark literals repeated in
two rules: 62,619.** The toggles win by 1,197 bytes and keep every literal in
one place. They are the mechanism Bun generates, written by hand where nothing
is left to rewrite: `--scheme-light: initial` is guaranteed-invalid so
`var(--scheme-light, X)` falls back to `X`, and `--scheme-dark: ` is empty so
`var(--scheme-dark, Y)` substitutes nothing.

## The `dark:` class sites

All vendored, and every one sets a colour derived from a token that is already
correct for the scheme — so in the "absent" state what they change is an
opacity, a border or a transparent background:
`input-group.tsx` (`bg-input/30`, `bg-transparent` ×2, `has-…ring-destructive/40`),
`button.tsx` (`bg-destructive/60`, `focus-visible:ring-destructive/40`,
`border-input`, `bg-input/30`, `hover:bg-input/50`, `hover:bg-accent/50`),
`badge.tsx` (`bg-destructive/60`, `focus-visible:ring-destructive/40`),
`input.tsx` / `textarea.tsx` / `select.tsx` (`bg-input/30`,
`aria-invalid:ring-destructive/40`, `hover:bg-input/50`),
`dropdown-menu.tsx` (`data-[variant=destructive]:focus:bg-destructive/20`),
`attachments.tsx` (`hover:bg-accent/50`),
`conversation.tsx` (`bg-background`, `hover:bg-muted` ×2).

## Decisions I made

- **The launcher page asserts no *use* of the toggles, not their absence.** Bun
  writes `--buncss-*` beside every `color-scheme` declaration whether or not
  anything reads it, and `launcher.css` declares one per palette block. Three
  unused pairs cannot repoint a colour; a `var(--buncss-…)` can, and there are
  none. The panel-only page in `build.test.ts` declares no `color-scheme` and
  holds the strict `not.toContain('buncss-')` the prompt asked for.
- **`data-scheme="dark"` is matched by a regex**: both minifiers drop the
  quotes, so the built page reads `[data-scheme=dark]`.
- **That test spawns `bun run build:page`.** `Bun.build` inside `bun test`
  could not resolve the relative imports of a source tree outside the test's
  own directory (it failed on `../contract.ts`), though the same call works
  from an ordinary script. Reading `dist/` would have been worse: the staleness
  check that rebuilds the launcher watches only `packages/broapp-autoapp/src`,
  and this change is in another package.
- **The notes example gets the guard and not a forced dark.** One line, as the
  prompt allowed: its palette *is* one `prefers-color-scheme` block, so a
  forced dark would mean a second copy of it.
- **`seq` is taken in the statement that writes the row**, not read and then
  written, so nothing can interleave. The backfill orders by `updated_at` with
  `rowid` breaking ties — the order the old query showed.

## The fixture

`tests/fixtures/threads-v1.sqlite`, 24 KiB, written by
`git show 46e7a61:…/threads.ts` run in a scratch directory: three conversations
five milliseconds apart and a save on the oldest, then `close()`. It carries
`user_version = 1` and no `seq`. The test copies it before opening, because
opening migrates it.

## The manual run

Launcher and notes compiled, data directories under the scratch directory. The
machine's scheme was emulated on the browser pane, which is the signal
`prefers-color-scheme` reads.

| # | Step | Outcome |
|---|---|---|
| 12 | launcher, dark | ✅ page and panel `#16171a` / `#eceef1` |
| 12 | launcher, light on a dark machine | ✅ page and panel `#f6f7f9` / `#33383f` |
| 13 | launcher on "system", machine light then dark | ✅ `#f6f7f9` then `#16171a`, panel following, attribute absent throughout |
| — | notes, machine dark / light | ✅ `#16171a` / `#eceef1`, then `#fbfbfa` / `#1b1a18` — page and panel together |
| — | notes with `data-scheme="light"`, rebuilt, machine dark | ✅ `matchMedia('(prefers-color-scheme: dark)').matches === true`, page and panel `#fbfbfa` / `#1b1a18` — the case that was broken before this prompt |

The `index.html` edit was an experiment and is reverted.

## Commands run

```
bun run build:css                                 # styles.css, 60.0 KiB
bun run typecheck                                 # exit 0
bun test tests/ai-threads.test.ts ×6              # 11 pass, 0 fail, six times
bun test tests/build.test.ts + css + view         # 57 pass, 0 fail
bun run --cwd packages/broapp-autoapp build:page  # 1238.0 KiB
bun run check                                     # 577 pass, 0 fail, 37 files
```

## Open questions

- **The third state and Tailwind's `dark:` utilities disagree by design**: with
  no attribute on a dark machine the tokens go dark and those utilities stay
  light. Making them agree needs the variant to name the media query too, which
  `@custom-variant` cannot express in one definition; the sites listed above
  are all opacity or border variations, so nothing becomes illegible.
- **`--buncss-*` pairs are still emitted** wherever a page declares
  `color-scheme`. Harmless while nothing reads them, worth re-checking if Bun
  ever wires them into more than `light-dark()`.
