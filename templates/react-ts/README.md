# __APP_TITLE__

__APP_DESCRIPTION__

This is a **local application**. It runs as a process on your computer and uses
your browser as its window. It listens on the loopback interface only, and
nothing it does requires an internet connection.

## Running it

```bash
bun install
bun run dev
```

> **Note on `overrides` in `package.json`.** `brobridge@0.2.0` was published with
> an unresolved `workspace:^` dependency specifier, which no package manager can
> resolve outside its own repository. The `overrides` entry supplies the missing
> range so the install succeeds. Remove it once a fixed `brobridge` is released.

`bun run dev` builds the interface, starts the host process, and opens your
browser. Leave it running; edit anything under `src/` and it rebuilds and
restarts. After a restart, reload the tab — the host mints a new session each
time it starts, so the old tab's session no longer exists.

If your browser does not open, the terminal prints an address. Paste it in.
That address carries a **one-time token**; treat it like a password until you
have used it, after which it stops working.

## Building an executable

```bash
bun run build
```

This writes a single self-contained executable into `release/`. It carries its
own interface and its own copy of the Bun runtime, so it runs on a machine with
no Bun installed and no source files nearby. It is around 60 MB — that is what
bundling a JavaScript runtime costs, and it is not going to get much smaller.

```bash
bun run build -- --target linux-x64        # one other platform
bun run build:all                          # every supported platform
```

Cross-compiled binaries are **built, not run**. Only a binary compiled for the
machine that built it has been executed by the build command. Test each target
on that target before you ship it.

## Where the code lives

```
src/shared/contract.ts    What the UI may ask the host to do. Both sides import this.
src/host/operations.ts    The implementations. Runs in the Bun process.
src/host/main.ts          Startup, command-line flags, lifecycle.
src/ui/                   React components and the browser entry point.
```

### Adding an operation

1. Declare it in `src/shared/contract.ts` with an input and an output schema.
2. Implement it in `src/host/operations.ts` with `app.operation(...)`.
3. Call it from a component with `useOperation("group.name")`.

The contract is the only thing the two sides share, so the compiler catches a
rename, a changed argument, or a handler you forgot to write — the host refuses
to start if a declared route has no implementation.

Streams work the same way, with `app.stream(...)` and `useStream(...)`. A stream
handler receives a `sink` with an `emit` and an `AbortSignal`; check the signal
in any long loop, or cancellation will not reach it.

## Command-line flags

```
--background     Keep running after the browser tab closes.
--no-open        Print the address instead of opening a browser.
--data-dir       Print where this application stores data, then exit.
--version, -v
--help, -h
```

By default the application is **interactive**: it exits shortly after the last
browser tab closes, unless work is still running. `--background` keeps it alive
until you stop it with Ctrl+C.

## Where your data goes

Run `<app> --data-dir` to see the exact path. It is a per-user directory outside
the executable —

- macOS: `~/Library/Application Support/<name>`
- Linux: `$XDG_DATA_HOME/<name>`, or `~/.local/share/<name>`
- Windows: `%APPDATA%\<name>`

Set `BROAPP_DATA_DIR` to override it. Replacing the executable does not touch
this directory, so an update keeps your data.

## What the security model does and does not cover

The host binds `127.0.0.1`. Every request must present a session cookie that the
host minted from a one-time launch token, and must arrive with a `Host` and
`Origin` the host recognises. Another website in your browser cannot reach it.
All of that is [Brobridge](https://github.com/praveenvijayan/brobridge), used
unchanged.

What that does **not** mean:

- **Loopback HTTP is not encrypted.** It is not exposed to the network, but it
  is not TLS either.
- **Authentication is not a sandbox.** This process runs with your permissions
  and can do anything you can do.
- **A compromised frontend has your session.** Code running in the page can call
  every operation the page can call. Validate input, and expose only operations
  you would be comfortable with any of that page's code invoking.
- **Local malware is out of scope.** Another process running as you can read
  this application's data directory.

Never add a shell-execution operation or an unrestricted file-reading operation
to a contract. Those are the two that turn a local application into a remote
code execution vector the moment anything else goes wrong.

---

Built with [Broapp](https://github.com/praveenvijayan/broapp) on
[Bun](https://bun.sh) and [Brobridge](https://github.com/praveenvijayan/brobridge).
