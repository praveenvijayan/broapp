# 04 — The view specification and the pinned renderer

## Goal

The browser never runs generated JavaScript. It runs one pinned React
renderer over a declarative view specification that is part of the
release. After this prompt: the view specification is defined and
validated; `broapp-autoapp/react` renders it with the existing Broapp hooks;
per-user overrides are stored on the host under a reserved `autoapp` route
group; the Notes example's main interface is the renderer over a Notes view
specification, with the existing AI chat and connection badge beside it.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `packages/broapp-autoapp/src/spec/*` from prompt 03.
- `packages/broapp/src/react/hooks.tsx`, completely: `BroappProvider`, `useOperation`, `useStream`, `useConnection`.
- `packages/broapp/src/ai/react/AiChat.tsx`, `AiSettings.tsx`, `provider.tsx`, `ai.css` — the pattern for a shipped component and its stylesheet.
- `packages/broapp/src/ai/shared/contract.ts` and `packages/broapp/src/ai/host/create-ai.ts` — how a reserved-group contract is mounted as a second host app.
- `packages/broapp/src/shared/contract.ts` — `RESERVED_GROUPS`, `assertNoReservedRoutes`, `mergeContracts`.
- `examples/notes/src/ui/*.tsx`, `styles.css`, `src/host/operations.ts`, `src/host/main.ts`.
- `packages/broapp/src/cli/build-page.ts` — confirm that a stylesheet imported from the UI entry is inlined and hashed (search `style`), so the renderer's CSS can be a plain `.css` import.

## Step 1 — reserve the group

`packages/broapp/src/shared/contract.ts`: `RESERVED_GROUPS` becomes
`['ai', 'autoapp']`. Update the error message so it says "reserved for
Broapp" rather than naming the AI layer. Update the one test in
`tests/contract.test.ts` or `tests/ai-contract.test.ts` that asserts the
message, if any, and say which in the report. This is the only core change
in this prompt.

## Step 2 — the view specification

`packages/broapp-autoapp/src/views/types.ts`. Flat records with a `kind`
discriminant; optional fields per kind. Everything is JSON. No expressions,
no HTML, no URLs to external resources.

```ts
export const VIEWS_VERSION = 1 as const;

/** Path into a JSON value: dot-separated keys and numeric indexes. `notes.0.title`. */
export type Path = string;

export interface ViewsSpec {
  readonly specVersion: typeof VIEWS_VERSION;
  readonly pages: readonly Page[];
  /** Page id shown first. */
  readonly home: string;
}

export interface Page {
  readonly id: string;             // [a-z][a-z0-9-]*, unique across pages
  readonly title: string;
  /** Route parameters the page takes, from the URL hash `#/<pageId>/<param>/...`, in order. */
  readonly params?: readonly string[];
  /** Operations loaded when the page opens, in order. */
  readonly sources?: readonly Source[];
  readonly children: readonly Component[];
}

export interface Source {
  readonly id: string;             // unique within the page
  readonly operation: string;      // a route in the contract with effect 'read'
  /** Literal input, where a string value of the form `$param.<name>` is replaced by the page parameter. */
  readonly input?: unknown;
}

/**
 * One component. `id` is stable across releases; overrides key on it. The
 * engineer must keep ids when it edits a view, and it is told so.
 */
export interface Component {
  readonly id: string;
  readonly kind: 'section' | 'text' | 'table' | 'form' | 'button' | 'status';
  readonly label?: string;
  readonly hidden?: boolean;

  // section
  readonly children?: readonly Component[];

  // text: `template` may contain `{{sourceId.path}}` placeholders, nothing else
  readonly template?: string;

  // table
  readonly source?: string;        // source id (table, status)
  readonly rows?: Path;            // path to the array inside the source's output
  readonly columns?: readonly Column[];
  readonly rowActions?: readonly Action[];
  readonly emptyText?: string;

  // form
  readonly fields?: readonly Field[];
  readonly submit?: Action;

  // button
  readonly action?: Action;

  // status
  readonly path?: Path;
  readonly format?: 'text' | 'number' | 'boolean' | 'datetime';
}

export interface Column {
  readonly id: string;
  readonly header: string;
  readonly path: Path;
  readonly format?: 'text' | 'number' | 'boolean' | 'datetime';
  readonly width?: 'narrow' | 'normal' | 'wide';
  /** Clicking the cell navigates to this page, with params drawn from the row by path. */
  readonly link?: { readonly page: string; readonly params: readonly Path[] };
}

export interface Field {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'textarea' | 'number' | 'boolean';
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Initial value: literal, or `$param.<name>`, or `$source.<sourceId>.<path>`. */
  readonly initial?: unknown;
}

export interface Action {
  readonly id: string;
  readonly label: string;
  readonly operation: string;      // any route; effect decides confirmation
  /**
   * How to build the operation's input. Keys are input fields. Values are
   * literals, or strings `$param.<name>`, `$field.<fieldId>` (forms),
   * `$row.<path>` (row actions), `$source.<sourceId>.<path>`.
   */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Ask before running, with this text. Required when the operation's effect is not 'read'. */
  readonly confirmText?: string;
  /** Source ids to reload after success. */
  readonly refresh?: readonly string[];
  /** Navigate after success. */
  readonly then?: { readonly page: string; readonly params?: readonly string[] };
}
```

`packages/broapp-autoapp/src/views/validate.ts`: `parseViews(raw): ViewsSpec`
with `s` schemas, plus structural rules: unique page ids; unique component
ids across the whole spec; unique source ids within a page; every `source`
reference resolves; every `link.page` and `then.page` resolves and receives
the right number of params; a `text` has `template`, a `table` has `source`,
`rows`, `columns`; a `form` has `fields` and `submit`; a `button` has
`action`; a `status` has `source` and `path`; templates contain only
`{{sourceId.path}}` placeholders (regex `\{\{[a-z][a-z0-9-]*(\.[A-Za-z0-9_]+)*\}\}`).

`packages/broapp-autoapp/src/views/check.ts`: `checkViewsAgainstContract(views, contract: ContractExport): readonly string[]`
— returns problems, empty when fine: every `Source.operation` exists and has
effect `read`; every `Action.operation` exists; an action on a non-`read`
operation has `confirmText`; every literal `Action.input` key is a property
of the operation's input JSON Schema (top-level only). Used by the spec
store: prompt 03's `writeRelease` gains a call to this and refuses a release
with problems. Update `spec/validate.ts` so `AppSpec.views` is `ViewsSpec`
and `parseSpec` calls `parseViews`; keep the `{ specVersion, pages }`
placeholder type deleted.

## Step 3 — overrides

`packages/broapp-autoapp/src/views/overrides.ts`:

```ts
export interface Override {
  readonly componentId: string;
  readonly label?: string;
  readonly hidden?: boolean;
  /** Column id → header text, for tables. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Column ids in the order to show them; missing ids keep their place after these. */
  readonly columnOrder?: readonly string[];
}

export interface Overrides {
  readonly version: 1;
  readonly items: readonly Override[];
}

export interface Conflict {
  readonly componentId: string;
  readonly reason: string;   // 'component no longer exists' | 'column <id> no longer exists'
}

export function applyOverrides(views: ViewsSpec, overrides: Overrides): { views: ViewsSpec; conflicts: readonly Conflict[] };
```

Overrides that cannot apply are reported, not dropped: the host keeps them
and the renderer shows a one-line notice per conflict.

## Step 4 — the `autoapp` host routes

`packages/broapp-autoapp/src/shared/contract.ts` exports `autoappContract`:

| Route | effect | input | output |
|---|---|---|---|
| `autoapp.overridesGet` | read | void | `Overrides` |
| `autoapp.overridesSet` | write | `Overrides` | `{ ok: true }` |
| `autoapp.viewsGet` | read | void | `{ views: ViewsSpec; conflicts: Conflict[] }` — the release's views with overrides applied |

`packages/broapp-autoapp/src/host/views.ts` exports
`createViewsHost({ dataDir, views, logger }): { mount(bridge), views }`
built on `createReservedHostApp(autoappContract)`. Overrides live at
`<dataDir>/autoapp/overrides.json`, written atomically. Add `"./host"` and
`"./shared"` exports to the package. `./shared` must import nothing from
`./host` (the browser bundles it); add a test that a browser build importing
`broapp-autoapp/shared` does not pull `bun:sqlite` or `node:fs`, modelled on
`tests/build.test.ts`'s host-import test.

## Step 5 — the renderer

`packages/broapp-autoapp/src/react/`:

```
index.tsx        exports AutoappView, useViews, autoappContract re-export
AutoappView.tsx  <AutoappView /> — loads views via autoapp.viewsGet, routes by hash, renders pages
Page.tsx         loads sources, provides them to children
components/      Section.tsx Text.tsx Table.tsx Form.tsx Button.tsx Status.tsx
bind.ts          resolve `$param`, `$field`, `$row`, `$source` references; read a Path
format.ts        the four formats
view.css         plain CSS, prefixed `.autoapp-`
```

Rules:

- Use `useBroapp()` / `useOperation` from `broapp/react` for every call.
  No `fetch`. No `dangerouslySetInnerHTML`. Text is always rendered as
  text.
- Routing is the URL hash: `#/<pageId>` or `#/<pageId>/<p1>/<p2>`. Unknown
  page shows a not-found section with a link to `home`.
- Sources load in order on page open and reload when named in
  `Action.refresh`. A source error shows inline under the component that
  uses it, using the `BroappError` message.
- An `Action` whose operation's effect is not `read` shows a native
  `window.confirm` with `confirmText` before calling. This is the user's
  own click and goes through the bridge as channel `user`; the gate allows
  it. The confirm is for the person, not for the policy.
- Forms validate `required`, `min`, `max` client-side and show the host's
  `invalid_input` message on submit failure.
- Every component renders `data-autoapp-id={component.id}` so tests and
  the engineer's preview can find it.
- Conflicts from `viewsGet` render once at the top as a list.

Add `"./react": "./src/react/index.tsx"` and `"./react/view.css"` to the
package `exports`.

## Step 6 — Notes on the renderer

`examples/notes/src/shared/views.ts` exports `notesViews: ViewsSpec`:

- Page `notes` (home): source `all` = `notes.list` with `{}`; a `form`
  `new-note` with fields `title` (text, required, max 200) and `body`
  (textarea, max 20000), submit `notes.create` with `$field` bindings,
  refresh `all`; a `table` `notes-table` over `all`, rows `notes`, columns
  `title` (link to page `note` with param `id`), `done` (boolean),
  `updatedAt` (datetime); row action `remove` → `notes.remove` with
  `{ id: '$row.id' }`, confirm text "Delete this note?", refresh `all`.
- Page `note` with param `id`: source `one` = `notes.list` with `{}` is
  **not** acceptable; the contract has no `notes.get`. Add `notes.get`
  (`read`, input `{ id }`, output `note`, `not_found` when missing) to the
  Notes contract, `operations.ts` and `db.ts`, and to `ai.ts`'s `read`
  list. Then: source `one` = `notes.get` with `{ id: '$param.id' }`; a
  `form` `edit` with fields `title`, `body`, `done` initialised from
  `$source.one.<field>`, submit `notes.update` with `{ id: '$param.id', ...$field }`,
  refresh `one`; a `button` `back` navigating to `notes` (an action with
  operation `notes.status`, effect read, and `then: { page: 'notes' }` —
  and record in the report that a pure-navigation action is missing from
  the spec and belongs in prompt 10's backlog).
- Page `status`: source `st` = `notes.status`; `status` components for
  `databasePath`, `schemaVersion`, `noteCount`, `healthy`; a `button`
  `backup` → `notes.backup`, confirm text "Write a backup beside the database?".

`examples/notes/src/ui/App.tsx`: the main column becomes `<AutoappView />`;
keep `ConnectionBadge`, `AiSettings`, `AiChat` where they are. Delete
`NoteEditor.tsx` and `StatusPanel.tsx` if nothing uses them. Pass
`notesViews` to `createViewsHost` in `main.ts` and mount it beside `app`
and `ai`. The `BroappProvider` gets `extensions={[aiContract, autoappContract]}`.

The Notes `AiChat` `refs` prop used the editor's current id; derive it from
the hash instead (`#/note/<id>` → `note:<id>`).

## Step 7 — tests

`tests/autoapp-views.test.ts`:

1. `parseViews(notesViews)` succeeds; each structural rule in Step 2 has a failing case.
2. `checkViewsAgainstContract(notesViews, exportContract(notesContract))` is empty; a source on a `write` route, an action on a `write` route without `confirmText`, and an unknown input key each produce one problem.
3. `applyOverrides`: label and hidden apply; a header for a missing column is a conflict; an override for a missing component is a conflict; the returned views are a new object and the input is untouched.
4. `bind.ts`: every reference form resolves; an unknown reference throws a `TypeError` naming it; a `Path` into an array works.
5. Over the harness with `createViewsHost`: `viewsGet` returns the views; `overridesSet` then `viewsGet` returns them applied; `overridesSet` from channel `ai` via `invoke` without an approver is rejected (it is a `write`).
6. Browser-bundle boundary: `broapp-autoapp/shared` and `broapp-autoapp/react` bundle for the browser without `node:` or `bun:` imports.

`examples/notes/tests/views.test.ts`: renders `<AutoappView />` with
`@testing-library/react` **only if it is already a workspace dependency**;
otherwise render with `react-dom/server`'s `renderToString` against a
stubbed provider and assert the `data-autoapp-id` attributes for
`new-note`, `notes-table` and `backup` appear. Do not add a test library.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-views.test.ts
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run check
```

Then run Notes by hand: `cd examples/notes && bun run dev`. Create a note,
open it, edit it, mark done, delete one, open `#/status`, take a backup.
Confirm the delete asked first. Record what you saw.

## Acceptance criteria

- Notes' main interface is the renderer; no Notes-specific React component makes a bridge call any more.
- No `dangerouslySetInnerHTML`, `eval`, `new Function`, or `<script>` string in `packages/broapp-autoapp/src/react`. `grep -rn` proves it; paste the empty result.
- A view specification that names a route missing from the contract cannot enter a release.
- Overrides survive a release that removes their target and are reported, not lost.

## Report

`prompts/autoapp/reports/04-views.md`. Include the manual run notes.

## Commit

```
Add the view specification and the pinned renderer

A release carries a declarative view specification: pages, sources,
tables, forms, buttons and status, bound to contract operations by
name. One pinned React renderer draws it over the ordinary Broapp hooks,
so no generated code ever runs in the browser. Per-user overrides live
on the host under the reserved autoapp group. Notes runs on it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
