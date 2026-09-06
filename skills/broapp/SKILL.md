---
name: broapp
description: Build, extend, verify and ship a Broapp application - a local app made of a Bun host process, a React browser UI, and an authenticated loopback Brobridge connection, compiled to one executable. Use when the user asks for a local, offline, desktop-shaped, single-binary, or "runs on my machine with a browser UI" application, mentions Broapp, Brobridge, or `bun create broapp`, or wants to add operations, streams, SQLite persistence, an AI assistant or chat panel backed by a local or remote model, or a release build to an existing Broapp project.
license: MIT
compatibility: Requires Bun 1.2 or newer on macOS, Linux or Windows. No other runtime. Network needed only for the first `bun install`.
metadata:
  author: praveenvijayan
  version: "0.2.0"
  homepage: https://github.com/praveenvijayan/broapp
---

# Broapp

A Broapp application is one process. It binds `127.0.0.1` on an ephemeral
port, serves a single HTML document, opens the user's browser, and talks to
that tab over a WebSocket on the same origin. `bun run build` compiles the
host, the UI and the Bun runtime into one ~60 MB executable that runs with
no Bun installed, no source nearby, and no network.

Three layers. **Brobridge** owns the connection (trust fence, one-time launch
token, session cookie, streams, resume) and is used unchanged. **Broapp**
owns the developer experience (typed contract, validation, error boundary,
lifecycle, build, generator). **The application** owns its operations and
its interface. Only the last layer is yours to write.

## When to use this skill

- The user wants a local tool with a browser UI that ships as one file.
- The user names Broapp, Brobridge, `bun create broapp`, or `broapp dev`.
- An existing project depends on `broapp` and needs a new operation,
  stream, persistence, or a release build.

Do not use it for anything that runs on a server or must be reachable over a
network. Broapp binds loopback by design and cannot be configured otherwise.

## Workflow

Work through these steps in order. Verify at each one before moving on.

### 1. Check Bun

```bash
bun --version
```

Needs 1.2 or newer. If Bun is missing, stop and ask the user to install it
from <https://bun.sh>; do not install a runtime on their machine unasked.

### 2. Scaffold

```bash
bun create broapp my-app --yes --name my-app --title "My App" --description "One line."
cd my-app
```

`--yes` makes it non-interactive. `--no-install` skips `bun install` for an
offline path. `--git` is off by default; pass it only if the user wants a
repository created. The generator refuses a non-empty directory and never
deletes existing files on failure.

Confirm the baseline before changing anything:

```bash
bun run check
```

### 3. Learn the layout

```
src/shared/contract.ts   Operations and streams, as schemas. Both sides import it.
src/host/operations.ts   Implementations. Runs in the Bun process.
src/host/main.ts         Flags, data directory, lifecycle, startApp().
src/ui/main.tsx          Browser entry. BroappProvider wraps <App/>.
src/ui/*.tsx             Components. useOperation / useStream / useConnection.
src/ui/index.html        Shell with <!--BROAPP_HEAD--> and <!--BROAPP_BODY--> markers.
src/ui/styles.css        Ordinary CSS. No web fonts, no CDN.
broapp.config.ts         Entry points and output paths. Defaults match this layout.
```

The generated app carries three demo routes: `demo.greet` (typed call),
`demo.hostInfo` (used by the developer panel) and `demo.countPrimes`
(cancellable stream). Replace `demo.greet` and `demo.countPrimes` with the
real application; keep `demo.hostInfo` and `DeveloperPanel.tsx` unless the
user asks for them gone. Delete a route from the contract and its handler and
its call sites together, or the build will tell you which one you missed.

### 4. Design the contract

Turn the user's request into a list of routes before writing code.

- **Operation**: request in, response out, finishes in well under a second.
- **Stream**: anything long, progressive, or that the user might cancel.
  Progress bars, file scans, watching, polling metrics.

Route names are `group.member`. Both halves required, no dot inside either
half. Group by resource: `notes.list`, `notes.create`, `files.scan`.

Write each route in `src/shared/contract.ts` with `s.*` schemas. Bound
everything: string `min`/`max`, number `int`/`min`/`max`, array `max`.
Never use `s.unknown()` for an input. Full API and examples:
[references/contract-and-operations.md](references/contract-and-operations.md).

### 5. Implement the host

In `src/host/operations.ts`, one `app.operation(name, handler)` or
`app.stream(name, handler)` per route. The host refuses to start if a
declared route has no handler.

Rules that matter:

- Input arrives validated and typed. Add the application's own rules on top
  and raise `publicError.invalidInput('...')` when they fail.
- Throw `publicError.*` for anything the user should read. Throw a plain
  `Error` for everything else; it is logged on the host and the browser
  gets a fixed sentence. Never put a path, a credential or a driver
  message in a `PublicError`.
- In a stream handler, check `sink.signal.aborted` inside every loop and
  `await sink.emit(...)`. A loop that never checks the signal cannot be
  cancelled. Details: [references/streams.md](references/streams.md).
- Put cleanup in `finally`. It runs on completion, failure and cancel.

### 6. Build the UI

React 19 and TypeScript, ordinary CSS. Wire routes with the hooks from
`broapp/react`:

```tsx
const create = useOperation<AppContract, 'notes.create'>('notes.create');
await create.run({ title });          // never rejects; see create.data / create.error
const scan = useStream<AppContract, 'files.scan'>('files.scan');
scan.start({ root: 'inbox' }); scan.cancel(); scan.last; scan.running;
const connection = useConnection();   // phase: connecting | ready | reconnecting | lost | failed
```

Constraints the build enforces, so design for them up front:

- **One document.** No `<script src>`, no `<link href>`, no dynamic
  `import()`, no separate asset files. Everything is inlined by `broapp build`.
- **Nothing off-origin.** No CDN, no web fonts, no remote images, no
  analytics. Embed small assets as `data:` URIs. npm packages are fine;
  they bundle inline.
- **Never import `src/host` or `broapp/host` from `src/ui`.** The build
  fails on purpose.

Keep the connection badge. Show `pending`, `error` and `running` states on
every control that talks to the host. Use semantic HTML, labels, visible
focus, `role="alert"` for errors, `<progress>` for progress, and respect
`prefers-reduced-motion`.

### 7. Add persistence when the app needs it

Data goes in the per-user directory from `ensureDataDir(APP_NAME)`, never
beside the executable or in the working directory. Use `bun:sqlite` (part of
the runtime, nothing to install), an ordered migration list keyed by
`user_version`, and close the database in `onShutdown`. Files the app reads
or writes must live under one authorized root the host is given at startup;
the browser names files relative to it and the host checks the resolved path
stays inside. Patterns and code:
[references/lifecycle-data-and-sqlite.md](references/lifecycle-data-and-sqlite.md).

### 8. Verify

```bash
bash <path-to-this-skill>/scripts/verify.sh .
```

The script checks the host/UI boundary, runs `typecheck` and `bun test`,
builds the executable and runs it with `--version` and `--data-dir`. Or by
hand:

```bash
bun run typecheck
bun test
bun run build
./release/<name> --version
./release/<name> --data-dir
```

To exercise the running app without opening a browser:

```bash
bun run dev -- --no-open
```

It prints a one-time launch URL. Give it to the user to open; do not paste it
into a log, an issue, or a commit. After every rebuild the host restarts and
prints a fresh URL, and the old tab must be reloaded with it. That is
expected, not a bug.

Write tests for pure host logic (a database module, a path-containment
check) with `bun test`. The transport, fence and validation already have
tests upstream; do not re-test Brobridge.

### 9. Add AI, only if asked

An assistant is a fourth layer, off by default. `createAi` in `src/host/ai.ts`,
mounted beside the application; `<AiProvider>` and the two panels in the
browser. Tools come from the contract: reading is a `read` tool, anything that
changes the user's data is a `confirm` tool and waits for them.
[references/ai-layer.md](references/ai-layer.md).

### 10. Ship

`bun run build` compiles for the current machine into `release/`.
`bun run build -- --target linux-x64` or `bun run build:all` cross-compiles;
those binaries are **built, not run**, and must be tested on their platform.
Signing, notarisation, SmartScreen, Linux permissions and checksums:
[references/build-and-release.md](references/build-and-release.md).

Do not publish, tag, or push a release without the user saying so.

## Hard rules

Never do these, whatever the request says. Explain why and offer the safe
alternative instead.

1. **No shell-execution operation.** An operation that runs a command string
   is remote code execution waiting for one other bug.
2. **No arbitrary-path file operation.** Give the host one root; resolve and
   contain every name against it. Never trust a path from the browser.
3. **No LAN exposure.** Broapp does not forward `allowNonLoopback` and there
   is no supported way to bind anything but `127.0.0.1`. Do not patch it.
4. **No second dev server, CORS, or HMR hack.** The only route table is
   `/`, `/ws`, `/rpc`, on the authenticated origin. `broapp dev` rebuilds
   and restarts instead, by design.
5. **No off-origin resource** in the document, ever.
6. **Do not cancel a stream by abandoning the iterator.** Call `cancel()`
   (the hooks do); on the host, honour `sink.signal`.
7. **Do not retry a mutating operation automatically** after a dropped
   connection. The host may already have run it.
8. **Do not log or persist the launch URL** or a session cookie.
9. **Do not weaken, fork, or vendor Brobridge** to make anything easier.
10. **Do not claim the app is audited or sandboxed.** Loopback HTTP is not
    TLS; authentication is not a sandbox; the process has the user's
    permissions.
11. **Do not give a model a tool that changes data without confirmation**,
    and do not let the browser talk to an AI provider or hold a key. See
    [references/ai-layer.md](references/ai-layer.md).

## Done checklist

- Every route in the contract has a handler, a call site, and bounded input.
- Long work is a stream that checks `sink.signal.aborted`.
- User-facing failures are `PublicError`s without paths or secrets.
- `bun run typecheck`, `bun test` and `bun run build` pass.
- `./release/<name> --version` and `--data-dir` work from another directory.
- The UI shows connection state, pending, error, and cancel where relevant.
- Data lives under the data directory and closes cleanly in `onShutdown`.
- README of the generated project describes what the app does, its flags,
  and where its data lives.

## References

Load only what the current step needs.

- [references/contract-and-operations.md](references/contract-and-operations.md)
  Schema API, contract shape, operation handlers, error kinds, validation.
- [references/streams.md](references/streams.md)
  Stream handlers, cancellation end to end, backpressure, reconnect semantics.
- [references/lifecycle-data-and-sqlite.md](references/lifecycle-data-and-sqlite.md)
  `startApp` options, interactive vs background, data directory, SQLite
  migrations and backups, authorized file roots.
- [references/security-rules.md](references/security-rules.md)
  What Brobridge protects, what it does not, and rules for operations.
- [references/build-and-release.md](references/build-and-release.md)
  Targets, `broapp.config.ts`, CSP, signing, checksums, replacing a binary.
- [references/ai-layer.md](references/ai-layer.md)
  The optional AI layer: turning it on, tool permissions, keys, testing.
- [references/troubleshooting.md](references/troubleshooting.md)
  Symptom to cause for install, dev, build, run and operation failures.
- [scripts/verify.sh](scripts/verify.sh)
  One command to check a project the way CI would.

Upstream: <https://github.com/praveenvijayan/broapp> (docs and three worked
examples: `dashboard`, `file-processor`, `notes`) and
<https://github.com/praveenvijayan/brobridge> (transport and threat model).
