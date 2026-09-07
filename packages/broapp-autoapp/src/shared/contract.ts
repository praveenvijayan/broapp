/**
 * Autoapp's own routes.
 *
 * A contract like any application's, with one difference: it owns the reserved
 * `autoapp` route group and is mounted as a *second* host app on the same
 * bridge, exactly as the AI layer is. That keeps an application's route table
 * free of Autoapp's routes, and lets an application that is not running on the
 * renderer carry none of this.
 *
 * Nothing in this file may import from `../host/`. The browser bundles it, and
 * a bundler that followed such an import would try to pull `node:fs` into a
 * page. A test asserts that stays true.
 */
import { defineContract, s } from 'broapp/shared';
import type { Schema } from 'broapp/shared';

import type { Conflict, Override, Overrides } from '../views/overrides.ts';
import type { ViewsSpec } from '../views/types.ts';

/**
 * A view specification, on the wire.
 *
 * Deliberately not restated field by field. The authority on the shape is
 * `parseViews`, which the host runs before this ever sees a value, and a second
 * description here would be a second thing to keep in step. What the contract
 * has to guarantee is that it is an object — the browser's renderer trusts the
 * host, which is the one direction trust runs in a local application.
 */
function hostControlled<T>(name: string): Schema<T> {
  const self: Schema<T> = {
    kind: 'host-controlled',
    check: (value, path = []) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? { ok: true, value: value as T }
        : { ok: false, issues: [{ path, message: `expected ${name}` }] },
    parse(value) {
      const outcome = self.check(value, []);
      if (outcome.ok) return outcome.value;
      throw new Error(`expected ${name}`);
    },
    toJsonSchema: () => ({ type: 'object' }),
  };
  return self;
}

/** One person's change to one component. Bounded, because a browser sends it. */
const override = s.object({
  componentId: s.string({ min: 1, max: 100, pattern: /^[a-z][a-z0-9-]*$/ }),
  label: s.optional(s.string({ max: 200 })),
  hidden: s.optional(s.boolean()),
  headers: s.optional(hostControlled<Record<string, string>>('an object of column headers')),
  columnOrder: s.optional(s.array(s.string({ min: 1, max: 100 }), { max: 50 })),
}) as unknown as Schema<Override>;

const overrides = s.object({
  version: s.number({ int: true, min: 1, max: 1 }),
  items: s.array(override, { max: 500 }),
}) as unknown as Schema<Overrides>;

const conflict = s.object({
  componentId: s.string({ max: 100 }),
  reason: s.string({ max: 400 }),
}) as unknown as Schema<Conflict>;

/** Autoapp's routes. Applications may not declare the `autoapp` group themselves. */
export const autoappContract = defineContract({
  operations: {
    'autoapp.overridesGet': {
      effect: 'read',
      input: s.void(),
      output: overrides,
      summary: 'This person’s own changes to the interface.',
    },
    'autoapp.overridesSet': {
      effect: 'write',
      input: overrides,
      output: s.object({ ok: s.boolean() }),
      summary: 'Replace this person’s changes to the interface.',
    },
    'autoapp.viewsGet': {
      effect: 'read',
      input: s.void(),
      output: s.object({
        views: hostControlled<ViewsSpec>('a view specification'),
        conflicts: s.array(conflict, { max: 500 }),
      }),
      summary: 'The interface this release describes, with this person’s changes applied.',
    },
  },
  streams: {},
});

/** Autoapp's contract type, for `HostApp` and client generics. */
export type AutoappContract = typeof autoappContract;
