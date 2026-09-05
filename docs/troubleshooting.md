# Troubleshooting

## Installation

### `error: @brobridgejs/core@workspace:^ failed to resolve`

Only `brobridge@0.2.0` has this defect. Raise the dependency to `^0.2.1`, which
publishes a real range, and delete any `"overrides": { "@brobridgejs/core": … }`
entry left over from the 0.2.0 workaround: an exact override pins the protocol
core below the server and client that need it. Details in
[upstream-blockers.md](upstream-blockers.md).

### `bun create broapp` cannot find the package

The packages are not published to npm yet. Until they are, generate from a
checkout:

```bash
bun run scripts/pack-local.ts
cd /somewhere/else
bunx --bun /path/to/broapp/packages/create-broapp/src/main.ts my-app --no-install
```

## Development

### The browser did not open

The URL is on the terminal. Paste it. It carries a one-time token, so it works
once — if you have already used it, restart the host for a fresh one.

`--no-open` suppresses the launch deliberately, and `broapp dev` only opens a
browser on the first start.

### The tab says "Still reconnecting…" after a restart

Expected. A restart mints a new session, and the old tab's session belongs to a
process that no longer exists. Reload the tab using the URL the terminal printed
on the restart.

### `403` on every request

The trust fence or the cookie check refused it. Usually one of:

- Reaching the host at a different name than it bound — `localhost:1234` when it
  bound `127.0.0.1:1234`. Use exactly the URL it printed.
- A launch token that has already been redeemed. Restart for a new one.
- A proxy or extension rewriting `Host` or `Origin`.

### `404` on an asset

There is no static file route. If you added a `<script src>` or a `<link href>`
to `src/ui/index.html`, remove it — the UI is one document with everything
inline. See [architecture.md](architecture.md).

### The build says the page loads from an off-origin URL

Something in the bundle references another origin from a loading position — a
web font, a CDN script, a remote image. Inline it or embed it as a `data:` URI.
A local application that fetches from the network stops working offline and
tells a third party when the user runs it.

A URL that is only a *string* in JavaScript is fine and is not what this check
looks for.

### The build says it expected exactly one JavaScript chunk

A dynamic `import()` produced a second chunk, which would need a second HTTP
route. Make the import static.

### Changes are not picked up

`broapp dev` watches `src/` for `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html`
and `.json`. A file elsewhere, or with another extension, is not watched.
Restart `broapp dev` after editing `broapp.config.ts`.

### `Cannot find module '../../dist/ui.html'`

The host imports the built page, so the page must exist before the host is
compiled. Run `bun run build` (which does both), or `bun run build --page`
first.

## Running

### The application exits by itself

Interactive mode. It exits about twenty seconds after the last tab detaches.
Use `--background` to keep it running.

If it exits with status 1 saying no browser connected, nothing reached it inside
the launch window — the browser did not open and the URL was never used.

### It exits while a long operation is running

It should not: `isBusy` blocks the idle timer. If your long work is not a
stream, wire your own condition into `isBusy` — see [lifecycle.md](lifecycle.md).

### Where is my data?

```bash
./my-app --data-dir
```

Or `BROAPP_DATA_DIR` to put it elsewhere. Never beside the executable.

### macOS: "cannot be opened because the developer cannot be verified"

Gatekeeper on an unsigned binary. For your own build:

```bash
xattr -d com.apple.quarantine ./my-app
```

For distribution, sign and notarise — [packaging.md](packaging.md).

### Windows: "Windows protected your PC"

SmartScreen on an unsigned executable. **More info** → **Run anyway**. For
distribution you need a code-signing certificate; the reputation trade-offs are
in [packaging.md](packaging.md).

### Linux: "permission denied"

`chmod +x ./my-app`. Zip archives do not preserve the executable bit; use
`.tar.gz`.

### The binary will not start on an older Linux

glibc. Build on the oldest distribution you support, or ship the
`linux-x64-musl` target.

## Operations

### "The application could not complete that operation."

An unexpected failure, deliberately redacted. The real error with its stack is
on the **host's terminal**, prefixed `[broapp]`. If the message should have been
shown to the user, raise a `PublicError` instead —
[host-operations.md](host-operations.md).

### An operation rejects with `invalid_input` and I think the input is fine

The message names the failing field and the constraint. Common causes: a number
that should be an integer, a string outside its length bounds, or a property the
schema does not declare (unknown properties are dropped, so a typo in a key
shows up as the real key being missing).

### Cancel does not stop the host

Your handler is not checking `sink.signal.aborted`. Nothing preempts a tight
loop. Add a check at a natural checkpoint — [streaming.md](streaming.md).

### A stream stops delivering events

Either the host stopped emitting, or the consumer stopped reading and
backpressure stalled the producer. `emit` resolving slowly is the signal for the
second.

## Tests

### `Cannot find module '@brobridgejs/client'` in a test

The harness needs it directly. `bun add -D @brobridgejs/client ws`.

### A client in a test cannot authenticate

A test process has no cookie jar and cannot put a `Cookie` header on a
`WebSocket` upgrade. `connect()` takes injectable `fetch` and `socket` for
exactly this — [`tests/harness.ts`](../tests/harness.ts) has a working one.
