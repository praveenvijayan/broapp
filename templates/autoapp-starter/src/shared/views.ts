/**
 * What this application looks like, as data.
 *
 * The browser runs the pinned renderer over this specification; there is no
 * generated browser code anywhere in an Autoapp application. Components keep
 * their `id` across changes — a person's own customisations key on it, and
 * renaming one throws their work away.
 *
 * Nothing in this file carries the application's name, and nothing in any
 * other `.ts` file does either. The starter's placeholders are substituted by
 * plain text replacement, and a name containing a quote or a backslash inside
 * a TypeScript string literal would produce a file that does not parse — so
 * they live only in JSON, in HTML text and in Markdown. The browser tab's
 * title comes from `src/ui/index.html`, and this page's heading is an ordinary
 * word anybody can change.
 */
import type { ViewsSpec } from 'broapp-autoapp/shared';

export const views: ViewsSpec = {
  specVersion: 1,
  home: 'items',
  pages: [
    {
      id: 'items',
      title: 'Items',
      sources: [
        { id: 'all', operation: 'items.list' },
        { id: 'status', operation: 'items.status' },
      ],
      children: [
        {
          id: 'add-item',
          kind: 'form',
          label: 'Add an item',
          fields: [
            { id: 'label', label: 'Label', type: 'text', required: true, max: 200 },
            { id: 'note', label: 'Note', type: 'textarea', max: 2_000 },
          ],
          // A form's submit needs no confirmation: somebody filled it in and
          // pressed the button on it, which is already the deliberate act a
          // confirmation exists to demand.
          submit: {
            id: 'create',
            label: 'Add',
            operation: 'items.add',
            input: { label: '$field.label', note: '$field.note' },
            refresh: ['all', 'status'],
          },
        },
        {
          id: 'items-table',
          kind: 'table',
          source: 'all',
          rows: 'items',
          emptyText: 'Nothing here yet. Add the first one above.',
          columns: [
            { id: 'label', header: 'Label', path: 'label' },
            { id: 'note', header: 'Note', path: 'note', width: 'wide' },
            { id: 'done', header: 'Done', path: 'done', format: 'boolean' },
            { id: 'createdAt', header: 'Added', path: 'createdAt', format: 'datetime' },
          ],
          // A row action is one click away from a list, so both of these ask
          // first. `nextDone` is the row's own inverted flag — see the comment
          // in `contract.ts` for why the row carries it.
          rowActions: [
            {
              id: 'toggle',
              label: 'Done / not done',
              operation: 'items.update',
              input: { id: '$row.id', done: '$row.nextDone' },
              confirmText: 'Change whether this item is done?',
              refresh: ['all', 'status'],
            },
            {
              id: 'remove',
              label: 'Remove',
              operation: 'items.remove',
              input: { id: '$row.id' },
              confirmText: 'Remove this item?',
              refresh: ['all', 'status'],
            },
          ],
        },
        {
          id: 'counts',
          kind: 'text',
          template: '{{status.count}} items, {{status.done}} of them done.',
        },
      ],
    },
  ],
};
