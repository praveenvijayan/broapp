/**
 * The theme contract: every `--autoapp-*` custom property the renderer reads.
 *
 * An application owns its appearance by setting these on `:root`. Until this
 * table existed the list lived only in a stylesheet, the rule for which setting
 * wins lived in a comment, and the engineer was told neither. Now this is the
 * one place a token is declared: `tokens.css` is generated from it by
 * `scripts/build-tokens.ts`, the engineer's `theme` reference topic is built
 * from it when the module loads, and `tests/autoapp-theme.test.ts` holds
 * `view.css`, the starter and the presets to it.
 *
 * Every default is the value the renderer used before the table existed, to
 * the pixel. Where `view.css` used two values for what is arguably one idea —
 * the padding of a card and of a code block, say — there are two tokens rather
 * than one changed pixel, because an application that upgrades should look
 * exactly as it did.
 *
 * Pure data and one string function: the reference imports this on the host,
 * and it must not pull React or the DOM along with it.
 */

/** What kind of thing a token sets. */
export type TokenGroup = 'colour' | 'space' | 'type' | 'radius' | 'density';

/** The renderer's parts, as a person would name them, for the reference. */
export type TokenConsumer =
  | 'page'
  | 'section'
  | 'text'
  | 'link'
  | 'table'
  | 'form'
  | 'button'
  | 'status'
  | 'message'
  | 'notice'
  | 'approvals'
  | 'runs';

export interface ThemeToken {
  /** The property without its prefix: `accent`, `space-2`. */
  readonly name: string;
  readonly group: TokenGroup;
  /** One sentence. */
  readonly purpose: string;
  /** The default in the light scheme. */
  readonly light: string;
  /** The default in the dark scheme; equal to `light` for everything but colours. */
  readonly dark: string;
  /** What reads it. */
  readonly consumers: readonly TokenConsumer[];
}

export const TOKEN_PREFIX = '--autoapp-';

/** A token that is the same in both schemes. */
function same(
  name: string,
  group: Exclude<TokenGroup, 'colour'>,
  value: string,
  purpose: string,
  consumers: readonly TokenConsumer[],
): ThemeToken {
  return { name, group, purpose, light: value, dark: value, consumers };
}

function colour(
  name: string,
  light: string,
  dark: string,
  purpose: string,
  consumers: readonly TokenConsumer[],
): ThemeToken {
  return { name, group: 'colour', purpose, light, dark, consumers };
}

export const AUTOAPP_TOKENS: readonly ThemeToken[] = [
  // Colours: exactly the two blocks `view.css` carried before this table.
  colour('heading', '#16181d', '#f2f3f5', 'The colour of every heading: a page title and the title of a section, table or form.', ['page', 'section', 'table', 'form']),
  colour('text', '#33383f', '#e6e8ec', 'Body text, field labels, and what an approval is asking.', ['text', 'form', 'approvals']),
  colour('text-muted', '#6b6862', '#a2a7b0', 'The countdown on an approval that is waiting.', ['approvals']),
  colour('muted', '#6b7280', '#a2a7b0', 'Secondary text: column headers, a table with no rows, a status label, a path in a workflow draft.', ['table', 'status', 'runs']),
  colour('border', '#dfe3ea', '#3a3e46', 'Every border and divider: cards, cells, fields, buttons, status rows, run steps.', ['section', 'table', 'form', 'button', 'status', 'runs']),
  colour('surface', '#ffffff', '#1e2024', 'The ground of a card: a section, a table or a form.', ['section', 'table', 'form']),
  colour('input', '#ffffff', '#16171a', 'The ground of a text field.', ['form']),
  colour('button', '#f4f5f8', '#262a30', 'The ground of a button.', ['button']),
  colour('button-hover', '#e9ebf1', '#30353c', 'The ground of a button under the pointer.', ['button']),
  colour('accent', '#2a5bd7', '#7aa2ff', 'Links, and the focus ring unless `focus-ring` says otherwise.', ['link']),
  colour('code-surface', '#f4f5f8', '#14151a', 'The ground of the arguments block on an approval.', ['approvals']),
  colour('notice-surface', '#fdf6e7', '#2a2618', 'The ground of a notice and of the approvals strip.', ['notice', 'approvals']),
  colour('notice-border', '#f0d9a8', '#5a4a1e', 'The border of a notice and of the approvals strip, and the divider between approvals.', ['notice', 'approvals']),
  colour('notice-text', '#6b5312', '#e8d59a', 'The text of a notice and the title of the approvals strip.', ['notice', 'approvals']),
  colour('warning', '#b4690e', '#e0b95a', 'An approval with under a minute left: its edge and its countdown.', ['approvals']),
  colour('warning-bg', '#fdf3e3', '#3a3012', 'The ground of an approval with under a minute left.', ['approvals']),
  colour('error-surface', '#fdecec', '#3a1c16', 'The ground of an error message.', ['message']),
  colour('error-text', '#a12222', '#f08a76', 'The text of an error message.', ['message']),
  // A reference rather than a colour, so an application that changes only its
  // accent keeps a focus ring that matches it, as it always had.
  colour('focus-ring', 'var(--autoapp-accent)', 'var(--autoapp-accent)', 'The outline of a field that has keyboard focus.', ['form']),

  // Spacing: the gaps and margins between things, one step per value `view.css` used.
  same('space-1', 'space', '0.25rem', 'Between the items of a notice, and above and below a line of a workflow draft.', ['notice', 'runs']),
  same('space-2', 'space', '0.3rem', 'Between a field label and its field.', ['form']),
  same('space-3', 'space', '0.4rem', 'Between the buttons of a table row, above and below a status row, and under an approval question.', ['table', 'status', 'approvals']),
  same('space-4', 'space', '0.5rem', 'Between buttons in a row, around a run step, and inside an approval.', ['button', 'approvals', 'runs']),
  same('space-5', 'space', '0.6rem', 'Between the path and the value of a line in a workflow draft.', ['runs']),
  same('space-6', 'space', '0.75rem', 'Between the parts of a card, and between two approvals.', ['section', 'table', 'form', 'approvals']),
  same('space-7', 'space', '1rem', 'Between a status label and its value.', ['status']),
  same('space-8', 'space', '1.25rem', 'Between the blocks of a page.', ['page']),
  same('card-padding-y', 'space', '1rem', 'Inside a card, above and below.', ['section', 'table', 'form', 'approvals']),
  same('card-padding-x', 'space', '1.1rem', 'Inside a card, left and right.', ['section', 'table', 'form', 'approvals']),
  same('inset-y', 'space', '0.5rem', 'Inside a field, a table cell and a code block, above and below.', ['form', 'table', 'approvals']),
  same('inset-x', 'space', '0.6rem', 'Inside a field, a table cell and a code block, left and right.', ['form', 'table', 'approvals']),
  same('message-padding-y', 'space', '0.5rem', 'Inside an error message, above and below.', ['message']),
  same('message-padding-x', 'space', '0.7rem', 'Inside an error message, left and right.', ['message']),
  same('notice-padding-y', 'space', '0.6rem', 'Inside a notice, above and below.', ['notice']),
  same('notice-padding-x', 'space', '0.9rem', 'Inside a notice, on the right.', ['notice']),
  same('list-indent', 'space', '1.6rem', 'Inside a notice, on the left, where its bullets sit.', ['notice']),
  same('label-width', 'space', '8rem', 'The narrowest the path column of a workflow draft may be.', ['runs']),

  // Type.
  same('font-size-base', 'type', '1em', "The renderer's text size, relative to the page's own; every other size is relative to the document's root.", ['page']),
  same('font-size-title', 'type', '1.35rem', 'A page title.', ['page']),
  same('font-size-heading', 'type', '1rem', 'The title of a section, a table, a form and the approvals strip.', ['section', 'table', 'form', 'approvals']),
  same('font-size-note', 'type', '0.9rem', 'Error messages, notices and run steps.', ['message', 'notice', 'runs']),
  same('font-size-small', 'type', '0.85rem', 'Field labels, small buttons, approval arguments and workflow paths.', ['form', 'button', 'approvals', 'runs']),
  same('font-size-caption', 'type', '0.8rem', 'Column headers.', ['table']),
  same('line-height', 'type', '1.55', 'The line height of a text block.', ['text']),

  // Corners.
  same('radius-sm', 'radius', '7px', 'The corners of fields, buttons, messages and code blocks.', ['form', 'button', 'message', 'approvals']),
  same('radius-md', 'radius', '8px', 'The corners of a notice.', ['notice']),
  same('radius-lg', 'radius', '10px', 'The corners of a card and of the approvals strip.', ['section', 'table', 'form', 'approvals']),

  // Density: how much room a control takes, and how heavy its lines are.
  same('control-height', 'density', 'auto', 'The least height of a field or a button; `auto` lets its padding decide.', ['form', 'button']),
  same('control-padding-y', 'density', '0.45rem', 'Inside a button, above and below.', ['button']),
  same('control-padding-x', 'density', '0.9rem', 'Inside a button, left and right.', ['button']),
  same('control-small-padding-y', 'density', '0.25rem', 'Inside a small button on a table row, above and below.', ['table']),
  same('control-small-padding-x', 'density', '0.55rem', 'Inside a small button on a table row, left and right.', ['table']),
  same('check-size', 'density', '1.05rem', 'The width and height of a checkbox.', ['form']),
  same('border-width', 'density', '1px', 'Every border and divider.', ['section', 'table', 'form', 'button', 'status', 'notice', 'approvals', 'runs']),
  same('accent-border-width', 'density', '3px', 'The edge that marks an approval with under a minute left.', ['approvals']),
  same('focus-ring-width', 'density', '2px', 'The width of the focus ring.', ['form']),
  same('focus-ring-offset', 'density', '1px', 'The gap between a focused field and its ring.', ['form']),
];

/**
 * What `view.css` writes as a token's fallback.
 *
 * The light default, except where that default names another token: the
 * fallback then names it too, with that token's own default, so a page that
 * somehow lost `tokens.css` still draws exactly what it drew before.
 */
export function fallbackFor(token: ThemeToken, tokens: readonly ThemeToken[] = AUTOAPP_TOKENS): string {
  const reference = /^var\(--autoapp-([a-z][a-z0-9-]*)\)$/.exec(token.light);
  if (reference === null) return token.light;
  const target = tokens.find((one) => one.name === reference[1]);
  if (target === undefined) throw new Error(`${token.name} refers to ${String(reference[1])}, which is not a token`);
  return `var(${TOKEN_PREFIX}${target.name}, ${fallbackFor(target, tokens)})`;
}

const GROUPS: readonly TokenGroup[] = ['colour', 'space', 'type', 'radius', 'density'];

function declarations(tokens: readonly ThemeToken[], pick: (token: ThemeToken) => string, indent: string): string {
  const lines: string[] = [];
  for (const group of GROUPS) {
    const members = tokens.filter((token) => token.group === group);
    if (members.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${indent}/* ${group} */`);
    for (const token of members) lines.push(`${indent}${TOKEN_PREFIX}${token.name}: ${pick(token)};`);
  }
  return lines.join('\n');
}

/** The stylesheet `scripts/build-tokens.ts` writes to `src/react/tokens.css`. */
export function tokensCss(tokens: readonly ThemeToken[] = AUTOAPP_TOKENS): string {
  // Only what differs goes under the media query: a length is the same in both
  // schemes, and repeating it would be one more place for the two to disagree.
  const dark = tokens.filter((token) => token.dark !== token.light);
  return `/*
 * Generated from AUTOAPP_TOKENS in src/react/theme.ts by \`bun run build:tokens\`.
 * Do not edit it; change the table and run the script again.
 * tests/autoapp-theme.test.ts fails when this file and the table disagree.
 *
 * The renderer's default for every \`--autoapp-*\` property, in both colour
 * schemes. \`:where(:root)\` has no specificity, so an application that sets any
 * of them on its own \`:root\` wins whatever order the stylesheets were bundled
 * in, and one that sets none still looks deliberate.
 */

:where(:root) {
${declarations(tokens, (token) => token.light, '  ')}
}

@media (prefers-color-scheme: dark) {
  :where(:root) {
${declarations(dark, (token) => token.dark, '    ')}
  }
}
`;
}
