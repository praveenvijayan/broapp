# Contract and operations

## The contract

`src/shared/contract.ts` is data: a table of operations and streams with
schemas. Both sides import it; neither imports the other. It holds no
implementation, so the browser bundle can follow it without pulling the host
in.

```ts
import { defineContract, s } from 'broapp/shared';

export const contract = defineContract({
  operations: {
    'notes.list': {
      summary: 'All notes, newest first.',
      input: s.void(),
      output: s.object({
        notes: s.array(
          s.object({ id: s.number({ int: true }), title: s.string(), updatedAt: s.number() }),
          { max: 10_000 },
        ),
      }),
    },
    'notes.create': {
      summary: 'Create a note.',
      input: s.object({ title: s.string({ min: 1, max: 200 }), body: s.string({ max: 100_000 }) }),
      output: s.object({ id: s.number({ int: true }) }),
    },
    'notes.remove': {
      summary: 'Delete one note.',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ ok: s.boolean() }),
    },
  },
  streams: {
    'notes.export': {
      summary: 'Write every note to a file under the data directory, reporting progress.',
      params: s.object({ format: s.enum(['markdown', 'json']) }),
      event: s.object({ written: s.number(), total: s.number(), done: s.boolean() }),
    },
  },
});

export type AppContract = typeof contract;
```

Route names are `group.member`. Both halves are required and neither may
contain a dot. `defineContract` rejects a malformed name at startup.

Underneath, `'notes.list'` is exactly `bridge.expose('notes', { list })` on
the host and `bridge.call('notes.list', input)` in the browser. There is no
second protocol.

## Schemas

`s` from `broapp/shared`:

| Schema | Options |
| --- | --- |
| `s.string()` | `min`, `max`, `pattern` |
| `s.number()` | `int`, `min`, `max` |
| `s.boolean()` | |
| `s.literal(value)` | |
| `s.enum([...])` | |
| `s.array(item)` | `min`, `max` |
| `s.object({...})` | unknown keys are dropped |
| `s.optional(schema)`, `s.nullable(schema)` | |
| `s.void()` | for no input |
| `s.unknown()` | outputs only, never inputs |

No unions of objects, no transforms, no refinements, no async. If you need
more, `defineContract` accepts anything with a `parse` method: Zod, Valibot
and ArkType drop in unchanged. Prefer the bundled `s` for a generated
project; it has no dependencies and keeps the install offline.

Bound everything the browser can send. Array lengths, string lengths,
numeric ranges, listing counts. The contract is where limits live.

## Operation handlers

`src/host/operations.ts`:

```ts
import { createHostApp, publicError } from 'broapp/host';
import { contract } from '../shared/contract.ts';

export function createApp(facts: HostFacts) {
  const app = createHostApp(contract);

  app.operation('notes.create', ({ title, body }) => {
    const trimmed = title.trim();
    if (trimmed === '') throw publicError.invalidInput('A note needs a title.');
    return { id: store.create(trimmed, body) };
  });

  app.operation('notes.remove', ({ id }) => {
    if (!store.has(id)) throw publicError.notFound('That note no longer exists.');
    store.remove(id);
    return { ok: true };
  });

  return app;
}
```

- Input is validated and typed before the handler runs. Unknown properties
  are already gone.
- Handlers may be sync or async.
- The host refuses to start if a declared route has no handler.
- `CallContext` (second argument) carries only the route name. Unary
  handlers do not know which tab called them. Use a stream if you need the
  session id.
- `app.mount(bridge)` registers everything; `src/host/main.ts` already calls
  it from `startApp({ register })`.
- `app.activeStreams` and `app.abortAll(reason)` exist for lifecycle wiring.

## Errors

Two kinds, and the difference is the boundary.

```ts
// Shown to the user verbatim. Code crosses too.
throw publicError.invalidInput('Enter a title with at least one visible character.');
throw publicError.notFound('That note no longer exists.');
throw publicError.conflict('A note with that title already exists.');
throw publicError.unavailable('The database is not open. See the terminal.');
throw publicError.rejected('That file is outside the folder this application may read.');

// Logged on the host with its stack. Browser gets a fixed sentence.
throw new Error(`sqlite: ${db.lastError} at ${databasePath}`);
```

In the browser both arrive as `BroappError` with `code` set to
`invalid_input`, `not_found`, `conflict`, `unavailable`, `rejected` or
`internal`, so a component can branch on kind.

Keep filesystem paths, credentials and driver messages out of a
`PublicError`. Its message is the point, and the reason to be careful.

## Validation in two layers

The contract validates types and bounds on the host, always, before a
handler sees input. The browser validates too, but only as a convenience.
The host check is the security boundary.

The contract cannot know the application's rules: that whitespace is not a
title, that this record belongs to this user, that a date must be in the
future. Do those in the handler and raise a `PublicError`.

## Calling from the UI

```tsx
import { useOperation } from 'broapp/react';
import type { AppContract } from '../shared/contract.ts';

const create = useOperation<AppContract, 'notes.create'>('notes.create');

<form onSubmit={(e) => { e.preventDefault(); void create.run({ title, body }); }}>
  <button type="submit" disabled={create.pending}>{create.pending ? 'Saving…' : 'Save'}</button>
</form>
{create.error !== null && <p role="alert">{create.error.message}</p>}
```

`run` never rejects; the result lands in `data` or `error`. Only the most
recent call settles state, so a slow earlier response cannot overwrite a
later one. A call during startup waits for the connection. `reset()` clears
`data` and `error`.

Run an operation once on mount, after the connection is ready:

```tsx
const connection = useConnection();
const list = useOperation<AppContract, 'notes.list'>('notes.list');
useEffect(() => {
  if (connection.phase === 'ready' && list.data === null && !list.pending) void list.run(undefined);
}, [connection.phase, list]);
```

Outside React, or in a test:

```ts
import { createClient } from 'broapp/client';
const client = await createClient(contract);
const result = await client.call('notes.list', undefined);
```

## Removing the demo routes

Delete the route from `contract.ts`, its handler in `operations.ts`, and the
component that calls it, in that order. The type checker names every call
site the moment the contract entry goes; the host names a missing handler at
startup. Keep `demo.hostInfo` if `DeveloperPanel.tsx` stays.
