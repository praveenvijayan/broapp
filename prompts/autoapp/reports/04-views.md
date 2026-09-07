# 04 — The view specification and the pinned renderer

## What was built

- `packages/broapp/src/shared/contract.ts`: `RESERVED_GROUPS` is now
  `['ai', 'autoapp']` and the message says "reserved for Broapp". No test
  asserted the old wording — `tests/contract.test.ts` and `tests/ai-host.test.ts`
  match `/reserved/` — so no test changed. This is the only core change.
- `src/views/`: `types.ts`, `validate.ts` (`parseViews`), `check.ts`
  (`checkViewsAgainstContract`), `overrides.ts` (`applyOverrides`), `index.ts`.
- `src/shared/`: `autoappContract` with the three routes, and the barrel.
- `src/host/views.ts`: `createViewsHost`, overrides at
  `<dataDir>/autoapp/overrides.json`, written atomically.
- `src/react/`: `AutoappView`, `Page`, `context.tsx`, `bind.ts`, `format.ts`,
  `view.css`, and `components/{Section,Text,Table,Form,Button,Status}.tsx`.
- `spec/`: `AppSpec.views` is now `ViewsSpec`, `parseSpec` delegates to
  `parseViews`, and `writeRelease` refuses a release whose views disagree with
  its contract.
- Notes: `notes.get` added to the contract, `operations.ts` and `ai.ts`'s `read`
  list; `src/shared/views.ts` added; `App.tsx` reduced to a frame around
  `<AutoappView />`; `NoteEditor.tsx` and `StatusPanel.tsx` deleted.
- `tests/autoapp-views.test.ts` (29 tests) and
  `examples/notes/tests/views.test.ts` (5 tests).

## Deviations, and why

1. **`confirmText` is required for a `button` or a row action, not for a form's
   submit.** As written, the rule ("an action on a non-`read` operation has
   `confirmText`") makes the prompt's own Notes specification invalid: Step 6
   gives confirm text to `remove` and `backup` and to neither form. The rule
   exists to stop a *single click* from changing something; a form is already a
   deliberate act — somebody filled it in and pressed its button. So `check.ts`
   exempts `submit` and nothing else, and the Notes forms carry no confirm text.
2. **Component ids stay `[a-z][a-z0-9-]*`; column, field and action ids use
   `[A-Za-z_][A-Za-z0-9_-]*`.** A field's id *is* the operation input's property
   name, and a column's id names a contract field, so `updatedAt` and
   `schemaVersion` have to be spellable. Page, component and source ids stay
   narrow because those are the names a person sees — an override keys on a
   component id, and a template's placeholder grammar allows nothing else.
3. **`Envelope`-style additions to the renderer's inputs.** Two the prompt did
   not name, both forced by the Notes specification:
   - `resolveDeep`, because a source's `input` is an *object whose values* are
     references, not itself a reference. Resolving only the top level passed
     `"$param.id"` to the host verbatim.
   - `coerceToSchema`, because a page parameter comes out of a URL as text and
     `notes.get` takes a number. The operation's own input JSON Schema decides,
     rather than the renderer guessing from the string — which would turn an id
     of `"007"` into `7`.
4. **`AutoappView` takes a `reloadToken` prop.** The old `App.tsx` refetched the
   list after a confirmed AI tool call. With the renderer owning loading there
   was no way to say "the data changed underneath you", and dropping the
   behaviour would have been a silent regression.
5. **A table keeps its headers when empty**, showing the empty text in a spanning
   cell. Collapsing to one sentence loses the shape of what would be there.
6. **`examples/notes` gained `broapp-autoapp` as a dependency**, and the root
   `tsconfig.json` was already extended in prompt 02.
7. The commit trailer names Claude Opus 5, per this session's attribution
   instruction.

## Two bugs the manual run found

- **An action or source with no `input` sent `{}`.** A route taking `s.void()`
  refuses an empty object, so the "Back to all notes" button failed silently and
  the details page would have failed to load. Both now send `undefined`. This is
  exactly what running it by hand is for: every test passed with the bug in.
- The first version of `Table` rendered no `<thead>` when there were no rows, so
  a person could not see what an empty list *would* contain.

## The manual run

Built binary, fresh `BROAPP_DATA_DIR`, driven through the in-app browser.

| Step | What happened |
|---|---|
| Open | Connection badge "Connected"; `#/notes`; form and table drawn, "No notes yet. Add one above." |
| Create | "Buy milk" / "Two litres, semi-skimmed." → row appears, no confirmation asked (a form is the deliberate act) |
| Open it | Title link href `#/note/1`; page `note`; form initialised from `$source.one.*`, so `$param.id` reached `notes.get` as the number `1` |
| Edit + done | Title to "Buy oat milk", `done` checked, Save → database shows `{"id":1,"title":"Buy oat milk","done":1}` |
| Back | Button navigates to `#/notes`; the row shows "Buy oat milk / Yes" |
| Delete, declining | Asked "Delete this note?"; answered no; the row is still there |
| Delete, accepting | Asked again; answered yes; table back to the empty message |
| `#/status` | `db-path /tmp/notes-manual/notes.sqlite`, `db-version 2`, `db-count 0`, `db-healthy Yes` |
| Backup | Asked "Write a backup beside the database?"; `notes-backup-2026-09-07T03-04-11.sqlite` written beside the database |

## Commands run

```
bun run typecheck                      exit 0
bun test tests/autoapp-views.test.ts   29 pass, 0 fail
bun test tests/autoapp-spec.test.ts    33 pass, 0 fail
cd examples/notes && bunx tsc --noEmit exit 0
cd examples/notes && bun test tests    23 pass, 0 fail (2 files)
cd examples/notes && bun run build     bin release/notes 69.6 MiB
bun run check                          exit 0 - 326 pass, 0 fail (23 files)
```

## Acceptance criteria

- **Notes' main interface is the renderer; no Notes-specific React component
  makes a bridge call** — pass. `App.tsx` calls no operation;
  `ConnectionBadge.tsx` reads `useConnection()` only. `NoteEditor.tsx` and
  `StatusPanel.tsx` are deleted.
- **No `dangerouslySetInnerHTML`, `eval`, `new Function` or `<script>` string in
  the renderer** — pass:

  ```
  $ grep -rn "dangerouslySetInnerHTML=\|eval(\|new Function(\|<script" packages/broapp-autoapp/src/react
  $
  ```

  (The only occurrence of the word anywhere is in a comment in `Text.tsx`
  saying there is none.)
- **A view specification naming a route missing from the contract cannot enter a
  release** — pass, at two doors: `writeRelease` calls
  `checkViewsAgainstContract` and refuses with `invalid_input`, and `parseSpec`
  runs `parseViews` over the field.
- **Overrides survive a release that removes their target and are reported, not
  lost** — pass. `applyOverrides` returns a `Conflict`, `overridesGet` still
  returns the item, and `AutoappView` lists one line per conflict. Two tests
  cover it, one of them over the real bridge.

## Open questions

- **A pure navigation action is missing from the specification.** Every action
  calls an operation, so the Notes "Back to all notes" button calls
  `notes.status` — a read that changes nothing — purely to get its `then`. This
  belongs in prompt 10's backlog as an `Action` that may omit `operation`.
- `autoapp.viewsGet` returns the whole specification on every page load. Fine at
  this size; a release with hundreds of pages would want it per page.
- The renderer has no list virtualisation. `notes.list` is bounded at 10,000 by
  the contract, and 10,000 table rows in one DOM is not something anybody has
  measured.
