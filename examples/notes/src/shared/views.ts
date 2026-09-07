/**
 * Notes — the interface, as data.
 *
 * There is no Notes-specific React in this application any more. Everything a
 * person sees is described here and drawn by `broapp-autoapp/react`, which is
 * pinned and identical for every Autoapp application. That is what makes an
 * interface something an AI engineer can propose a change to: a proposal edits
 * this object, and nothing that runs in the browser changes at all.
 *
 * Component ids are stable on purpose. A person's own customisations key on
 * them, so renaming one throws their change away.
 */
import type { ViewsSpec } from 'broapp-autoapp/shared';

import { LIMITS } from './contract.ts';

export const notesViews: ViewsSpec = {
  specVersion: 1,
  home: 'notes',
  pages: [
    {
      id: 'notes',
      title: 'Notes',
      sources: [{ id: 'all', operation: 'notes.list', input: {} }],
      children: [
        {
          id: 'new-note',
          kind: 'form',
          label: 'New note',
          fields: [
            { id: 'title', label: 'Title', type: 'text', required: true, max: LIMITS.title },
            { id: 'body', label: 'Body', type: 'textarea', max: LIMITS.body },
          ],
          submit: {
            id: 'create',
            label: 'Add note',
            operation: 'notes.create',
            input: { title: '$field.title', body: '$field.body' },
            refresh: ['all'],
          },
        },
        {
          id: 'notes-table',
          kind: 'table',
          label: 'Your notes',
          source: 'all',
          rows: 'notes',
          emptyText: 'No notes yet. Add one above.',
          columns: [
            {
              id: 'title',
              header: 'Title',
              path: 'title',
              width: 'wide',
              link: { page: 'note', params: ['id'] },
            },
            { id: 'done', header: 'Done', path: 'done', format: 'boolean', width: 'narrow' },
            { id: 'updatedAt', header: 'Updated', path: 'updatedAt', format: 'datetime' },
          ],
          rowActions: [
            {
              id: 'remove',
              label: 'Delete',
              operation: 'notes.remove',
              input: { id: '$row.id' },
              confirmText: 'Delete this note?',
              refresh: ['all'],
            },
          ],
        },
      ],
    },

    {
      id: 'note',
      title: 'Note',
      params: ['id'],
      sources: [{ id: 'one', operation: 'notes.get', input: { id: '$param.id' } }],
      children: [
        {
          id: 'edit',
          kind: 'form',
          label: 'Edit',
          fields: [
            {
              id: 'title',
              label: 'Title',
              type: 'text',
              required: true,
              max: LIMITS.title,
              initial: '$source.one.title',
            },
            { id: 'body', label: 'Body', type: 'textarea', max: LIMITS.body, initial: '$source.one.body' },
            { id: 'done', label: 'Done', type: 'boolean', initial: '$source.one.done' },
          ],
          submit: {
            id: 'save',
            label: 'Save',
            operation: 'notes.update',
            input: {
              id: '$param.id',
              title: '$field.title',
              body: '$field.body',
              done: '$field.done',
            },
            refresh: ['one'],
          },
        },
        {
          id: 'back',
          kind: 'button',
          // A pure navigation is not expressible yet: every action calls an
          // operation. `notes.status` is read, costs one local round trip and
          // changes nothing, so it stands in until prompt 10's backlog item
          // gives navigation an action of its own.
          action: {
            id: 'back-to-notes',
            label: 'Back to all notes',
            operation: 'notes.status',
            then: { page: 'notes' },
          },
        },
      ],
    },

    {
      id: 'status',
      title: 'Details',
      sources: [{ id: 'st', operation: 'notes.status' }],
      children: [
        {
          id: 'status-panel',
          kind: 'section',
          label: 'Database',
          children: [
            { id: 'db-path', kind: 'status', label: 'File', source: 'st', path: 'databasePath' },
            {
              id: 'db-version',
              kind: 'status',
              label: 'Schema version',
              source: 'st',
              path: 'schemaVersion',
              format: 'number',
            },
            {
              id: 'db-count',
              kind: 'status',
              label: 'Notes',
              source: 'st',
              path: 'noteCount',
              format: 'number',
            },
            {
              id: 'db-healthy',
              kind: 'status',
              label: 'Healthy',
              source: 'st',
              path: 'healthy',
              format: 'boolean',
            },
          ],
        },
        {
          id: 'backup',
          kind: 'button',
          action: {
            id: 'take-backup',
            label: 'Back up now',
            operation: 'notes.backup',
            confirmText: 'Write a backup beside the database?',
            refresh: ['st'],
          },
        },
      ],
    },
  ],
};
