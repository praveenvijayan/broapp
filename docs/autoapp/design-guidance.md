# Design guidance the engineer can act on

The engineer decides what a page is made of and every word on it. Until the
`design` topic it knew two things and no more: what the specification would
accept (`spec.reference` topic `views`) and which token sets which colour
(topic `theme`). Nothing told it that a table's `emptyText` should teach, that a
form's fields group in fours, that a button's label is a verb and a noun, that an
error says what happened and what to do next, or that the accent belongs on
actions and state and nowhere else. So it wrote pages that validated and read
like nobody had decided anything.

## What the topic is

`spec.reference` with `topic: 'design'`. Thirty-five rules in six sections —
what a good page is, structure, every state, copy, colour and contrast, and an
eight-item check — generated at module load from the table in
[`src/engineer/design.ts`](../../packages/broapp-autoapp/src/engineer/design.ts),
the way the `theme` topic is generated from the token table. Under 120 lines.

Every rule in the table carries the component kinds it is about and the view
properties it names, and a test holds it to them: every `kinds` entry is a real
kind, every `properties` entry is declared in `views/types.ts`, and each of the
six kinds is named by at least one rule. That is the whole point of the shape.
A rule the engineer cannot act on with `section`, `text`, `table`, `form`,
`button` and `status` is a rule it will either ignore or hallucinate a way to
follow, and either is worse than silence.

The instructions ask for one thing back: the count of failed check items, in the
same message that asks the person to open the preview. Nothing scores it and
nothing blocks on it. It is there so the person is told what the engineer
already knows.

## What was deliberately left out

Layout beyond ordering and grouping. Type pairing, scales and faces. Timing and
easing. Colour spaces. Cards, elevation, overlays. Marketing surfaces. The brand
register in full. None of it is expressible in a view specification: there is no
position, no size, no timing and no new element, by design, because the browser
runs a pinned renderer over data and never generated code. A test asserts the
rendered topic contains none of `font`, `animate`, `motion`, `oklch`,
`gradient`, `glass`, `modal`, `hero` or `landing`, so the omission cannot drift
back in as prose.

Colour is in the topic only as a rule about *where* colour is decided: the
engineer sets tokens in `src/ui/styles.css`, and the `theme` topic is the long
version. No rule asks it to write a colour into a page.

## The two context files

A workspace may carry `PRODUCT.md` (who uses this, what they come to do, what
tone they expect) and `DESIGN.md` (the palette and the style guide). Both are
readable by the engineer and neither is writable: they are the person's brief,
and an engineer that can rewrite the brief can agree with itself about anything.
When either exists, the task evidence names it with its first line, so the
engineer knows to read it rather than discovering it by listing files. The
`design` topic says what to do with each — `PRODUCT.md` decides every word, and
`DESIGN.md` goes through the `theme` topic's role mapping to become tokens.

The starter ships a `PRODUCT.md` with the three questions and room for three
answers. It carries no substitution marker; the person writes it.

## The detector

Impeccable also ships a detector: 61 deterministic rules, no model. `bun run
design-detect` runs it over the theme gallery and the three harness pages
`scripts/theme-check.ts` builds, and the `theme` CI job runs it after the
gallery. Primary findings fail; advisory findings are printed and never fail,
which is the detector's own contract.

It is worth being clear about what it caught, because it is the argument for
having it. `theme-check` measures the pairs it was told about — one button, one
select, the text on a card — and every one of them passed. The detector reads
every text-on-background pair on the page, and found four contrast failures in
the gallery's *own frame*: white on `#8a8d93` at 3.3:1, the page's heading and
its introduction. A page about contrast, failing its own rule, invisible to a
harness that was only ever pointed at the components. The ground is now `#32353c`
with `#f2f3f5` text, 11:1, and neither value is pure black or pure white.

No rule is waived. There is no `.impeccable/` directory, and `design-detect`
passes `--no-config` so that one added later cannot quietly change what CI
enforces: a waiver belongs in a report where somebody reads it.

## For people who write React and CSS

The engineer gets the distilled topic because it can only act on part of the
skill. Framework authors — anyone changing the renderer in
`packages/broapp-autoapp/src/react` or the panel in `broapp-ai-elements` — can
act on all of it, and should use the skill itself: `critique` and `audit` on the
gallery page, `polish` on the component's own file. "2b. Adding a component" in
`prompts/autoapp/00-common-rules.md` makes that a step before the gallery step.

## Attribution

The `design` topic is distilled from the **Impeccable** design skill by **Paul
Bakaus**, licensed under the **Apache License, Version 2.0**
(<https://github.com/paulbakaus/impeccable>). The material drawn on is its
product register, its copy, cognitive-load, resilience, first-run and contrast
references, and the shared design laws in its `SKILL.md`. The text was
**rewritten**, not copied, for a declarative renderer. The full notice and the
statement of modification are in
[`packages/broapp-autoapp/NOTICE.md`](../../packages/broapp-autoapp/NOTICE.md),
which ships with the package; this repository's own licence (MIT) is unchanged.
