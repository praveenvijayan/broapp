# 12h — Design guidance the engineer can act on

## What was built

- `src/engineer/design.ts`: `DesignRule`, `DESIGN_RULES` (35), `DESIGN_CHECK` (8), `designTopic()`.
  Exported from `broapp-autoapp/engineer`. `REFERENCE_TOPICS` gains `design`; the `views` topic
  points at it in one sentence; the `spec.reference` description lists it and says to read it for
  `views.ts`.
- `workspace.ts`: `READABLE` gains `^(PRODUCT|DESIGN)\.md$`, `WRITABLE` does not. A missing
  readable file is now `not_found` rather than a raw `ENOENT` (see Decisions).
- `knowledge/path.ts`: a `Context: …` line after the constraints line, naming each brief file that
  exists with its first non-heading line cut at 80 characters.
- `instructions.ts`: the `spec.reference` sentence replaced as specified; the hunk-size sentence
  trimmed to "hunks under a kilobyte land". 70 lines, five headings intact.
- Starter: `PRODUCT.md` (three questions, no marker), a README paragraph, the packing test's list.
- `scripts/design-detect.ts` + `bun run design-detect`; `impeccable@4.1.0` pinned as a **root
  devDependency**; two steps in the `theme` CI job (gallery, then the detector).
- `packages/broapp-autoapp/NOTICE.md` (in `files`), `docs/autoapp/design-guidance.md`, pointers from
  `components.md`, `design.md`, the docs index and the site; `00-common-rules.md` "2b" gains the
  design pass; `skills/broapp/SKILL.md` gains a paragraph in step 6 and one in the Autoapp section.

## Rules per section, and what each section names

| section | rules | kinds named | properties named |
|---|---|---|---|
| page | 4 | page, button, table, section, text, form, status | label, confirmText |
| structure | 8 | page, button, form, text, status, section, table | submit, children, fields, then, params, columns, width |
| states | 8 | button, form, page, table, status, section, text | sources, emptyText, confirmText, rowActions, source, path, refresh, required, min, max, label, hidden |
| copy | 10 | button, form, table, page, text, status | label, title, template, format, header, emptyText |
| colour | 5 | button, table, status, form, page, text | — |

All six kinds are named in every section but colour, which names five. Rendered: **68 lines**.

## The four findings

All four were the same pair, and none of them was in a preset: they were the **gallery's own
frame** — `.g-intro` once and `.g-title` three times (one per preset), `#ffffff` on `#8a8d93`,
**3.3:1** against a 4.5:1 requirement. A page about contrast failing its own rule, invisible to
12g's harness because that harness measures the pairs it was told about (one button, one select,
the text on a card) and was never told about the page around them.

| element | before | after | ratio |
|---|---|---|---|
| `body` ground | `#8a8d93` | `#32353c` | — |
| `.g-intro` text | `#ffffff` on `#8a8d93` | `#f2f3f5` on `#32353c` | 3.3:1 → **11.1:1** |
| `.g-title` ×3 | `#ffffff` on `#8a8d93` | `#f2f3f5` on `#32353c` | 3.3:1 → **11.1:1** |

Nothing was called decorative and no bar was lowered. Neither new value is pure black or pure
white, which is the skill's own rule about neutrals.

## The detector, after the fix

`bun run design-detect` scans four pages: the gallery, and `starter.html`, `quiet.html`,
`override.html` from `scripts/theme-check.ts`.

```
scanned packages/broapp-autoapp/.broapp-tmp/theme-gallery.html
scanned .broapp-tmp/theme-check/starter.html · quiet.html · override.html
design-detect  4 pages, no primary findings
```

**Primary: 0. Advisory: 0** — on the gallery and on all three harness pages. There are **no
ignores**: no `.impeccable/` directory exists, and `design-detect` passes `--no-config` so one
added later cannot change what CI enforces without somebody editing this script.

The detector test **ran** (it is not skipped): `node_modules/.bin/impeccable` is present because
the dependency is pinned in the repository's own `package.json`. It draws the gallery itself and
asserts zero primary findings; `skipIf` covers a checkout where the binary is missing.

## The sentence that was cut

> …and ones over two kilobytes have been measured not to.

Removed from step 3, as the prompt directed, to make room for the `design` clause in step 2.

## Decisions I made

1. **A missing readable file is `not_found`.** `readWorkspaceFile` called `statSync` with no
   existence check, so a missing file reached the engineer as a raw `ENOENT`, not a `PublicError`.
   `PRODUCT.md` is the first readable path that is *normally* absent, so this stopped being a
   theoretical rough edge; one line fixes it and the common rules require `PublicError`.
2. **The context line is only on the matched branch.** The prompt says "after the constraints
   line", and the constraints line exists only when something matched. The no-match branch is
   asserted elsewhere to claim nothing at all, and adding a line there would have broken that
   property for no gain.
3. **Two extra pointers**, beyond the files the prompt lists: `docs/autoapp/README.md` and
   `scripts/build-site.ts`, so the new document is reachable the way every other Autoapp document
   is rather than only by link from two of them. `tests/site.test.ts` asserts the Autoapp landing
   page's reading order, so its list gained the new row; six became seven.
4. **Em dashes.** The topic bans them in anything a person reads, so they were scrubbed from every
   rule. The one that remains is in the topic's own `# design — …` heading, which matches the five
   existing topics and the test regex `^# <topic> `.
5. **The report is over 100 lines.** 12h requires the rendered topic in full, which is 68 lines on
   its own. The topic is appended below rather than cut.

## Commands run

| command | result |
|---|---|
| `bun run typecheck` | 0 |
| `bun test tests/autoapp-verify.test.ts …engineer… …create… …knowledge…` | 143 pass, 0 fail |
| `bun run --cwd packages/broapp-autoapp theme-gallery` | 60375 bytes |
| `bun run design-detect` | 4 pages, no primary findings |
| `bun run theme-check` | `checked 9 combinations in 2s · every rule passed` |
| `bun install` | `373 installs across 410 packages` |
| `bun run check` | **740 pass, 0 fail** across 45 files (rerun after the em-dash scrub and the site-test row) |

The `theme` CI job was not run here; its two new steps are the gallery script and `design-detect`,
both of which pass locally and need no browser.

## Acceptance criteria

| criterion | result |
|---|---|
| A design topic every line of which the engineer can act on, and nothing it cannot | **pass** — 35 rules, all held to a kind or a declared property by a test; nine banned words asserted absent; 68 lines |
| `PRODUCT.md` / `DESIGN.md` readable, named in the evidence, not writable | **pass** |
| The instructions ask for the check's count | **pass** — 70 lines, five headings |
| The detector runs in CI over the gallery and the harness page; four findings gone or justified | **pass** — all four fixed, none waived |
| Framework authors told to run critique, audit and polish before the gallery step | **pass** |
| Attribution carried in the package and the docs | **pass** — `NOTICE.md` in `files`, `design.ts` header, `design-guidance.md` |
| `bun run check` green; every command exits 0 | **pass** |

## Open questions

- The check is self-reported and unscored, by design. Whether the engineer actually reports a
  count, and whether the count is honest, is not observable until 12d-style replay runs against a
  model. Nothing in this prompt measures it.
- `design-detect` reads static HTML. The harness pages are real compiled pages, so the coverage is
  good, but a state only reachable by clicking (an open select, a row action's confirmation) is
  still measured only by `theme-check`'s browser run.

## The rendered `design` topic

```
# design — what a good page is, and how to check it

The `views` topic is what the specification will accept. This is what to do with
it. Every line names a kind or a property you can set, because a rule you cannot
act on is worse than no rule: there is no freedom here over position, type or
timing, and none of this asks for any.

## What a good page is
- A person fluent in the tools they already use should sit down at a `page` and trust it. Earned familiarity is the goal; the application disappears into the task.
- The failure to avoid is strangeness with no purpose: an invented word for a standard thing, a `button` unlike every other `button`, a `table` that behaves unlike the one on the page before.
- `section`, `text`, `table`, `form`, `button` and `status` are the whole vocabulary. When a request needs something else, say which kind comes closest and that the rest is a decision for the framework.
- Consistency is an affordance: the same act on two pages carries the same `label` and the same `confirmText`, and a person who learned it once does not learn it again.

## Structure
- One primary act per `page`: the `button` or the `form` `submit` the person came for, with nothing competing for the same attention.
- Put the thing the person came for first in a page's `children`. A `text` or a `status` that only sets context goes after it.
- At most five entries at the top of `children` before a `section` is due. Past five, nobody sees the hierarchy.
- A `form` shows at most four `fields` before a `section` breaks the rest out: four is what a person holds at once.
- A `section` with one child is not a grouping. Drop it and let the child stand.
- Disclose progressively: a second page reached with `then` beats one page carrying everything somebody might want.
- Never ask a person to carry a value from one page to the next in their head. Carry it in the page `params` and read it as `$param`.
- A `table`'s `columns` are the ones somebody decides by; one nobody reads is noise. `width` says which of them matter.

## Every state
- The renderer draws hover, focus-visible and disabled for every `button`, every field and every link. Do not ask for them, and do not ask for them to be taken away.
- The renderer draws a page's wait while its `sources` load, and a message when one of them fails. What it cannot invent is the words.
- Every `table` needs an `emptyText` that teaches: what belongs here, and how the first row comes to exist. Never "No items".
- A `button` or a `rowActions` entry that changes something needs a `confirmText` naming the thing and the consequence: "Delete ‘Release notes’? This cannot be undone."
- Anything a person waits on or has to trust gets a `status` with its `source` and `path`, so the page says where it stands instead of looking finished.
- A `form` that changed something lists every source it invalidated in `refresh`, so the page agrees with itself the moment the person looks back at it.
- A `field` declares `required`, `min` and `max` rather than explaining them in its `label`: the renderer enforces and reports what is declared, and nothing else.
- `hidden: true` is for a component kept in the specification on purpose. It is not where an unfinished component is parked.

## Copy
- An act’s `label` is a verb and a noun ("Add item", "Save changes"), never "OK", "Submit" or "Go".
- A `field`’s `label` is the noun the person uses, not the column name the schema uses.
- A page’s `title` is what the person calls the screen. It is the heading and the name in navigation both, so it has to read as each.
- A `text` `template` beside a heading has to add something. Restating a `title` or a `label` costs a line and says nothing.
- What a person reads when something failed says what happened and what to do next. Write each operation’s summary the same way: the gate shows it when it asks.
- A `text` above a `form` answers "why are you asking", not "this is the name field".
- A `status` with `format` `datetime` says when, not whether. A true-or-false state reads better as a word in a `text` than as a bare boolean.
- One word per thing, across every `title`, `label`, `header` and `emptyText` on every page. Variety here reads as two different features.
- No em dashes in anything a person reads: not in a `title`, a `label`, a `template`, an `emptyText` or a `confirmText`. Commas, colons, semicolons, periods and parentheses do the work.
- When `PRODUCT.md` is in the workspace, its audience and its tone decide every word above. Read it with `source.read` before writing any of them.

## Colour and contrast
- A `button`, a `table`, a `status` and a `form` take every colour from a token. Colour is decided in `src/ui/styles.css` and nowhere else; the `theme` topic has its rules.
- The palette is restrained: tinted neutrals, and the accent on acts and on state only (a `button` that does something, a selected row, a `status` that warns). Decoration gets none of it.
- Keep the accent under about a tenth of what a person sees on a `page`. It works because it is rare.
- No pure black and no pure white in a palette, and no grey with no tint in it: all three read as a value nobody chose.
- Text needs 4.5:1 against what is behind it and a control needs 3:1, placeholder text included. When `DESIGN.md` is in the workspace, the `theme` topic’s role mapping turns it into tokens.

## Before you ask the person to look

Answer these eight about the views you just wrote. Count the ones that fail.

1. Single focus: does the page have exactly one primary act, with nothing competing for it?
2. Chunking: is every `form`'s `fields` list, and every `section`'s `children` list, four or fewer?
3. Grouping: is everything that belongs together inside one `section`?
4. Hierarchy: does the first entry in `children` answer why the person opened the page?
5. One thing at a time: can the person finish one decision before the next is put to them?
6. Minimal choices: are four or fewer `button` and `rowActions` labels in front of the person at once?
7. Working memory: does every value the page needs arrive in `params` or a `source`, rather than in the person's head?
8. Progressive disclosure: is what is not needed now behind a `then` or a later page?

Say the count, and name the items that failed, in the same message that asks the
person to open the preview. Nothing scores this for you and nothing blocks on it:
it is there so the person knows what you already know.
```
