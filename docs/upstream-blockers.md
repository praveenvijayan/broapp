# Upstream blockers

Facts recorded against real, inspected versions. Each entry says what breaks,
what Broapp does about it, and what would let Broapp drop the workaround.

## 1. `brobridge@0.2.0` publishes an unresolved `workspace:` specifier

**Status:** open. Blocks installation from npm without a workaround.

`brobridge@0.2.0`'s published manifest declares:

```json
"dependencies": {
  "ws": "^8.21.3",
  "@brobridgejs/core": "workspace:^"
}
```

`workspace:^` is a monorepo-local protocol. It is meant to be rewritten to a
real range at publish time, and it was not. A package manager reading it
outside the Brobridge repository has no workspace to resolve it against:

```
error: Workspace dependency "@brobridgejs/core" not found
error: @brobridgejs/core@workspace:^ failed to resolve
```

`@brobridgejs/client@0.2.0` is unaffected — it correctly declares
`"@brobridgejs/core": "^0.2.0"` — so only the server package is broken.

**What Broapp does.** Every Broapp project, and every generated application,
carries an `overrides` entry that supplies the missing range:

```json
"overrides": { "@brobridgejs/core": "0.2.0" }
```

Bun applies it to the transitive dependency and the install succeeds. The
generator emits it into `package.json` and the generated README explains why it
is there. Nothing in Brobridge is patched, forked, or vendored.

**How it goes away.** A `brobridge` release whose manifest names a real range —
`^0.2.0` — for `@brobridgejs/core`. When that ships, drop the `overrides` block
and raise the dependency floor. Nothing else in Broapp changes.

**Verified:** 2026-09-05, against the npm registry metadata for
`brobridge@0.2.0` and `@brobridgejs/client@0.2.0`, with Bun 1.4.0.

## 2. Unary operations do not receive a session identifier

**Status:** open, low impact. Not a bug — a gap.

`bridge.expose(name, service)` calls a service method with the JSON arguments
and nothing else. `bridge.stream(name, handler)` passes a `StreamContext`
carrying `sessionId`. So a stream handler knows which authenticated tab it is
serving and a unary handler does not.

Every call has still passed the trust fence and the cookie check before a
handler runs; the missing piece is only *which* tab. Broapp's `CallContext`
therefore carries the route name and no session id rather than inventing one.

**Workaround for an application that needs it:** use a stream, which does get
the context.

## 3. Brobridge sets no `Content-Security-Policy`

**Status:** by design upstream; handled by Broapp.

Brobridge sets `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` on every response, and lets the host
application supply the body served at `/` — but not extra headers. There is
therefore no way to set a CSP header through `createBridge`.

Broapp puts the policy in a `<meta http-equiv="Content-Security-Policy">` at the
top of the generated document, with the inline script pinned by SHA-256 hash.
See [security.md](security.md).

A `headers` option on `IndexDocument` would let Broapp send a real header
instead, which is marginally stronger (a header applies before any markup is
parsed). It is not required for correctness.
