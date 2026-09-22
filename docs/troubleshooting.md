# Troubleshooting

## Installation

### `error: @brobridgejs/core@workspace:^ failed to resolve`

Only `brobridge@0.2.0` has this defect. Raise the dependency to `^0.2.1`, which
publishes a real range, and delete any `"overrides": { "@brobridgejs/core": … }`
entry left over from the 0.2.0 workaround: an exact override pins the protocol
core below the server and client that need it.

### `bun create broapp` cannot find the package

Both packages are on npm, so first confirm the registry you are talking to can
see them: `npm view create-broapp version`. A private mirror that has not
synced, or a stale Bun cache (`bun pm cache rm`), are the usual causes.

To generate from an unreleased checkout instead of the published package:

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

### An application says its workspace cannot be found

An Autoapp application whose workspace was made in a folder you chose
(`create --at`, or the folder field of **New application**) keeps a pointer to
that folder, `<root>/apps/<appId>/location.json`. When the folder is not there
the application still opens and serves — its releases are in the launcher's own
folder — but nothing can change it: builds, the engineer's `source.*` tools and
backlog runs stop with a sentence that names the path. Four causes:

- **Moved or renamed.** Say where it went: **Locate…** on its row in the
  launcher's Applications list, or
  `broapp-autoapp locate <appId> <the workspace folder>`. The folder has to hold
  that application's `autoapp.json`. A folder renamed back shows as found the
  next time you switch to the launcher's tab.
- **Deleted.** Restore it from wherever you keep copies, to the same path or
  anywhere else followed by `locate`. The launcher never recreates it for you:
  an empty folder in its place would not be your project.
- **On a drive that is not connected.** Connect it. The next list, build or
  turn finds it; no restart is needed.
- **No permission** (macOS: a folder in Desktop, Documents or Downloads the
  launcher has not been allowed to use). Allow it in System Settings → Privacy &
  Security → Files and Folders, or move the folder and `locate` it.

A launcher root copied by hand carries its pointers, so the copy and the
original share every chosen workspace: a change made from one is a change to
the other's source.

### The folder window did not appear

**Choose a folder…** in **New application** (and **Locate…** on a row) asks
the operating system for its own folder window. While it is open the form says
"A folder window is open. It may be behind this one." Where it went:

- **Behind the browser.** On macOS the window belongs to `osascript`, which
  runs in the background; look behind the browser, or use Mission Control. The
  launcher does not reach for System Events to raise it, because that would ask
  you for an automation permission to save one click. A window nobody answers
  closes itself after five minutes, and pressing the button again meanwhile
  says one is already open.
- **Linux with no `zenity` or `kdialog`.** The launcher uses whichever is
  installed. With neither, the button is replaced by a **Folder** field.
- **A remote session.** Over SSH, or anywhere without `DISPLAY` or
  `WAYLAND_DISPLAY`, there is nowhere to draw a window, so the form offers the
  field.

In every case the answer is the typed path: **Type a path instead** (or the
field that replaced the button), and paste the folder's full path. Quotes that
Finder's and Explorer's "copy as path" put around it are taken off. The form
checks it as you type and says where the project will be made.

### The build was declined although I told the engineer to go ahead

A message in the conversation is not an answer. Every edit, build and preview
the engineer makes is a question the gate asks, and only the card answers it:
**Allow** on the card, before it expires (ten minutes). A card nobody answers
is a denial, which is why `candidate.cycle` came back declined while the
conversation said "proceed".

To stop being asked for these, press **Allow, and stop asking** on the next
card, or turn on **Work without asking** in the launcher's Settings, or run
`broapp-autoapp standing on`. Edits, builds and previews of any application are
then approved at once; activation, creating or removing an application, and
anything that reaches outside still ask. **Ask again** in the conversation's top
bar, the same switch, or `standing off` turns it back off.

### The engineer says it has no browser to read the web with

`web.search` and `web.read` run in `Bun.WebView`. On macOS that is the system
WebKit and nothing is needed. On Linux and Windows it drives a Chrome,
Chromium, Edge or Brave that is already installed: install one, or point
`BUN_CHROME_PATH` at its executable, and ask again. The two tools are always
in the engineer's list; only the answer changes.

### The engineer asked to read an address and the card said it was refused

`web.read` reads the internet only. An address on this machine (`localhost`,
`127.0.0.1`), on this network (`192.168.*`, a bare name like `printer`, a
`.local` name), a `file:` address or one with a password in it is refused
before any browser opens, whatever you answer on the card — the launcher and
every application listen on loopback, and a tool the model steers may not
reach them. If the page you wanted is public, give the engineer its public
address.

## AI

### "AI is not set up yet. Open Settings to choose a provider."

Exactly that. The application ships with no provider selected. Every AI route
except settings and the provider list answers this until the user picks a
provider and a model. In your own code it is `registry.resolve()` throwing
`unavailable`.

### "An API key is required for Anthropic." right after saving a key

The key is stored per provider, in that provider's own section under
**Providers**. Check that you saved it in the section of the provider that
needs it. `ai.settingsGet` reports `hasKey` and a `keyHint` for the provider in
use, and for every provider in `providers`.

### "Anthropic rejected the API key." / "Could not reach …"

The first is a 401 or 403 from the provider and means the key itself. The
second is a failed connection: for Ollama, confirm it is running and that the
server URL is `http://127.0.0.1:11434/v1` (with the `/v1`); for a remote
provider, confirm the machine is online. Test connection in the settings panel
lists models, which costs no tokens.

### The panel says data is sent to a provider, but I am using Ollama

`local` is computed from the server URL, not the provider name. A URL whose
host is not `127.0.0.1`, `localhost` or `::1` counts as remote, and so does
an OpenAI-compatible server on another machine, even on your own network.

### A provider's models are missing from the list

The model list holds only providers that are turned on in Settings: open the
provider under **Providers** and check **Offer this provider's models** (the
provider in use always is). A provider that is on but could not be read is
named under the list with its reason — "Could not reach Ollama (local)…" when
the server is not running, "An API key is required for …" when it has no key —
and the other providers' models are still shown. More than 1000 models
together are cut fairly between providers, and the one cut says "only the
first n models are shown".

A list waits five seconds for each provider, and no longer. A provider that
does not answer in that time reads "<provider> did not answer." If it gave a
list earlier, that list is shown in its place and can still be chosen from: its
heading ends "— listed earlier", and the line under the list says "These are
the models it listed earlier, at 21:12." A model in it may have gone since.
The earlier list is kept in memory only, and is dropped when the provider's
address or key changes, when the provider is turned off, and when the
application quits.

A provider that answered in the last thirty seconds is not asked again, so a
model added a moment ago may not show yet. **Refresh** always asks every
provider that is turned on, however recently it answered.

### "<provider> is not turned on in Settings."

A conversation, a task or a tier names a model of a provider that is off
(`openrouter:…`, `ollama:…`). Turn it on in Settings, or choose another model.
Nothing was sent.

### The key disappeared after a restart

"Remember key on this computer" was off, so the key lived in memory for that
run only. Turn it on to keep it in the application's data folder.

### A tool ran without asking

Only tools registered with `permission: 'read'` run without confirmation. Check
which list the route is in when you call `fromContract`. `confirm` tools emit a
`confirm` event and wait for `ai.chatConfirm` — [ai.md](ai.md).

### Usage shows 0 tokens on an OpenAI-compatible server

The server did not report usage in its stream. Broapp asks for it
(`includeUsage`), but not every server honours that.

## Tests

### `Cannot find module '@brobridgejs/client'` in a test

The harness needs it directly. `bun add -D @brobridgejs/client ws`.

### A client in a test cannot authenticate

A test process has no cookie jar and cannot put a `Cookie` header on a
`WebSocket` upgrade. `connect()` takes injectable `fetch` and `socket` for
exactly this — [`tests/harness.ts`](../tests/harness.ts) has a working one.
