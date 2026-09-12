# 12h — Design guidance the engineer can act on, and a detector that needs no model

## Goal

The Autoapp engineer decides what a page is made of and every word on it, and
nothing tells it how to decide well. It knows the rules of `views.ts` (the `views`
topic) and the theme (the `theme` topic); it has never been told that a table needs
an `emptyText` that teaches, that a form's fields group in fours, that a button's
label is a verb and a noun, that an error says what happened and what to do, or that
the accent is for actions and state and nothing else. Those are the parts of the
Impeccable design skill (Paul Bakaus, Apache 2.0, product register) that a
declarative renderer with six kinds can act on. The rest of that skill, layout
freedom, type pairing, motion, live mode, the brand register, cannot be acted on
here and must not be handed over: an instruction the engineer cannot follow is worse
than none.

Impeccable also ships a detector, 61 deterministic rules, no model. Run on the theme
gallery today it reports four contrast failures, white on `#8a8d93` at 3.3:1, that the
12g harness did not see because it measured one button and one select.

After this prompt: a `design` reference topic of about 120 lines, distilled from the
skill's product register and rewritten so every line names a kind or a property the
engineer can set; `PRODUCT.md` and `DESIGN.md` readable from a workspace and named in
the evidence when present, with a three-question `PRODUCT.md` in the starter; one
sentence in the instructions; the detector in the theme CI job, and the four findings
fixed; the framework authors' gate and the Broapp skill pointing at `critique`,
`audit` and `polish` for work on the renderer and the panel; attribution carried.

## Read first

- `prompts/autoapp/00-common-rules.md` (including "2b. Adding a component"), every
  report so far, 12f's and 12g's with care.
- The Impeccable skill at `~/.agents/skills/impeccable/`: `SKILL.md` (shared design
  laws, the AI slop test), `reference/product.md` (all of it), `reference/clarify.md`
  (error messages, labels, buttons, help text), `reference/cognitive-load.md` (the
  three loads, the eight-item checklist, the working-memory rule),
  `reference/harden.md` (extreme inputs, error scenarios, empty states),
  `reference/onboard.md` ("Empty State Design"), `reference/color-and-contrast.md`
  (WCAG table, the 60-30-10 rule, tinted neutrals), `reference/heuristics-scoring.md`
  (the ten heuristics and their 0–4 scales). The repository's `LICENSE` and
  `NOTICE.md` (Apache 2.0; the NOTICE names two platform references not used here).
- `packages/broapp-autoapp/src/engineer/reference.ts` (topics, the drift test's
  expectations), `instructions.ts` (70 lines, at the limit),
  `knowledge/path.ts` (`taskEvidence`, the constraints line), `workspace.ts`
  (`READABLE`, `WRITABLE`), `tools.ts` (`spec.reference`).
- `packages/broapp-autoapp/src/react/components/*.tsx` and `view.css` — which states
  each kind already draws (hover, focus-visible, disabled, empty table, error, notice),
  so the topic says what the renderer provides and what the application declares.
- `templates/autoapp-starter/` (`README.md`, `src/shared/views.ts`, the packing test in
  `tests/autoapp-create.test.ts`).
- `.github/workflows/ci.yml` (the `theme` job), `scripts/theme-gallery.ts`,
  `scripts/theme-check.ts`, `packages/broapp-autoapp/presets/*.css`.
- `skills/broapp/SKILL.md` (the Autoapp section).
- `docs/autoapp/components.md`, `docs/autoapp/design.md`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Two consumers, two deliveries | The engineer gets a reference topic it can act on. Framework authors, who write React and CSS, get the skill itself through the gate and the Broapp skill. Nothing from the skill's brand register, motion, typography-pairing, live or overdrive material reaches the engineer. |
| The `design` topic | Generated at module load from a table in `engineer/design.ts`, the way the `theme` topic is generated from the token table, so a test can hold it to the kinds: every rule names at least one kind (`section`, `text`, `table`, `form`, `button`, `status`) or one property from `views/types.ts`, and every kind appears at least once. Under 120 lines rendered. Sections, in order: *What a good Autoapp page is* (the product slop test, rewritten: the person fluent in Linear, Notion or Stripe sits down and trusts it; familiarity is the goal; the tool disappears into the task); *Structure* (one primary action per page, fields grouped in at most four, at most five top-level components on a page before a `section` is due, the thing the person came for first, progressive disclosure through pages and `then`, no working memory across pages: `$param` carries it); *Every state* (what the renderer draws for every kind — hover, focus, disabled, loading source, error from a route, the notice — and what the application must declare: `emptyText` that says what goes here and how, `confirmText` that names the thing and the consequence, a `status` for anything a person waits on); *Copy* (button labels verb plus noun, never "OK" or "Submit"; labels are nouns the person uses, not the schema's; an error output says what happened and what to do next; help text answers "why are you asking"; headings are not restated in text; no em dashes); *Colour and contrast* (the palette is Restrained: tinted neutrals, one accent at most a tenth of the surface, on actions and state only; no pure black or white; 4.5:1 for text, 3:1 for controls, placeholders included; this is the `theme` topic's job, so the engineer sets tokens, never colours in copy); *Before you ask the person to look* (the eight-item check, each item a yes/no about the views: single focus, chunking, grouping, hierarchy, one thing at a time, minimal choices, no working memory, progressive disclosure; count the failures; say the count and the failing items in the same message that asks the person to look). |
| What it must not say | Anything about fonts, motion, layout beyond ordering and grouping, OKLCH, cards, gradients, glass, modals, marketing pages. A test asserts the rendered topic contains none of: `font`, `animate`, `motion`, `oklch`, `gradient`, `glass`, `modal`, `hero`, `landing`. |
| Attribution | `docs/autoapp/design-guidance.md` states that the `design` topic is distilled from Impeccable by Paul Bakaus under Apache 2.0, links the repository, says which references it draws on, and says the text was rewritten for a declarative renderer. The package's `LICENSE` is unchanged (MIT for this repository); `packages/broapp-autoapp/NOTICE.md` is added carrying the Apache attribution and the statement of modification, and is listed in `files`. `design.ts` carries the same notice in its header comment. The Impeccable NOTICE's two platform references are not used and are not reproduced. |
| Product and design context | `READABLE` gains `PRODUCT.md` and `DESIGN.md` at the workspace root (not `WRITABLE`: the person owns them). `taskEvidence` adds a line naming each that exists, with its first line as a snippet, so the engineer knows to read it. The `design` topic's copy section says: when `PRODUCT.md` exists, its audience and tone decide every word; when `DESIGN.md` exists, the `theme` topic's style-guide mapping applies. |
| The starter's `PRODUCT.md` | Three questions and room for three answers: who uses this and when; what they come to do; what tone they expect (three or four words). Marker-free; the person writes it. The starter's `README.md` gains one paragraph. The packing test's list of expected files gains it. |
| The instructions | One sentence in step 2 replaced: *"Read a file's rules with `spec.reference`."* becomes *"Read a file's rules with `spec.reference`; for `views.ts`, the `design` topic too, and say its check's count when you ask the person to look."* The file stays at 70 lines; trim the sentence in step 3 about hunk sizes ("hunks under a kilobyte land, and ones over two kilobytes have been measured not to") to "hunks under a kilobyte land" to make the room. `INSTRUCTION_SECTIONS` unchanged. |
| The detector | `impeccable` pinned as a **root devDependency** (it is the skill's npm package, a CLI; it stays out of every published package and binary). `bun run design-detect` runs `impeccable detect --no-config --json` over `.broapp-tmp/theme-gallery.html` and the harness pages `scripts/theme-check.ts` builds, and fails on any primary finding. The theme CI job runs it after the gallery. Advisory findings are printed, never fail. A `.impeccable/` ignore file is allowed only with a comment naming the rule and the reason, and the report lists every ignore. |
| The four findings | Locate the white-on-`#8a8d93` text in the gallery (a preset's disabled or muted control, most likely `dense.css`), fix it in the preset or the token default so 4.5:1 holds, rerun the detector and the harness, and record before and after. If the failing text is decorative by the WCAG definition, say so and ignore the rule for that selector with the reason; do not lower the bar. |
| Framework authors | "2b. Adding a component" in `00-common-rules.md` gains: before the gallery step, run `/impeccable critique` and `/impeccable audit` on the gallery page and act on every finding scored below 3, and `/impeccable polish` on the component's file; the report carries the scores. `skills/broapp/SKILL.md`'s Autoapp section and its plain-application workflow gain a paragraph: for UI work in a Broapp application, use the Impeccable skill if it is installed, product register. |
| Not in scope | A design self-critique that calls the model (the engineer reads the topic and reports a count; nothing scores it); a `DESIGN.md` generator; motion or layout capabilities in the renderer; the `live` mode; any change to which kinds exist. |

## Step 1 — `engineer/design.ts` and the topic

```ts
export interface DesignRule {
  readonly section: 'page' | 'structure' | 'states' | 'copy' | 'colour' | 'check';
  readonly rule: string;              // one sentence, imperative, names a kind or a property
  readonly kinds: readonly ('section' | 'text' | 'table' | 'form' | 'button' | 'status' | 'page')[];
  readonly properties?: readonly string[];   // from views/types.ts: emptyText, confirmText, label, title, then, hidden, …
}
export const DESIGN_RULES: readonly DesignRule[];
export const DESIGN_CHECK: readonly string[];   // the eight yes/no items
export function designTopic(): string;          // what spec.reference serves for 'design'
```

`reference.ts`: `REFERENCE_TOPICS` gains `'design'`; the `views` topic's first paragraph
points at it in one sentence; the tool description lists it. The drift test extends:
every `kinds` entry is a real kind, every `properties` entry is declared in
`views/types.ts`, every kind is named by at least one rule, the banned words are absent,
the rendered topic is under 120 lines.

## Step 2 — context files and the starter

`workspace.ts`: `READABLE` gains `^(PRODUCT|DESIGN)\.md$`; `WRITABLE` does not.
`path.ts`: after the constraints line, `Context: PRODUCT.md (who: …) · DESIGN.md
(…)` with each file's first non-heading line cut at 80 characters, only for files that
exist. Starter: `PRODUCT.md`, README paragraph, packing test.

## Step 3 — the instructions

As decided; the line-count test holds.

## Step 4 — the detector, and the four findings

Root `package.json`: `impeccable` pinned; `"design-detect"` script. `ci.yml` theme job:
after `theme-gallery`, `bun run design-detect`. Then the findings, as decided.

## Step 5 — the gate, the skill, the docs

`00-common-rules.md`, `skills/broapp/SKILL.md`, `docs/autoapp/design-guidance.md`
(new: what the topic is, where it comes from, what was left out and why, the
attribution), `docs/autoapp/components.md` and `design.md` (one pointer each),
`packages/broapp-autoapp/NOTICE.md`, `files`.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-verify.test.ts tests/autoapp-engineer.test.ts tests/autoapp-create.test.ts
bun run --cwd packages/broapp-autoapp theme-gallery
bun run design-detect
bun run theme-check
bun test tests
bun run check
```

Tests, in `tests/autoapp-verify.test.ts` and `tests/autoapp-engineer.test.ts`:

1. Every rule names a real kind or a declared property; every kind is named at least
   once; the rendered topic is under 120 lines and contains none of the banned words.
2. `spec.reference` with `topic: 'design'` returns the topic; the `views` topic points
   at it; `all` contains it.
3. `source.read` of `PRODUCT.md` succeeds when the file exists and `source.edit` on it
   is refused; `taskEvidence` names it with its first line when present and not
   otherwise.
4. The starter packs with `PRODUCT.md`; `apps.create` writes it; it contains the three
   questions and no marker.
5. `ENGINEER_INSTRUCTIONS` is at most 70 lines and contains `design`; the five headings
   stand.
6. `design-detect` on the current gallery reports zero primary findings after the fix
   (the test runs the detector's JSON mode on the gallery file and asserts the count;
   `skipIf` the CLI is unavailable offline, and say so in the report if it was skipped).
7. `NOTICE.md` is in the package's `files` and names Impeccable, Paul Bakaus, Apache 2.0
   and the modification.

## Acceptance criteria

- The engineer can read, on demand, a design topic every line of which it can act on
  with the six kinds and their properties, and nothing it cannot.
- When a workspace carries `PRODUCT.md` or `DESIGN.md`, the engineer is told and can
  read them, and cannot write them.
- The instructions ask for the design check's count when the person is asked to look.
- The detector runs in CI over the gallery and the harness page, and the four contrast
  findings are gone or justified.
- Framework authors are told to run the skill's critique, audit and polish before the
  gallery step.
- Attribution is carried in the package and the docs.
- `bun run check` is green; every command above exits 0; the theme CI job is green.

## Report

`prompts/autoapp/reports/12h-design-guidance.md`. Include: the rendered `design`
topic in full; the rule count per section and the kinds each rule names; the four
findings with the element, the fix and the after value; the detector's findings on the
harness pages, primary and advisory; every ignore with its reason; the sentence that
was cut from the instructions; and whether the detector test ran or was skipped.

## Commit

```
Tell the engineer how to design a page it can actually draw

A design topic distilled from Impeccable's product register, rewritten so
every line names a kind or a property the engineer can set and held to the
kinds by a test; PRODUCT.md and DESIGN.md readable from a workspace and
named in the evidence; one sentence in the instructions asking for the
design check's count. Impeccable's detector runs in CI over the gallery and
the harness page, and its four contrast findings are fixed. Attribution
carried under Apache 2.0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
