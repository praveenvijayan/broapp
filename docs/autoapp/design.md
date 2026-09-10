# Autoapp

Autoapp turns a Broapp application into one its owner can reshape while using
it. An AI engineer, running in the host, proposes a change to the
application's specification and code; the change is built as a candidate
release, previewed against a copy of the user's data, and activated with a
recovery path. External agents reach the same operations over an MCP adapter,
through the same gate.

Everything is built on the existing Broapp packages. Brobridge is unchanged.
The single-document, hash-pinned-CSP page model is unchanged.

## The seven parts

**The launcher** is a Broapp application with the AI layer. It manages other
applications: it builds them, starts them, migrates their data and activates
their releases. It never runs an application's code in its own process, and it
never proxies an application's operations — it supervises lifecycle only. Its
own data directory, `ensureDataDir('broapp-autoapp')`, is called `<root>` here.

**An application child** is one `Bun.spawn`ed process per application, with its
own Brobridge bridge and its own top-level browser tab. There are no iframes,
because Brobridge's trust fence allows only `Sec-Fetch-Site: same-origin` or
`none`: a page on another loopback port cannot frame or fetch an application.

**Brobridge** is the transport, unchanged.

**The renderer** is a pinned React package, `broapp-autoapp/react`. The browser
never runs generated code. It runs the renderer over a declarative view
specification that contains no JavaScript expressions and no raw HTML.

**The application specification** is the description the engineer edits: routes,
data, views. Every route in it declares an `effect`; a route that does not is
refused. (Core Broapp is more forgiving, so that contracts written before
effects existed keep working: a missing effect there is treated as `write`.)

**The engineer** is the AI layer, running in the launcher's tab. It proposes
changes; it does not apply them.

**The gate** is below.

There are two ways an application comes to exist, and they meet after the first
step. `import <sourceDir> --as <appId>` copies a workspace somebody already
has. `create <appId>` — the **New application** button in the launcher's tab,
the `create` command, and the engineer's `apps.create` tool — writes out the
starter workspace the launcher carries inside its own binary. From there both
take the same steps, in `src/launcher/workspace.ts`: install, `git init`,
build, and then whatever the caller decides about capabilities. The starter is
an ordinary Autoapp source workspace with one table and five routes; once it is
on disk it is imported in every sense that matters, and every command and every
tool works on it.

## The gate

Every mutation of an application, from any channel, passes one gate:
`Gate.guard` in `broapp/host`. The bridge path, `HostApp.invoke`, stream
starts, AI tool calls, the MCP adapter and the workflow runner all go through
it. There is no second door.

A **channel** says who is asking: `user`, `ai`, `mcp` or `workflow`. It is set
by the trusted adapter that received the request — the bridge handler, the AI
runner, the MCP adapter, the workflow runner — and never read from model
output, tool arguments, or anything a browser or an MCP client sent. That is
the whole basis of the policy: a model cannot claim to be the user, because
nothing it can write is consulted when the channel is chosen.

An **effect** says what a route does. `read` changes nothing. `write` changes
data inside the application's data directory. `external` reaches outside it:
the network, other files, a spawned process, mail.

A **mode** is `live` or `preview`. A preview runs against a copy of the data.

The whole v1 policy is three rows and no configuration language:

| channel | `read` | `write` | `external` |
|---|---|---|---|
| `user` | allow | allow | allow (refused in preview) |
| `ai`, `mcp`, `workflow` | allow | confirm | confirm (refused in preview) |

`preview` refuses `external` for everybody, because a copy of the data is not a
copy of the world: a message sent from a preview is sent for real.

**Approval identity.** An approval binds to `{ requestId, appId, releaseId,
route, argumentsHash }`, where `argumentsHash` is sha256 of the arguments in
canonical JSON, hex, first 32 characters. It is consumed once and expires after
`confirmTimeoutMs`. An answer that names a different `releaseId` or
`argumentsHash` than the pending question is a mismatch and counts as a denial.
Without that binding, an answer meant for one call could approve another that
happened to be pending under the same identifier after a rebuild, or after a
model changed its arguments between the question and the click.

**How long a question waits.** 120 s for an application's own gate, 600 s for
the launcher's, because the engineer's questions arrive after minutes of a
model thinking. Both are in [security.md](security.md) under approvals.

**What the gate does not protect against.** It decides whether generated host
code is *asked to run*. It does not constrain what that code does once it is
running. See "Trusted local code" below.

## Release identity

`releaseId` is the sha256 of the built page bytes, the host bundle bytes and
the canonical JSON of the **whole application specification** with
`manifest.releaseId` and `manifest.createdAt` removed — hex, lowercase, first
32 characters. It is computed by the build, stored in the release manifest, and
reported by the child on `hello`. It covered only the page, the host and the
contract at first, which meant a change to views, migrations, acceptance
examples or capabilities alone did not change the identity: a person could add
an acceptance check that could never reach a release, and be told it was built.
A release directory written under the older rule is refused rather than
rehashed, because rehashing would assert its contents are what somebody
approved. A running application with no candidate loop has exactly one
release. An approval names a release, so an approval cannot survive a rebuild.

## The candidate-and-activation loop

1. The owner describes a change. The engineer proposes an edit to the
   application specification and to any host code the change needs.
2. The launcher writes the proposal into the candidate workspace,
   `<root>/apps/<appId>/source/`, which is a git repository.
3. A build produces an immutable release directory,
   `<root>/apps/<appId>/releases/<releaseId>/`: page, host bundle, spec.
4. The launcher takes a consistent snapshot of the live database (`VACUUM INTO`
   on an open connection — never a file copy while a connection may be writing)
   into `<root>/apps/<appId>/snapshots/`, and lays a copy down as
   `data-next/`.
5. The launcher asks a child of the candidate release to migrate `data-next/`
   and report. Migrations are forward only.
6. The candidate runs against `data-next/` in `preview` mode. Nothing external
   is allowed to happen; `runs.sqlite` lives inside the data directory, so a
   preview records into the copy and a live child into the real one.
7. The owner activates. The live directory becomes `data-prev-<timestamp>/`,
   `data-next/` becomes `data/`, and `<root>/apps/<appId>/current` names the new
   release. The switch is recorded in `<root>/journal.sqlite`.
8. The old child is drained and shut down; the new one is started.

## The rollback boundary

Before the new release has accepted a write, rolling back is a pair switch: the
previous data directory is still exactly what it was. After the new release has
accepted a write, that is no longer true, and there are only three honest
options: a compatible downgrade, a forward repair, or an explicitly approved
restore that discards the writes made since activation. The activation journal
records which of those the owner is in, so nobody has to guess.

## Trusted local code

Generated host code runs in a child process. That child is **trusted local
code**: crash-isolated, not permission-isolated. It runs with the owner's own
permissions and can do anything they can do. The gate decides whether it is
asked to run; it does not confine it once it is.

This is said plainly everywhere it appears, and the words "sandbox" and
"isolated" are not used for it, because both would promise a boundary that is
not there. What v1 offers instead is that nothing gets built without the owner
asking for it, nothing external happens in a preview, and every call that
changed anything is recorded against a release.

Generated *browser* code does not exist at all. The page runs the pinned
renderer over a declarative view specification, so a proposal cannot introduce
script into a page whose CSP is pinned to the hashes the build computed.

## Offline tiers

Three separate claims, in increasing order of difficulty. Each is now a case in
`tests/autoapp-offline.test.ts`, run on Linux, macOS and Windows.

| Tier | What holds | What it rests on |
|---|---|---|
| **Run offline** | An installed application's local features work with no network. | A built release resolves nothing at run time: every dependency is inlined into `host.js`, and the only specifiers left are `bun:sqlite` and Node builtins. The release serves with its whole source workspace deleted. |
| **Edit offline** | Source changes build and activate, using dependencies that are already installed. The engineer needs a model — a remote provider is unavailable offline, a local one (Ollama) works. | A per-application vendored `node_modules`, created once at `import`. |
| **Extend dependencies offline** | Refused, with the reason. | The build checks every declared dependency resolves before bundling, and names the one that does not. |

No flag prevents a socket from opening — Bun 1.4.0 has no `BUN_OFFLINE`,
`--offline` still downloads — so nothing here rests on one. The evidence, the
platform matrix and the Windows differences are in
[packaging.md](packaging.md); approvals, the control connection and what none of
this protects are in [security.md](security.md).

## Where the rest of it is written down

- [packaging.md](packaging.md) — the launcher binary, its targets and sizes,
  what is smoke-tested where, Windows, offline evidence, publishing.
- [security.md](security.md) — the gate, approvals and their windows, the
  control connection, MCP, attachment, the rollback boundary, what is deferred.
- [backlog.md](backlog.md) — what phase 1 left out on purpose, and what would
  have to be true before each item is worth doing.
