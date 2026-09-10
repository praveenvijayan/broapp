/**
 * What this application can be asked to do.
 *
 * Five routes over one table. Every one declares an `effect` and a `summary`,
 * because an Autoapp release refuses a route without them: the effect is what
 * the gate reads when it decides whether to ask, and the summary is what a
 * person and an agent are shown when it does.
 *
 * There are no application names in this file on purpose — the route group is
 * `items` whatever the application is called. A name is data; a route group is
 * code, and rewriting identifiers with string substitution is how a starter
 * breaks the first time somebody names their application "list".
 */
import { defineContract, s } from 'broapp/shared';

const item = s.object({
  id: s.number({ int: true }),
  label: s.string(),
  note: s.string(),
  done: s.boolean(),
  /**
   * The value a toggle should write: `done` inverted.
   *
   * A view specification carries no expressions, so a row action can only pass
   * a value the row already has. Sending this one back as `done` is what makes
   * "toggle" a single click rather than two routes.
   */
  nextDone: s.boolean(),
  createdAt: s.number(),
});

export const contract = defineContract({
  operations: {
    'items.list': {
      effect: 'read',
      summary: 'Every item, newest first.',
      input: s.void(),
      output: s.object({ items: s.array(item, { max: 10_000 }), count: s.number() }),
    },
    'items.add': {
      effect: 'write',
      summary: 'Add one item.',
      input: s.object({
        label: s.string({ min: 1, max: 200 }),
        note: s.optional(s.string({ max: 2_000 })),
      }),
      output: item,
    },
    'items.update': {
      effect: 'write',
      summary: 'Change one item’s label, note or done flag.',
      input: s.object({
        id: s.number({ int: true }),
        label: s.optional(s.string({ min: 1, max: 200 })),
        note: s.optional(s.string({ max: 2_000 })),
        done: s.optional(s.boolean()),
      }),
      output: item,
    },
    'items.remove': {
      effect: 'write',
      summary: 'Remove one item.',
      input: s.object({ id: s.number({ int: true }) }),
      output: s.object({ removed: s.boolean() }),
    },
    'items.status': {
      effect: 'read',
      summary: 'How many items there are, and what schema version the data is at.',
      input: s.void(),
      output: s.object({
        count: s.number(),
        done: s.number(),
        schemaVersion: s.number(),
        healthy: s.boolean(),
      }),
    },
  },
  streams: {},
});
