/**
 * The rules of an application's specification, on demand.
 *
 * The validators in `spec/validate.ts` and `views/validate.ts` decide what a
 * build refuses, and they say so with a path and a sentence. What they cannot
 * say is what a property *means* once the renderer draws it — that a table's
 * `rows` is a path into a source's output, that an action on a `write` route
 * asks the person before it runs, that a page's `title` is both its heading
 * and its name in navigation. That meaning lived only in the renderer and in
 * type comments, and 12d recorded a failure whose cause was exactly a rule the
 * engineer had never been shown.
 *
 * This is that text, kept beside the code it describes and held to it by a
 * test: every component kind and every property name the types declare must
 * appear here. It is served by the `spec.reference` tool a section at a time,
 * so the engineer reads the part it needs rather than all of it every turn.
 */

import { AUTOAPP_TOKENS, TOKEN_PREFIX, type ThemeToken, type TokenGroup } from '../react/theme.ts';

export const REFERENCE_TOPICS = ['contract', 'views', 'acceptance', 'workspace', 'theme'] as const;
export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

const CONTRACT = `# contract — src/shared/contract.ts

Exports \`contract\`, built with \`defineContract\`. Every operation and stream is
a route named \`group.member\`, with:
- \`effect\`: \`read\` changes nothing; \`write\` changes data inside the application's
  data directory; \`external\` reaches outside it (network, other files, spawned
  processes). Required. The gate decides from it: a person's own click runs any
  effect; the engineer, an MCP client and a workflow are asked before \`write\` and
  \`external\`, and \`external\` is refused in a preview.
- \`summary\`: one sentence, required. Shown to the person when the gate asks.
- \`input\` and \`output\`: schemas from \`s\`. Input is validated before the handler
  runs; a bad input reaches the caller as \`invalid_input\` with the field's path.
A route a view or an acceptance example names must exist here; the build refuses
the specification otherwise, naming the route.`;

const VIEWS = `# views — src/shared/views.ts

Exports the view specification: \`specVersion\` (always 1), \`pages\`, and \`home\`,
the id of the page shown first. The pinned renderer draws it; there is no generated browser
code, so what is not expressible here cannot be drawn.

## Page
\`id\` (\`[a-z][a-z0-9-]*\`, unique), \`title\` (the page's heading and its name in
navigation, both), \`params\` (names taken from the URL hash, in order),
\`sources\` (operations loaded when the page opens, in order), \`children\`.
How a page looks — colour, spacing, type, corners — is not in this file: it is
the \`--autoapp-*\` tokens in \`src/ui/styles.css\`, listed in the \`theme\` topic.

## Source
\`id\` (unique on the page), \`operation\` (a route with effect \`read\`), \`input\`
(a literal; a string \`$param.<name>\` is replaced by the page parameter).

## Component — six kinds, all with \`id\` and \`kind\`; \`label\` and \`hidden\` optional
A component keeps its \`id\` for ever: a person's customisations are keyed on it,
and renaming one silently loses them. \`hidden: true\` keeps it in the specification
and out of the page.
- \`section\`: needs \`children\`. A grouping with an optional \`label\` heading.
- \`text\`: needs \`template\`, which may contain \`{{sourceId.path}}\` placeholders and
  nothing else (no expressions, no markup).
- \`table\`: needs \`source\`, \`rows\` (a path to the array inside that source's
  output) and at least one of \`columns\`. \`rowActions\` are actions run with the
  row in \`$row\`; \`emptyText\` is shown when there are no rows.
- \`form\`: needs at least one of \`fields\` and a \`submit\` action; fields reach the
  action's input as \`$field.<fieldId>\`.
- \`button\`: needs \`action\`.
- \`status\`: needs \`source\` and \`path\` (a value inside the source's output);
  \`format\` decides how it is shown.

## Column
\`id\`, \`header\`, \`path\` (into the row), optional \`format\` (\`text\`, \`number\`,
\`boolean\`, \`datetime\`), \`width\` (\`narrow\`, \`normal\`, \`wide\`), and \`link\`
(\`{ page, params }\`: clicking the cell opens that page with parameters drawn from
the row by path — the only navigation a table can express).

## Field
\`id\`, \`label\`, \`type\` (\`text\`, \`textarea\`, \`number\`, \`boolean\`), optional
\`required\`, \`min\`, \`max\`, and \`initial\` (a literal, \`$param.<name>\`, or
\`$source.<sourceId>.<path>\`).

## Action — on a button, a form's submit, or a table row
\`id\`, \`label\`, \`operation\` (any route), \`input\` (keys are the operation's input
fields; values are literals or the strings \`$param.<name>\`, \`$field.<fieldId>\`,
\`$row.<path>\`, \`$source.<sourceId>.<path>\`), \`confirmText\` (**required on a button
or a row action whose operation's effect is not \`read\`**: the person is asked
with these words before it runs, and the build refuses such an action without
it; a form's \`submit\` is exempt, because filling a form in is already a
deliberate act), \`refresh\` (source ids to reload after success), \`then\`
(\`{ page, params? }\`: navigate after success).
There is no action that only navigates: a button that should only move the
person calls a \`read\` route and uses \`then\`.`;

const ACCEPTANCE = `# acceptance — autoapp.json

\`acceptance\` is a list of examples: \`{ id, title, steps }\`. Every step is one of:
- A route step names a \`route\` and its \`input\`. The route is called on a preview
  of the candidate and must succeed. \`expect\`, when given, must deep-equal the
  output. \`match\`, when given, must be contained by it: every key it names
  matches, an array has the same length and matches element by element — for
  outputs with ids and timestamps an example cannot know. Proves the host.
- A view step carries a \`view\` with a \`page\` id and, optionally, a \`component\`
  id anywhere on that page. Judged against the candidate's view specification:
  the page or the component must be declared (\`exists\` defaults to true;
  \`false\` asserts it is not), and must contain \`match\` when given. Proves the
  specification: that a button is declared with this label and this operation,
  that a page has no children.
Neither kind renders a page. What a browser shows is verified only by a person
looking at the preview, and every check report says so. A good example fails on
the release before the change and passes on the candidate; write the one that
would.`;

const WORKSPACE = `# workspace — what may be changed, and how

\`autoapp.json\`: \`appId\`, \`name\`, \`schemaVersion\`, \`migrations\` (appended, never
edited; \`schemaVersion\` equals the version the last migration reaches),
\`capabilities\` (what host code asks to reach outside its data directory; a person
grants them per release), \`acceptance\`.
\`src/shared/contract.ts\`, \`src/shared/views.ts\`, \`src/host/app.ts\` (exports
\`start\` and \`migrate\`), \`src/ui/\`. Nothing outside \`src/\` and \`autoapp.json\` is
written. Dependencies come from \`package.json\` as installed at import; a new one
cannot be added by editing the file.
Prefer what the renderer already draws. A dependency the renderer would need is a
decision for the framework, made in \`packages/broapp-autoapp\`, never in an
application's \`package.json\`.`;

/** One line of the theme topic. */
function tokenLine(token: ThemeToken): string {
  const defaults = token.dark === token.light ? token.light : `${token.light} / ${token.dark}`;
  return `- \`${TOKEN_PREFIX}${token.name}\` — ${token.purpose} — ${defaults} — read by ${token.consumers.join(', ')}`;
}

const TOKEN_GROUPS: readonly TokenGroup[] = ['colour', 'space', 'type', 'radius', 'density'];

/**
 * The theme topic, built from the table rather than written beside it.
 *
 * Written by hand it would be one more list to keep in step with the
 * stylesheet, and the one that fell behind would be the one the engineer reads.
 */
function themeReference(tokens: readonly ThemeToken[]): string {
  const groups = TOKEN_GROUPS.map((group) => {
    const members = tokens.filter((token) => token.group === group);
    return members.length === 0 ? '' : `## ${group}\n${members.map(tokenLine).join('\n')}`;
  }).filter((text) => text !== '');
  return `# theme — src/ui/styles.css

The renderer draws every component itself and takes every colour, gap, size and
corner from an \`${TOKEN_PREFIX}*\` custom property. Setting those is how an application
looks like itself; a rule for an \`.autoapp-\` class is not supported.
The renderer's defaults sit on \`:where(:root)\`, which has no specificity. An
application sets tokens on \`:root\` in \`src/ui/styles.css\`, and that wins whatever
order the stylesheets were bundled in. The renderer never sets a token anywhere
else, so a token set on \`:root\` reaches every component. An application that sets
a colour for the light scheme sets it for the dark one too, under
\`@media (prefers-color-scheme: dark)\`; one that sets neither gets the defaults in both.
A preset is those two blocks and nothing else: \`broapp-autoapp/presets/quiet.css\`
(low contrast, roomier, rounder) and \`dense.css\` (compact, square, high contrast).
To use one, copy it to the end of \`src/ui/styles.css\`; it is bundled and hashed with
the page, and nothing changes the theme while the page runs.
Each line: the token — what it sets — its default (light / dark where they differ) — what reads it.

${groups.join('\n\n')}`;
}

const SECTIONS: Readonly<Record<ReferenceTopic, string>> = {
  contract: CONTRACT,
  views: VIEWS,
  acceptance: ACCEPTANCE,
  workspace: WORKSPACE,
  theme: themeReference(AUTOAPP_TOKENS),
};

/** One topic's text, or every topic in order. */
export function specReference(topic?: ReferenceTopic): string {
  if (topic !== undefined) return SECTIONS[topic];
  return REFERENCE_TOPICS.map((name) => SECTIONS[name]).join('\n\n');
}
