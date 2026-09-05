# Troubleshooting

Symptom, then cause, then fix.

## Install and scaffold

**`bun create broapp` cannot find the package.** Confirm the registry sees
it: `npm view create-broapp version`. Stale cache: `bun pm cache rm`. To use
an unreleased checkout: `bun run scripts/pack-local.ts` in the Broapp repo,
then `bunx --bun /path/to/broapp/packages/create-broapp/src/main.ts my-app`.

**`@brobridgejs/core@workspace:^ failed to resolve`.** Only `brobridge@0.2.0`
has this. Use `^0.2.1` and delete any `overrides` entry for
`@brobridgejs/core`.

**Generator refuses the directory.** It is not empty. Pick another or clear
it yourself. The generator never deletes.

## Development

**Browser did not open.** The URL is on the terminal. It works once. If
already used, restart for a fresh one. `--no-open` suppresses the launch;
`broapp dev` opens only on the first start.

**Tab says "Still reconnecting…" after a restart.** Expected. Sessions die
with the process. Reload with the URL printed on restart.

**403 on every request.** Trust fence or cookie. Reaching `localhost` when
it bound `127.0.0.1`; a redeemed token; a proxy or extension rewriting
`Host`/`Origin`. Use exactly the printed URL.

**404 on an asset.** No static route exists. Remove `<script src>` or
`<link href>` from `index.html`; everything is inlined.

**Build says the page loads from an off-origin URL.** A web font, CDN
script or remote image in a loading position. Inline it or use a `data:`
URI.

**Build says it expected exactly one JavaScript chunk.** A dynamic
`import()`. Make it static.

**Changes not picked up.** Only `src/` and the listed extensions are
watched. Restart `broapp dev` after editing `broapp.config.ts`.

**`Cannot find module '../../dist/ui.html'`.** The host imports the built
page. Run `bun run build` or `bun run build:page` first.

**Browser bundle fails on `node:fs` or `Bun.spawn`.** Something under
`src/ui` imports `src/host` or `broapp/host`. Move the shared piece into
`src/shared`.

## Running

**The application exits by itself.** Interactive mode: about 20 s after the
last tab detaches. Use `--background`. Exit status 1 saying no browser
connected: nothing used the launch URL inside the launch window.

**Exits during a long operation.** `isBusy` should block the idle timer.
Work that is not a stream needs its own condition wired into `isBusy`.

**Where is my data?** `./my-app --data-dir`. Override with
`BROAPP_DATA_DIR`.

**macOS "developer cannot be verified".** Gatekeeper. Own build:
`xattr -d com.apple.quarantine ./my-app`. Distribution: sign and notarise.

**Windows "protected your PC".** SmartScreen. More info, Run anyway. Sign
for distribution.

**Linux "permission denied".** `chmod +x`. Zip drops the bit; ship tar.gz.

**Will not start on older Linux.** glibc. Build on the oldest supported
distribution or ship `linux-x64-musl`.

## Operations

**"The application could not complete that operation."** An internal error,
redacted. The real one with its stack is on the host terminal, prefixed
`[broapp]`. If the user should see it, throw a `PublicError`.

**`invalid_input` but the input looks right.** The message names the field
and constraint. Common: non-integer where `int` required, string outside
bounds, a typo in a key (unknown keys are dropped, so the real key looks
missing).

**Cancel does not stop the host.** The handler never checks
`sink.signal.aborted`. Add a check inside the loop.

**Stream stops delivering.** Producer stopped emitting, or the consumer
stopped reading and backpressure stalled it. Slow `emit` resolution is the
tell for the second.

**Host refuses to start naming a route.** A route declared in the contract
has no `app.operation`/`app.stream`. Implement it or remove it from the
contract.

## Tests

**`Cannot find module '@brobridgejs/client'` in a test.**
`bun add -D @brobridgejs/client ws`.

**A test client cannot authenticate.** A test process has no cookie jar.
`connect()` takes injectable `fetch` and `socket`; the Broapp repository's
`tests/harness.ts` shows a working one. For most apps, unit-test the pure
host modules (database, containment) and leave transport tests upstream.
