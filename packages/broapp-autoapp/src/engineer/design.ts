/**
 * How to design a page the renderer can actually draw.
 *
 * The engineer decides what a page is made of and every word on it, and until
 * now nothing told it how to decide well. It knew the rules of `views.ts` (the
 * `views` topic) and the tokens (the `theme` topic); it had never been told that
 * a table's `emptyText` teaches, that a form's fields group in fours, that a
 * button's label is a verb and a noun, that an error says what happened and
 * what to do, or that the accent is for actions and state and nothing else.
 *
 * Those are the parts of a design practice a *declarative* renderer with six
 * kinds can act on, and the table below is deliberately only those parts. An
 * instruction the engineer cannot follow is worse than none: there is no layout
 * freedom here, no type pairing, no timing curve, so none of that is in the
 * topic. The test holds every rule to a kind or a property the types declare,
 * which is what keeps the line honest as the renderer grows.
 *
 * Generated from the table the way the `theme` topic is generated from the
 * token table, so the text a person reads and the rules a test checks are the
 * same thing.
 *
 * ---
 *
 * Portions of the text in `DESIGN_RULES` and `DESIGN_CHECK` are distilled from
 * the Impeccable design skill by Paul Bakaus, licensed under the Apache License,
 * Version 2.0 — <https://github.com/paulbakaus/impeccable>. The text was
 * rewritten for a declarative renderer: every line names one of six component
 * kinds or a property of the view specification, and the skill's brand
 * register, layout, typography and timing material is not carried over. See
 * `packages/broapp-autoapp/NOTICE.md` and `docs/autoapp/design-guidance.md`.
 */

/** Which part of the topic a rule belongs to. */
export type DesignSection = 'page' | 'structure' | 'states' | 'copy' | 'colour' | 'check';

/** A component kind, or the page itself. */
export type DesignSubject = 'section' | 'text' | 'table' | 'form' | 'button' | 'status' | 'page';

/** One line of the topic, and what it is about. */
export interface DesignRule {
  readonly section: DesignSection;
  /** One sentence, imperative, naming a kind or a property. */
  readonly rule: string;
  readonly kinds: readonly DesignSubject[];
  /** Property names declared in `views/types.ts`. */
  readonly properties?: readonly string[];
}

export const DESIGN_RULES: readonly DesignRule[] = [
  // What a good page is. The product slop test, rewritten for six kinds: the
  // failure mode here is not flatness, it is strangeness without a reason.
  {
    section: 'page',
    rule: 'A person fluent in the tools they already use should sit down at a `page` and trust it. Earned familiarity is the goal; the application disappears into the task.',
    kinds: ['page'],
  },
  {
    section: 'page',
    rule: 'The failure to avoid is strangeness with no purpose: an invented word for a standard thing, a `button` unlike every other `button`, a `table` that behaves unlike the one on the page before.',
    kinds: ['button', 'table'],
  },
  {
    section: 'page',
    rule: '`section`, `text`, `table`, `form`, `button` and `status` are the whole vocabulary. When a request needs something else, say which kind comes closest and that the rest is a decision for the framework.',
    kinds: ['section', 'text', 'table', 'form', 'button', 'status'],
  },
  {
    section: 'page',
    rule: 'Consistency is an affordance: the same act on two pages carries the same `label` and the same `confirmText`, and a person who learned it once does not learn it again.',
    kinds: ['button', 'form'],
    properties: ['label', 'confirmText'],
  },

  // Structure. Ordering and grouping are the only layout decisions this
  // specification can express, so they are the only ones here.
  {
    section: 'structure',
    rule: 'One primary act per `page`: the `button` or the `form` `submit` the person came for, with nothing competing for the same attention.',
    kinds: ['page', 'button', 'form'],
    properties: ['submit'],
  },
  {
    section: 'structure',
    rule: "Put the thing the person came for first in a page's `children`. A `text` or a `status` that only sets context goes after it.",
    kinds: ['page', 'text', 'status'],
    properties: ['children'],
  },
  {
    section: 'structure',
    rule: 'At most five entries at the top of `children` before a `section` is due. Past five, nobody sees the hierarchy.',
    kinds: ['page', 'section'],
    properties: ['children'],
  },
  {
    section: 'structure',
    rule: 'A `form` shows at most four `fields` before a `section` breaks the rest out: four is what a person holds at once.',
    kinds: ['form', 'section'],
    properties: ['fields'],
  },
  {
    section: 'structure',
    rule: 'A `section` with one child is not a grouping. Drop it and let the child stand.',
    kinds: ['section'],
    properties: ['children'],
  },
  {
    section: 'structure',
    rule: 'Disclose progressively: a second page reached with `then` beats one page carrying everything somebody might want.',
    kinds: ['button', 'form'],
    properties: ['then'],
  },
  {
    section: 'structure',
    rule: 'Never ask a person to carry a value from one page to the next in their head. Carry it in the page `params` and read it as `$param`.',
    kinds: ['page'],
    properties: ['params'],
  },
  {
    section: 'structure',
    rule: "A `table`'s `columns` are the ones somebody decides by; one nobody reads is noise. `width` says which of them matter.",
    kinds: ['table'],
    properties: ['columns', 'width'],
  },

  // Every state. Half of these the renderer already draws; the other half only
  // the application can say, and saying nothing leaves a dead page.
  {
    section: 'states',
    rule: 'The renderer draws hover, focus-visible and disabled for every `button`, every field and every link. Do not ask for them, and do not ask for them to be taken away.',
    kinds: ['button', 'form'],
  },
  {
    section: 'states',
    rule: "The renderer draws a page's wait while its `sources` load, and a message when one of them fails. What it cannot invent is the words.",
    kinds: ['page'],
    properties: ['sources'],
  },
  {
    section: 'states',
    rule: 'Every `table` needs an `emptyText` that teaches: what belongs here, and how the first row comes to exist. Never "No items".',
    kinds: ['table'],
    properties: ['emptyText'],
  },
  {
    section: 'states',
    rule: 'A `button` or a `rowActions` entry that changes something needs a `confirmText` naming the thing and the consequence: "Delete ‘Release notes’? This cannot be undone."',
    kinds: ['button', 'table'],
    properties: ['confirmText', 'rowActions'],
  },
  {
    section: 'states',
    rule: 'Anything a person waits on or has to trust gets a `status` with its `source` and `path`, so the page says where it stands instead of looking finished.',
    kinds: ['status'],
    properties: ['source', 'path'],
  },
  {
    section: 'states',
    rule: 'A `form` that changed something lists every source it invalidated in `refresh`, so the page agrees with itself the moment the person looks back at it.',
    kinds: ['form'],
    properties: ['refresh'],
  },
  {
    section: 'states',
    rule: "A `field` declares `required`, `min` and `max` rather than explaining them in its `label`: the renderer enforces and reports what is declared, and nothing else.",
    kinds: ['form'],
    properties: ['required', 'min', 'max', 'label'],
  },
  {
    section: 'states',
    rule: '`hidden: true` is for a component kept in the specification on purpose. It is not where an unfinished component is parked.',
    kinds: ['section', 'text', 'table', 'form', 'button', 'status'],
    properties: ['hidden'],
  },

  // Copy. Every word on the page is the engineer's, which makes this the
  // section with the most to go wrong.
  {
    section: 'copy',
    rule: 'An act’s `label` is a verb and a noun ("Add item", "Save changes"), never "OK", "Submit" or "Go".',
    kinds: ['button', 'form', 'table'],
    properties: ['label'],
  },
  {
    section: 'copy',
    rule: "A `field`’s `label` is the noun the person uses, not the column name the schema uses.",
    kinds: ['form'],
    properties: ['label'],
  },
  {
    section: 'copy',
    rule: "A page’s `title` is what the person calls the screen. It is the heading and the name in navigation both, so it has to read as each.",
    kinds: ['page'],
    properties: ['title'],
  },
  {
    section: 'copy',
    rule: 'A `text` `template` beside a heading has to add something. Restating a `title` or a `label` costs a line and says nothing.',
    kinds: ['text'],
    properties: ['template', 'title', 'label'],
  },
  {
    section: 'copy',
    rule: 'What a person reads when something failed says what happened and what to do next. Write each operation’s summary the same way: the gate shows it when it asks.',
    kinds: ['button', 'form'],
  },
  {
    section: 'copy',
    rule: 'A `text` above a `form` answers "why are you asking", not "this is the name field".',
    kinds: ['text', 'form'],
    properties: ['template'],
  },
  {
    section: 'copy',
    rule: 'A `status` with `format` `datetime` says when, not whether. A true-or-false state reads better as a word in a `text` than as a bare boolean.',
    kinds: ['status', 'text'],
    properties: ['format'],
  },
  {
    section: 'copy',
    rule: 'One word per thing, across every `title`, `label`, `header` and `emptyText` on every page. Variety here reads as two different features.',
    kinds: ['page', 'table', 'form', 'button'],
    properties: ['title', 'label', 'header', 'emptyText'],
  },
  {
    section: 'copy',
    rule: 'No em dashes in anything a person reads: not in a `title`, a `label`, a `template`, an `emptyText` or a `confirmText`. Commas, colons, semicolons, periods and parentheses do the work.',
    kinds: ['page', 'text', 'table', 'form', 'button', 'status'],
    properties: ['title', 'label', 'template', 'emptyText', 'confirmText'],
  },
  {
    section: 'copy',
    rule: 'When `PRODUCT.md` is in the workspace, its audience and its tone decide every word above. Read it with `source.read` before writing any of them.',
    kinds: ['page'],
  },

  // Colour. The engineer sets tokens; it never writes a colour into copy. The
  // `theme` topic is the long version, and this is what it must not get wrong.
  {
    section: 'colour',
    rule: 'A `button`, a `table`, a `status` and a `form` take every colour from a token. Colour is decided in `src/ui/styles.css` and nowhere else; the `theme` topic has its rules.',
    kinds: ['button', 'table', 'status', 'form'],
  },
  {
    section: 'colour',
    rule: 'The palette is restrained: tinted neutrals, and the accent on acts and on state only (a `button` that does something, a selected row, a `status` that warns). Decoration gets none of it.',
    kinds: ['button', 'table', 'status'],
  },
  {
    section: 'colour',
    rule: 'Keep the accent under about a tenth of what a person sees on a `page`. It works because it is rare.',
    kinds: ['page'],
  },
  {
    section: 'colour',
    rule: 'No pure black and no pure white in a palette, and no grey with no tint in it: all three read as a value nobody chose.',
    kinds: ['page'],
  },
  {
    section: 'colour',
    rule: 'Text needs 4.5:1 against what is behind it and a control needs 3:1, placeholder text included. When `DESIGN.md` is in the workspace, the `theme` topic’s role mapping turns it into tokens.',
    kinds: ['page', 'text', 'form'],
  },
];

/**
 * The eight questions to answer about the views before asking a person to look.
 *
 * Each is a yes or a no about the specification as written, not a judgement
 * about a rendered page: the engineer cannot see the page, and a check it
 * cannot carry out is a check it will invent an answer to.
 */
export const DESIGN_CHECK: readonly string[] = [
  'Single focus: does the page have exactly one primary act, with nothing competing for it?',
  "Chunking: is every `form`'s `fields` list, and every `section`'s `children` list, four or fewer?",
  'Grouping: is everything that belongs together inside one `section`?',
  'Hierarchy: does the first entry in `children` answer why the person opened the page?',
  'One thing at a time: can the person finish one decision before the next is put to them?',
  'Minimal choices: are four or fewer `button` and `rowActions` labels in front of the person at once?',
  "Working memory: does every value the page needs arrive in `params` or a `source`, rather than in the person's head?",
  'Progressive disclosure: is what is not needed now behind a `then` or a later page?',
];

/** The heading each section is rendered under, in the order they are rendered. */
const SECTION_TITLES: ReadonlyArray<readonly [DesignSection, string]> = [
  ['page', 'What a good page is'],
  ['structure', 'Structure'],
  ['states', 'Every state'],
  ['copy', 'Copy'],
  ['colour', 'Colour and contrast'],
  ['check', 'Before you ask the person to look'],
];

/**
 * The `design` topic, built from the table rather than written beside it.
 *
 * Written by hand it would be a second list to keep in step with the types, and
 * the one that fell behind would be the one the engineer read.
 */
export function designTopic(): string {
  const blocks = SECTION_TITLES.filter(([section]) => section !== 'check').map(([section, title]) => {
    const lines = DESIGN_RULES.filter((rule) => rule.section === section).map((rule) => `- ${rule.rule}`);
    return `## ${title}\n${lines.join('\n')}`;
  });

  const check = `## Before you ask the person to look

Answer these eight about the views you just wrote. Count the ones that fail.

${DESIGN_CHECK.map((item, index) => `${String(index + 1)}. ${item}`).join('\n')}

Say the count, and name the items that failed, in the same message that asks the
person to open the preview. Nothing scores this for you and nothing blocks on it:
it is there so the person knows what you already know.`;

  return `# design — what a good page is, and how to check it

The \`views\` topic is what the specification will accept. This is what to do with
it. Every line names a kind or a property you can set, because a rule you cannot
act on is worse than no rule: there is no freedom here over position, type or
timing, and none of this asks for any.

${blocks.join('\n\n')}

${check}`;
}
