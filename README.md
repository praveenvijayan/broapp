# Broapp

**Scaffold a local application: a Bun process that serves a browser UI over an
authenticated loopback connection, and compiles to one executable.**

```bash
bun create broapp my-app
cd my-app
bun run dev
```

You get a working application: a typed call to the host, a cancellable progress
stream, honest connection states, and `bun run build` producing a single file
that runs on a machine with no Bun installed.

![One loop of a Broapp application: the tab redeems a one-time token at the trust fence and gets a session cookie, fetches the single embedded document, calls a typed operation and gets its result; a request from another origin is refused at the fence with 403.](diagrams/broapp-loop.svg)

## This pattern is not new

Compiling a Bun host with `bun build --compile`, embedding a web interface,
starting a local server and opening the browser is an established way to build
desktop-shaped software. [glitchedit](https://github.com/HelgeSverre/glitchedit),
[ingit](https://github.com/capaj/ingit) and
[bun-webui](https://github.com/webui-dev/bun-webui) all do it, and
[brolog](https://github.com/praveenvijayan/brolog) does it over Brobridge.

Broapp did not invent it.

## What Broapp contributes

The reusable developer experience around the pattern:

- **A generator.** `bun create broapp` scaffolds a working application, refuses unsafe destinations and never overwrites your files.
- **One development command.** `bun run dev` rebuilds and restarts the host without spawning a tab per save.
- **A typed contract.** One table of operations and streams that host and browser both import, validated on the host.
- **A build that enforces its own guarantees.** The interface is embedded as one document, with a hash-pinned content-security policy and a check that nothing loads off-origin.
- **A lifecycle with documented shutdown.** Two explicit modes, attachment tracked from the session hook, and real shutdown behaviour.
- **A release pipeline.** Six compilation targets, native smoke tests where a runner exists, and cross-compiled binaries labelled as such.
- **An optional AI layer.** Host-only and provider-independent: settings, key storage, context, tools derived from your contract, and a confirmation step before anything changes. Off until a user sets it up.

- **An optional launcher.** [Autoapp](docs/autoapp/README.md) is a separate
  package that supervises applications, previews a proposed change on a copy of
  your data, and activates it with a recovery path — so an application can be
  reshaped by its owner while they use it. A candidate release runs as
  **trusted local code**: crash isolated in its own child process, not
  permission isolated from you.

The security-sensitive parts — the trust fence, the one-time launch token, the
session cookie, the framing, resume — are
[Brobridge](https://github.com/praveenvijayan/brobridge), used unchanged.

## Download the launcher

Every [release](https://github.com/praveenvijayan/broapp/releases) ships the
Autoapp launcher as one compiled binary per target, `broapp-autoapp-<target>`.
No Bun installation is needed on the machine that runs it; the launcher
carries a starter application inside it.

```bash
curl -fsSL https://github.com/praveenvijayan/broapp/releases/latest/download/broapp-autoapp-darwin-arm64.tar.gz | tar xz
./broapp-autoapp-darwin-arm64
```

Download it from a terminal, as above, and macOS runs it. Download it with a
browser and macOS tags the file as quarantined; because the binary is not
signed with an Apple developer identity, Gatekeeper then reports it as
"damaged" and offers only the bin. It is not damaged. Remove the tag and it
runs:

```bash
xattr -d com.apple.quarantine broapp-autoapp-darwin-arm64
```

Windows shows SmartScreen's "protected your PC" for the same reason; choose
*More info*, then *Run anyway*. Signing and notarisation are the fix, and they
are in the backlog.

The launcher opens its own tab. Press **New application**, give it a name, and
it writes the starter to disk, installs its dependencies from npm — the one
time the launcher reaches the network — builds the first release, makes it
current and opens it. From then on the engineer in the launcher's tab proposes
changes as candidate releases; `create <appId>` does the same from a terminal.

The release also ships `notes-starter.zip`, the Notes example with its AI panel
and its dependencies pointed at the published packages, for a fuller starting
point:

```bash
unzip notes-starter.zip
./broapp-autoapp-darwin-arm64 import ./notes-starter --as notes --grant
./broapp-autoapp-darwin-arm64 serve notes
```

The binaries are unsigned; on macOS remove the quarantine
attribute first (`xattr -d com.apple.quarantine <binary>`), and see
[docs/packaging.md](docs/packaging.md) for Windows.

## What is in here

| Path | What it is |
| --- | --- |
| `packages/create-broapp` | The generator. `bun create broapp` runs this. |
| `packages/broapp` | Runtime and build tooling. Generated projects depend on it. |
| `packages/broapp-ai-anthropic` | Anthropic provider for the AI layer. |
| `packages/broapp-ai-compatible` | OpenAI, Ollama and any OpenAI-compatible server. |
| `packages/broapp-ai-elements` | Optional chat panel: AI SDK `useChat` and Vercel AI Elements. |
| `packages/broapp-autoapp` | Optional: the Autoapp launcher, renderer and engineer. |
| `templates/react-ts` | The canonical template. React + TypeScript, ordinary CSS. |
| `examples/dashboard` | Streaming system metrics; independent streams and reconnect. |
| `examples/file-processor` | Progress and cancellation, inside an authorized directory. |
| `examples/notes` | SQLite, schema versioning, backups. |
| `docs/` | Architecture, security, packaging, and the guides. |

The examples are generated by the same generator a user runs, and use only the
same published tooling. That is deliberate: an example built by hand stops
testing whether the tooling is enough.

## How an application is shaped

```
src/shared/contract.ts    What the UI may ask the host to do. Both sides import it.
src/host/                 The implementations, and startup.
src/host/ai.ts            Optional: which providers, what the model may read and do.
src/ui/                   React components and the browser entry point.
```

The contract is the only thing the two sides share. It holds schemas, not code,
so the browser bundle can follow it without dragging the host in — and the build
fails if browser code ever imports from `src/host`.

Adding an operation is three steps: declare it, implement it, call it. The host
refuses to start if a declared route has no implementation, so a half-finished
operation fails at startup rather than under a user's click.

```ts
// src/shared/contract.ts
'notes.rename': {
  input: s.object({ id: s.number({ int: true }), title: s.string({ min: 1, max: 200 }) }),
  output: s.object({ ok: s.boolean() }),
},

// src/host/operations.ts
app.operation('notes.rename', ({ id, title }) => ({ ok: store.rename(id, title) }));

// src/ui/SomeComponent.tsx
const rename = useOperation<AppContract, 'notes.rename'>('notes.rename');
```

## What it does not do

- **It is not a security audit.** Brobridge's threat model is documented and
  Broapp preserves its defaults; neither has been independently audited, and
  this project does not claim otherwise.
- **It does not make small binaries.** A compiled application is around 60 MB,
  because it contains the Bun runtime, plus about 7 MB if it turns on the AI
  layer. See [packaging](docs/packaging.md).
- **It has no hot module replacement.** Achieving it would mean serving the
  application from an unauthenticated origin. `broapp dev` rebuilds and restarts
  instead, and [says why](docs/development.md).
- **It does not cross-compile your native dependencies.** `bun build --compile`
  produces a binary for another platform; it does not run it. Broapp's tooling
  and CI keep "built" and "smoke-tested" separate.

## Documentation

Browsable at **<https://praveenvijayan.github.io/broapp/>**, generated from the
files below so the two cannot drift.

- [Architecture](docs/architecture.md) — how the pieces fit, and why.
- [Security model](docs/security.md) — what is protected, and what is not.
- [Adding a host operation](docs/host-operations.md)
- [Streaming and cancellation](docs/streaming.md)
- [Development and production lifecycle](docs/lifecycle.md)
- [Development workflow](docs/development.md)
- [Packaging and release](docs/packaging.md)
- [The AI layer](docs/ai.md) — turning it on, what the model is told, what leaves the machine.
- [Comparison with Electron, Tauri, and a plain local server](docs/comparison.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Scope and limitations](docs/limitations.md)
- [Contributing](CONTRIBUTING.md)

## Using Broapp from an AI agent

The repository ships an [Agent Skill](https://agentskills.io) in
[`skills/broapp`](skills/broapp/SKILL.md): the workflow, the rules, and the
reference material an agent needs to scaffold, extend, verify and ship a
Broapp application. It follows the open SKILL.md format, so it installs into
Claude Code, Codex, Cursor, Cline, Copilot, OpenCode and the other agents the
[skills CLI](https://skills.sh) supports:

```bash
npx skills add praveenvijayan/broapp
```

The skill is plain Markdown plus one shell script. Read it before trusting
it, as with anything an agent will follow.

## Requirements

Bun 1.2 or newer. Verified on Bun 1.4.0. No other runtime is required, at
development time or afterwards.

## Status

Version 0.4.20: an application's project where you keep your projects. The
New application form has a **Where it lives** field: left alone, nothing
changes; with a folder chosen — from the system's own folder window, or typed —
the source workspace is made at `<folder>/<id>`, and the form says where before
Create is pressed. Only the source moves: releases, data and snapshots stay with
the launcher. A workspace that later goes missing — renamed, deleted, on a drive
that is not connected — is said in one sentence on its row, is never recreated,
and never stops the application opening; it comes back by itself when the folder
does, or through **Locate…** when it moved. Removing an application leaves a
chosen workspace where it is. From the command line: `create --at <dir>` and
`locate <appId> <dir>`. A model cannot choose a location. Launcher only:
`broapp-autoapp` 0.3.19. Before it, 0.4.19: a model list that does not wait for
its slowest provider.
Listing gives each provider five seconds, and no longer. One that does not
answer in time gives the list it gave last, marked `listed earlier` and when,
and its models can still be chosen. A provider that answered in the last
thirty seconds is not asked again, so three panels opening is one request;
Refresh always asks. What is kept is in memory only, and is dropped when the
provider's address or key changes or it is turned off. Three packages:
`broapp` 0.4.8, additive (`ai.modelsRefresh`, a `reason` on a provider under
the list); `broapp-ai-elements` 0.4.8, for the picker's heading and line; and
`broapp-autoapp` 0.3.18, which depends on both. Before it, 0.4.18: more than
one model source at once. Every provider keeps its
own address, model and key, and is either turned on or never contacted. A
model written `<provider>:<model>` runs on that provider from a conversation,
a task or a tier, so light work can stay on Ollama while deep work goes to a
hosted model, and nothing falls back from one provider to another. Settings
holds a section per provider with its own test and switch; the model list is
every turned-on provider's, read at once, and one that cannot be reached costs
its own group and says why; wherever a model is chosen or named it says `on
this computer` or `sent to` its provider. OpenRouter has a preset of its own.
Four packages: `broapp` 0.4.7, additive; `broapp-ai-compatible` 0.4.2, for the
preset; `broapp-ai-elements` 0.4.7, for the picker; and `broapp-autoapp`
0.3.17, which depended on all three. Before it, 0.4.17: Settings is one set of
controls. The AI settings panel draws
itself whole in any application: one height, corner and border for a field, a
select and a button, "Required" or "Saved" beside the label, a saved key shown
as its last characters with Replace and Remove, a switch for remembering it,
and a full-width connection test. The launcher's Log, Knowledge, Backlog and
Settings panels share one header, and the panel's lengths follow the
renderer's control tokens, so a preset moves both. The vocabulary is written
down in `docs/autoapp/components.md` for the next component. Two packages:
`broapp` 0.4.6, for the panel and `ai.css`, and `broapp-autoapp` 0.3.16, which
depended on it. Before it, 0.4.16: the launcher opens on what needs you. An
Overview, the first
screen and a view beside the chat, says what is waiting for you, which task is
running and at what stage with its limits, what the day has cost as far as it
is known, what is left, and what each application is doing, each with the one
action that opens where it is decided. Every turn now leaves a usage row,
partial when it was cut short; prices are a file you write, and a model
without one shows tokens and never a cost. Six events can raise a
notification, the ones that need you with a short generated sound, and
permission is asked only by a click. A preview that cannot start says why, to
the builder and to you, and a plan no longer sends you to try an `external`
route in a preview, which refuses it. Two packages: `broapp` 0.4.5, for a
running turn's usage and the model a turn ran on, both additive, and
`broapp-autoapp` 0.3.15, which depended on it. Before it, 0.4.15: a completed
task means it. An acceptance example can say a
value's kind (`{"$is": "number"}`) and that a route refuses (`fails`), and
activation runs the examples where the preview ran them, on a copy that is
thrown away, so an example that writes passes both. A step refuses a key it
does not know, naming the one that was meant; a finished task's example is
held by what it says, so a later task cannot keep its id and weaken it; the
valid input shown to a refused builder is one that would really run; a
backlog turn refused four times for the same reason is ended; a turn too long
to give back whole gives its newest calls; and the evaluation counts an edit
when it lands and tokens only when they are known. Two packages: `broapp`
0.4.4, for a cut-short turn's partial usage and the history expansion, both
additive, and `broapp-autoapp` 0.3.14, which depended on it. Before it, 0.4.14:
a wider Backlog panel, tasks beside the request's analysis, and a task row
whose model select stays on its row; one package, `broapp-autoapp` 0.3.13.
Before it, 0.4.13: a failed task says why, and the launcher can be stopped. A
task whose builds were refused names the tool, the count and the error, to
the person, the advice and the next attempt; a turn that ends with unbuilt
edits is built once by the host; `broapp-autoapp stop` and `status`, a
**Quit** in the panel, and children that exit when their launcher is gone.
`broapp-ai-anthropic` and `create-broapp` stay at 0.4.1.
Earlier: 0.4.12, a backlog. The engineer restates a request, checks it against
the application's real routes and pages, and splits it into tasks a person
reviews in a Backlog panel; **Run** builds each task as its own turn on the
model chosen for it, the host marking a task completed only when a verified
build passes an example for every criterion, and nothing is activated. A
retry, or a task resumed after a stop, is told what earlier attempts changed
and how they ended; a turn the provider killed costs no attempt. Every
launcher-served application has a way back to the panel. Before it: 0.4.11 (the Knowledge
panel), 0.4.10 (the log in the
tab), 0.4.9 (approving a change cycle
works), 0.4.8 (the host keeps each turn's tool
calls and results and gives them back on "continue"), 0.4.7 (`.DS_Store`, expired
questions, the waiting strip), 0.4.6 (the running mark), 0.4.5 (remove to
trash, the blank template, the `design` topic), 0.4.4 (the banner), 0.4.3
(the theme contract and the first rendered check), 0.4.2, 0.4.1 and 0.4.0
(the knowledge loop), all on 2026-09-11 and 12.

## Licence

MIT.
