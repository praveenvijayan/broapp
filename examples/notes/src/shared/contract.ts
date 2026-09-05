/**
 * Notes — contract.
 *
 * A small persistent application: validated CRUD, a versioned schema, and a
 * documented backup. The point is to show what persistence adds to the pattern
 * — a database handle that must be closed on shutdown, a migration that must
 * run before the first query, and failures that need a real answer rather than
 * a spinner.
 */
import { defineContract, s } from 'broapp/shared';

/** A note as the browser sees it. */
const note = s.object({
  id: s.number({ int: true }),
  title: s.string(),
  body: s.string(),
  done: s.boolean(),
  createdAt: s.number(),
  updatedAt: s.number(),
});

/** Bounds are enforced on the host; these are the same ones the UI shows. */
export const LIMITS = { title: 200, body: 20_000 } as const;

export const contract = defineContract({
  operations: {
    'notes.list': {
      summary: 'Every note, newest first.',
      input: s.object({
        /** Omit for all; true or false to filter. */
        done: s.optional(s.nullable(s.boolean())),
      }),
      output: s.object({ notes: s.array(note, { max: 10_000 }) }),
    },

    'notes.create': {
      input: s.object({
        title: s.string({ min: 1, max: LIMITS.title }),
        body: s.string({ max: LIMITS.body }),
      }),
      output: note,
    },

    'notes.update': {
      input: s.object({
        id: s.number({ int: true, min: 1 }),
        title: s.string({ min: 1, max: LIMITS.title }),
        body: s.string({ max: LIMITS.body }),
        done: s.boolean(),
      }),
      output: note,
    },

    'notes.remove': {
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ removed: s.boolean() }),
    },

    'notes.status': {
      summary: 'Where the database is, what version it is at, and whether it is healthy.',
      input: s.void(),
      output: s.object({
        databasePath: s.string(),
        schemaVersion: s.number(),
        latestSchemaVersion: s.number(),
        noteCount: s.number(),
        /** False when the database could not be opened; the UI says so plainly. */
        healthy: s.boolean(),
      }),
    },

    'notes.backup': {
      summary: 'Write a consistent copy of the database beside it.',
      input: s.void(),
      output: s.object({ path: s.string(), bytes: s.number() }),
    },
  },

  streams: {},
});
