/**
 * The fixture application's contract.
 *
 * Small on purpose, and chosen to exercise all three effects: `items.list`
 * changes nothing, `items.add` changes local data, and `items.ping` claims to
 * reach outside the machine without actually doing so — which is what makes it
 * usable as a test of what `preview` refuses.
 */
import { defineContract, s } from 'broapp/shared';

const item = s.object({
  id: s.number({ int: true }),
  label: s.string(),
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
      input: s.object({ label: s.string({ min: 1, max: 200 }) }),
      output: item,
    },
    'items.ping': {
      effect: 'external',
      summary: 'Pretend to reach outside this machine.',
      input: s.void(),
      output: s.object({ ok: s.boolean() }),
    },
  },
  streams: {
    'items.watch': {
      effect: 'read',
      summary: 'A stream that keeps going until it is cancelled.',
      params: s.object({ everyMs: s.number({ int: true, min: 1, max: 10_000 }) }),
      event: s.object({ n: s.number() }),
    },
  },
});
