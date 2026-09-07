/** The fixture application's interface. Minimal: one page, one table, one form. */
import type { ViewsSpec } from 'broapp-autoapp/shared';

export const views: ViewsSpec = {
  specVersion: 1,
  home: 'items',
  pages: [
    {
      id: 'items',
      title: 'Items',
      sources: [{ id: 'all', operation: 'items.list' }],
      children: [
        {
          id: 'add-item',
          kind: 'form',
          label: 'Add',
          fields: [{ id: 'label', label: 'Label', type: 'text', required: true, max: 200 }],
          submit: {
            id: 'create',
            label: 'Add',
            operation: 'items.add',
            input: { label: '$field.label' },
            refresh: ['all'],
          },
        },
        {
          id: 'items-table',
          kind: 'table',
          source: 'all',
          rows: 'items',
          emptyText: 'Nothing yet.',
          columns: [
            { id: 'label', header: 'Label', path: 'label' },
            { id: 'createdAt', header: 'Added', path: 'createdAt', format: 'datetime' },
          ],
        },
      ],
    },
  ],
};
