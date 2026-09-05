# Development workflow

```bash
bun run dev
```

One command. It builds the interface, starts the host, opens your browser, and
watches `src/`. On a change it rebuilds, restarts the host, and prints a fresh
launch URL. `Ctrl+C` stops everything, including the child process.

## Why there is no hot module replacement

HMR needs a channel the page can pull new modules over. A Broapp application has
exactly one such channel — the authenticated Brobridge bridge — and every other
route is a `404`, on purpose.

The usual way to get HMR anyway is a second dev server on another port with
permissive CORS. That is precisely what this starter must not do. It would serve
the application from an unauthenticated origin, and the development build would
stop resembling the shipped one in the way that matters most: a bug in the
authentication path would be invisible until production.

So the workflow is rebuild-and-reload. For a starter-sized UI the whole cycle —
bundle plus process restart plus page load — is well under a second. If your UI
grows to where that hurts, the honest answer is to develop presentational
components in isolation with whatever tool you like, and use `broapp dev` for
the parts that talk to the host.

If you find a way to do secure HMR over the authenticated origin, that is a
genuinely useful contribution.

## Why the browser opens only once

A restart mints a new one-time launch token, and the old tab's session belongs
to a process that no longer exists — Brobridge sessions do not survive the
process that made them.

So `broapp dev` opens the browser on the **first** start only. Every restart
after that prints the fresh URL:

```
[broapp] changed: src/ui/App.tsx
[broapp] ui 244 KiB in 41 ms
[broapp] host restarted — reload the tab (its previous session ended with the old process)
```

A tab per save would be unusable, and silently resuming into a dead session is
not something Broapp will pretend to do.

## What the dev host does differently

Three environment variables, set by `broapp dev`:

- `BROAPP_DEV=1` — the template reports "development" in its details panel.
- `BROAPP_LIFECYCLE=background` — a dev host that exited because the tab was
  momentarily gone would race every restart.
- `BROAPP_OPEN_BROWSER=0` on restarts.

Everything else is identical to a compiled build, including authentication, the
trust fence, and the CSP. The development bundle is unminified so devtools are
usable; nothing else changes.

## Watching

`src/` recursively, for `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html` and
`.json`. Changes are debounced 120 ms, so saving several files at once is one
rebuild. The built page is ignored, or every build would trigger another.

A build failure prints the error and keeps waiting. The previous host keeps
running, so you do not lose a working application to a typo.

## Restarts are clean

`SIGTERM` first, so the host runs its shutdown hook — close the database, end
streams — then `SIGKILL` after three seconds if it has not exited. Restarts are
serialised, so a burst of saves cannot leave two hosts fighting over a port.

## Type checking

```bash
bun run typecheck
```

Fast and worth running. Contract changes surface as type errors in the
components that call them, which is most of the point of having a contract.

## Tests

```bash
bun test
```

Generated projects start with no tests. The examples have real ones worth
copying — [`examples/file-processor/tests/boundary.test.ts`](../examples/file-processor/tests/boundary.test.ts)
for a security-relevant boundary, [`examples/notes/tests/db.test.ts`](../examples/notes/tests/db.test.ts)
for migrations and persistence.

To test operations end to end, start a bridge in-process and connect a real
client — [`tests/harness.ts`](../tests/harness.ts) in this repository shows how,
including the cookie jar a test process needs and a browser gets for free.

## Building

```bash
bun run build              # this platform
bun run build --page       # the UI document only
bun run build:all          # every supported target
```

See [packaging.md](packaging.md).
