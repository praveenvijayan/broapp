# 02 — Shared foundations

`bun run typecheck` exit 0. `bun test tests` → `154 pass, 0 fail` across 13
files. `bun run check` exit 0.

## What was built

- **`toJsonSchema()`** on every `s.*` schema, exactly the prompt's table.
  `JsonSchema` exported from `broapp/shared`. A `keywords()` helper never
  creates a key for an unset option, so `s.string().toJsonSchema()` is exactly
  `{"type":"string"}`.
- **`mergeContracts`**, **`RESERVED_GROUPS`**, **`assertNoReservedRoutes`**,
  all exported from `broapp/shared`. `createHostApp` calls the assertion;
  `createReservedHostApp` (in `broapp/host`, documented as not for
  applications) skips it.
- **`HostApp.invoke(name, input)`**. The wrapper `mount` built inline is now
  `runOperation`, used by both paths.
- **`broapp/ai`**: `types.ts`, `contract.ts`, `types.check.ts`, `index.ts`,
  plus `"./ai"` in `packages/broapp/package.json`. Tests: 15 in
  `schema.test.ts`, 4 in `bridge.test.ts`, 1 in `build.test.ts`, new
  `contract.test.ts` (7) and `ai-contract.test.ts` (7).

## Conflicts with the repository, and what I changed

1. **Route names with two dots were rejected.** `ROUTE_PATTERN` allowed one
   dot, so `ai.settings.get` could not be declared. Brobridge has no such
   restriction: `brobridge/dist/services.js:119` splits at the *first* dot and
   looks the remainder up as one own property, so `ai.settings.get` is the
   method `"settings.get"` on service `"ai"`. Routes must not be renamed, so
   the pattern now allows further `.segment` parts. The test asserting the old
   behaviour claimed "Brobridge cannot resolve" it, which is false; it now
   asserts the true behaviour, including
   `splitRoute('a.b.c') === { group: 'a', member: 'b.c' }`.
2. **`invoke` leaked internal error messages.** `wrap()` deliberately rethrows
   a non-`PublicError` unchanged because Brobridge reduces it at the transport.
   `invoke` has no transport, so the raw message — in the test, a path
   containing `secret-token` — reached the caller. The caller is the AI layer
   and may put it in a transcript, so `invoke` applies the same reduction: a
   marked `broapp/<code> …` error passes through, anything else becomes
   `INTERNAL_ERROR_MESSAGE`. Added `isPublicBridgeError` to
   `shared/errors.ts`, not exported from the public index.
3. **`Infer` made every object key required**, so an `s.optional` field could
   never be `Equal` to `field?: T`. Fixed at the type level only: `s.object`
   infers optional keys as optional (`InferObject`). No runtime change —
   `check` already skipped absent optional keys — and the suite passes
   unchanged.
4. **`readonly` in the AI interfaces broke `Equal`.** Per the prompt's
   instruction to match `Infer` rather than weaken the check, `types.ts` has no
   `readonly` modifiers, with a comment saying why.
5. **`Schema.toJsonSchema` is required, as the prompt specifies.** That
   narrows the promise in `docs/host-operations.md` that `defineContract`
   accepts "anything with a `parse` method": a bare Zod schema no longer
   satisfies `Schema<T>`. Left alone; flagged for the docs prompt (07).

## Decisions I made

- `invoke` throws `TypeError` **synchronously** for a stream route, an
  undeclared route or a missing handler — programming errors, which `app.ts`
  already surfaces at the call site. Only real call failures reject.
- `ChatEvent.input` / `output` are `s.optional(s.unknown())`: they carry an
  application operation's own input and output, which this layer cannot
  describe in advance.

## `ai.chat` params as JSON Schema

```json
{ "type": "object",
  "properties": {
    "runId": { "type": "string", "pattern": "[A-Za-z0-9_-]{8,64}" },
    "message": { "type": "string", "minLength": 1, "maxLength": 20000 },
    "refs": { "type": "array", "items": { "type": "string", "maxLength": 200 }, "maxItems": 50 },
    "history": { "type": "array", "maxItems": 100,
      "items": { "type": "object",
        "properties": { "role": { "type": "string", "enum": ["user", "assistant"] },
                        "content": { "type": "string", "maxLength": 20000 } },
        "required": ["role", "content"], "additionalProperties": false } } },
  "required": ["runId", "message", "refs", "history"],
  "additionalProperties": false }
```

Note for prompt 04: `pattern` is emitted unanchored, as `pattern.source`. The
validator anchors it when checking; a provider reading this JSON Schema would
not. Nothing else is blocking — prompt 03 mounts `aiContract` with
`createReservedHostApp`.
