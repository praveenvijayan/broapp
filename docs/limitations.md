# Scope and limitations

What Broapp does not do, stated plainly.

## Not in v1

**No hot module replacement.** Getting it would mean serving the application
from an unauthenticated origin, which would make the development build stop
resembling the shipped one exactly where it matters. `broapp dev` rebuilds and
restarts. See [development.md](development.md).

**No self-updating.** An updater that fetches and executes code needs signature
verification, rollback, and a trustworthy channel. A bad one is worse than none,
so there is not one.

**No daemonisation or service installation.** `--background` is a foreground
process that outlives the tab. Broapp will not write a `launchd` plist or a
systemd unit behind your back; write one yourself if you want supervision.

**No framework choice.** React + TypeScript, one template. A menu of frameworks
would multiply the surface to test for very little gain at this stage.

**No LAN access.** The host binds loopback and Brobridge's `allowNonLoopback` is
not forwarded, so a Broapp application cannot grow network exposure through a
configuration change. Reaching one across a network is what SSH tunnels are for.

**No native OS integration.** No menu bar, no tray icon, no dock presence, no
file associations, no global shortcuts, no native dialogs. Your application is a
browser tab. See [comparison.md](comparison.md).

**No mobile.** Bun does not compile for iOS or Android.

## Things that are true and worth knowing

**Binaries are around 60 MB.** That is the Bun runtime. It does not depend much
on your code and it is not going to shrink.

**Cross-compiled binaries are untested by definition.** The build produces them;
running them is a separate act. Anything native — `bun:sqlite` included — is
where this bites.

**Loopback HTTP is not encrypted, and authentication is not a sandbox.** The
process runs with the user's permissions. See [security.md](security.md).

**There is no exactly-once execution across reconnects.** A call in flight when
the socket drops rejects and is not retried, because the host may have run it.
Make mutations idempotent if it matters.

**Restarting the host destroys every session.** No reconnect can restore one.
The interface says so rather than implying otherwise.

**Unary handlers do not know which tab called them.** Brobridge passes a session
id to stream handlers but not to exposed service methods, and Broapp does not
invent one. Use a stream if you need it.

**The UI must be one document.** Brobridge serves exactly `/`, `/ws` and `/rpc`.
No code splitting, no lazy chunks, no separate asset files. The build enforces
it.

**The bundled validator is small on purpose.** No unions of objects, no
transforms, no refinements, no async. Swap in Zod, Valibot or ArkType if you
need more; `defineContract` accepts anything with a `parse` method.

**The template's browser bundle is around 240 KB** unminified-in-place — mostly
React. Everything is inline, so that is one request and no waterfall, but it is
not tiny. A smaller UI library would shrink it substantially.

## Not published yet

`create-broapp` and `broapp` are not on npm, so `bun create broapp` does not
work. Generating from a checkout does. See [publishing.md](publishing.md).

## Verified on

Bun 1.4.0 on macOS 15 (`darwin-arm64`). The Linux and Windows targets compile
and are smoke-tested in CI where a runner exists; that is stated per-target in
the release output rather than assumed.

## Where this is the wrong tool

- You need a real application window, a menu bar, or OS integration → Electron
  or Tauri.
- Binary size is a headline concern → Tauri.
- You are building something that runs on a server → this is the wrong shape
  entirely; Broapp binds loopback by design.
- You want thirty seconds of scratch work on your own machine → a plain
  `Bun.serve()` is less to think about.
