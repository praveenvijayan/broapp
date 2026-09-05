# Lifecycle

## Two modes

**`interactive` — the default.** The process exists to serve a browser tab. When
the last tab has been gone for the grace period and no work is running, it
exits. This is what a user expects from something they launched by
double-clicking.

**`background`.** The process keeps running when the UI closes, and stops on
`Ctrl+C`, `SIGTERM`, or whatever supervises it. It is an ordinary foreground
process — Broapp does **not** daemonise and does **not** install a system
service. If you want it supervised, write a `launchd` plist or a systemd unit
yourself; Broapp will not do it behind your back.

```bash
my-app                # interactive
my-app --background   # background
BROAPP_LIFECYCLE=background my-app
```

```ts
await startApp({
  mode: 'interactive',
  idleGraceMs: 20_000,      // no attached tab for this long → exit
  launchTimeoutMs: 120_000, // no tab has *ever* connected → exit non-zero
  isBusy: () => app.activeStreams > 0,
  onShutdown: (reason) => { /* flush, close the database */ },
  // …
});
```

## What counts as "a browser is here"

Not "a session exists". Brobridge retains a session after its socket drops so a
reconnecting tab can resume its streams — so counting `bridge.sessions` would
keep an interactive host alive for a minute after the last tab closed.

Attachment is `endpoint.state === "open"`. Broapp counts sessions in that state,
which is what a live connection actually looks like.

The *first* attachment is recorded from Brobridge's own session hook, not by
polling. A tab that connects and closes inside one poll interval — a reload, a
quick script, a test — would otherwise never be seen to have attached, and the
host would exit reporting that no browser ever connected.

## Multiple tabs

Each tab is its own session. The host stays up while any of them is attached,
and exits once none is. Nothing about closing one tab disturbs another's
streams.

## When no browser ever connects

The host waits `launchTimeoutMs` (two minutes by default) and then exits with
status **1**. A launch nobody reached is a failure — the browser did not open,
or the user never pasted the URL — not a successful run that happened to be
short. Exiting quietly with 0 would leave a script unable to tell the difference.

The URL is always printed first, so a user whose browser did not open can still
use it.

## When work is running

`isBusy` outranks the idle timer. If it returns `true`, the grace period does not
start, however long the tab has been gone. Exiting there would silently discard
work in progress, which is the one thing the grace period exists to prevent.

The template wires `isBusy` to `app.activeStreams`. Add your own condition if you
have work that is not a stream — a queued write, a pending export.

## Shutdown

`SIGINT` and `SIGTERM` are handled, and both take the same path as a `stop()`:

1. Stop the idle poll and unregister the signal handlers.
2. Run `onShutdown(reason)` — flush, checkpoint, close the database. Failures
   here are logged and do not prevent the rest.
3. `bridge.close()`: send `GOAWAY`, end open streams, release the listener.
   Handlers observe this as their stream aborting, the same path a
   browser-initiated cancel takes.
4. Resolve `done` with the exit code.

`reason` is `signal`, `idle`, `never-connected`, or `requested`. Stopping twice
is harmless. A `register` callback that throws closes the bridge before
rethrowing, so a failed startup does not leave a listener behind.

**A stream in flight at shutdown is cancelled, not finished.** Handlers see
`sink.signal.aborted` and should stop. If you have work that must complete,
report it through `isBusy` so the idle path waits — but a `SIGTERM` will still
end it, because a process asked to stop should stop.

## Restarts destroy sessions

A session lives in the host's memory. Restart the process and every session is
gone: the old tab's cookie is for a host that no longer exists, and no reconnect
can restore it.

Broapp does not pretend otherwise. `broapp dev` opens the browser on the first
start only and, on every restart, prints a fresh launch URL for you to reload
with. The connection badge in the template says the same thing to a user once
the retention window has passed:

> Nothing has answered for a while, and work in progress can no longer be
> resumed. If you closed the application, start it again.

## Data

Resolved once at startup, outside the executable:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/<name>` |
| Linux | `$XDG_DATA_HOME/<name>`, else `~/.local/share/<name>` |
| Windows | `%APPDATA%\<name>` |

`BROAPP_DATA_DIR` overrides it, used verbatim. `<app> --data-dir` prints the
resolved path.

Not next to the executable, which may be on a read-only volume, and not in the
working directory, which would give one application two databases depending on
where it was launched from.

## Manual fallback

If the browser does not open, the URL is on the terminal. It carries a one-time
token — treat it as a password until you have used it, after which it stops
working. Broapp writes it to the terminal only; nothing puts it in a log file.
