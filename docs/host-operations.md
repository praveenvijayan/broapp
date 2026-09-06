# Adding a host operation

Three steps. The compiler enforces all three.

## 1. Declare it

`src/shared/contract.ts`:

```ts
export const contract = defineContract({
  operations: {
    'notes.rename': {
      summary: 'Give a note a new title.',
      input: s.object({
        id: s.number({ int: true, min: 1 }),
        title: s.string({ min: 1, max: 200 }),
      }),
      output: s.object({ ok: s.boolean() }),
    },
  },
  streams: {},
});
```

A route name is `group.member`. Both halves are required and neither may contain
a dot — Brobridge resolves a call by splitting on it. `defineContract` rejects a
malformed name at startup rather than at the first call.

## 2. Implement it

`src/host/operations.ts`:

```ts
app.operation('notes.rename', ({ id, title }) => {
  const trimmed = title.trim();
  if (trimmed === '') throw publicError.invalidInput('A note needs a title.');
  return { ok: store.rename(id, trimmed) };
});
```

`id` and `title` are already validated and typed. Unknown properties a caller
sent have been dropped, so nothing reaches your code that the contract did not
name.

The host **refuses to start** if a declared route has no implementation. A route
that answers `NOT_FOUND` at runtime is a shipped bug, and startup is when a
developer is present to see it.

## 3. Call it

```tsx
const rename = useOperation<AppContract, 'notes.rename'>('notes.rename');

<button onClick={() => void rename.run({ id: note.id, title: draft })} disabled={rename.pending}>
  {rename.pending ? 'Saving…' : 'Rename'}
</button>
{rename.error !== null && <p role="alert">{rename.error.message}</p>}
```

`run` never rejects; the outcome lands in `data` or `error`. Only the most
recent call settles the state, so a slow earlier response cannot overwrite a
later one. A click during the first second of startup waits for the connection
rather than failing.

Outside React, use the client directly:

```ts
const client = await createClient(contract);
const result = await client.call('notes.rename', { id: 1, title: 'New' });
```

## Errors

Two kinds, and the difference is deliberate.

```ts
// The user can act on this. The message crosses to the browser verbatim.
throw publicError.notFound('That note no longer exists.');

// Everything else. Logged on the host with its stack; the browser gets
// "The application could not complete that operation."
throw new Error(`sqlite: ${db.lastError} at ${databasePath}`);
```

Available: `invalidInput`, `notFound`, `conflict`, `unavailable`, `rejected`.
They arrive in the browser as `BroappError` with a matching `code`, so an
interface can branch on the kind as well as show the message.

Keep filesystem paths, credentials and driver messages out of a `PublicError` —
its message is shown to the user exactly as written.

## Validation

The contract validates types and bounds. It cannot know your application's
rules: that a title of only whitespace is not a title, or that this record
belongs to somebody else. Do that in the handler and raise a `PublicError`.

The host's validation is the security boundary. The browser validates too, but
only so that a mistake is caught where it was made — a different tab, an older
build, or a hand-written client would not.

Available schemas: `string`, `number`, `boolean`, `literal`, `enum`, `array`,
`object`, `optional`, `nullable`, `void`, `unknown`. Bounds are `min`/`max` on
strings, numbers and arrays, plus `int` and `pattern`.

`s.unknown()` is fine for an *output* whose shape the host controls. Do not use
it for an input: the whole point of the input schema is that browser-supplied
data is untrusted.

The validator is about 250 lines with no dependencies, so a generated project
installs and runs without a network. If you outgrow it, `defineContract` accepts
anything with a `parse` method — Zod, Valibot and ArkType drop in unchanged.

Every `s.*` schema can also describe itself as JSON Schema through
`toJsonSchema()`. The [AI layer](ai.md) uses that to offer an operation to a
model as a tool, so an operation declared with `s.*` needs nothing extra. One
declared with a foreign validator has no `toJsonSchema`, so `fromContract`
refuses it; write that tool by hand with an explicit `inputSchema`.

## Long-running work

An operation that takes seconds should be a stream instead, so it can report
progress and be cancelled. See [streaming.md](streaming.md).

## What a handler is told about its caller

`CallContext` carries the route name and nothing else. Brobridge passes a
session id to *stream* handlers but not to the methods of an exposed service,
and Broapp does not invent one. Every call has still passed the trust fence and
the cookie check before a handler runs; the missing piece is only which
authenticated tab called. An application that needs it should use a stream.
