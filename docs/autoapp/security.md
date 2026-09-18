# Autoapp: what is asked, and what is not protected

The design is in [design.md](design.md); Broapp's own security model is in
[../security.md](../security.md). This file is about the part a person meets:
which calls stop and ask, how an answer is bound to its question, how long they
have to give it, and what none of that covers.

## The one door

Every call that changes anything passes `Gate.guard`. The **channel** — `user`,
`ai`, `mcp` or `workflow` — is set by the trusted adapter that received the
request and is never read from model output, tool arguments, or anything a
browser or an MCP client sent. A model cannot claim to be the user because
nothing it can write is consulted when the channel is chosen.

`read` runs for anybody. A `write` or an `external` on any channel but `user`
stops and asks. A `preview` refuses `external` outright, for everybody: a copy
of the data is not a copy of the world.

## Opening a tab

An application's launch URL is a credential, and the launcher's page never
sees one. `appOpen`, `previewOpen` and a successful `activate` open the tab
from the host, through the operating system's browser opener, and answer only
whether that worked. This is not only tidiness. Brobridge's fence admits a
document request with `Sec-Fetch-Site: same-origin` or `none` and nothing else;
a `window.open` from the launcher's origin to an application's — same host,
another port — arrives as `same-site` and is refused with a `403`. A tab the
operating system opens arrives as `none`, the way the launcher's own does.

A launch token burns on its first presentation, so a second Open on a running
application goes to the bare origin and rides on the session cookie the first
one minted. A supervised child's token lives eight hours rather than
Brobridge's two-minute default: that default guards a URL in shell scrollback,
and a supervised child's is never printed. Without it, a preview or an
activated release that nobody clicked within two minutes could never be opened.

**One token per address.** Brobridge 0.2.2 lets a bridge hold more than one
live launch token, and every address is still single-use and loopback. A token
is minted by the host on its own decision and never on a browser's request:
for a person's click in a tab that is already authenticated, or for a local
process over the control connection. The bridge keeps at most eight live and
drops the oldest when a ninth is minted.

**Back to the panel.** An application the launcher serves draws an **Autoapp**
mark. Its click calls `autoapp.panel { mint: true }`, a route the child runtime
mounts beside the application's own; the child asks the launcher over IPC, and
the launcher mints a fresh address for its own tab and hands it to the
operating system's browser opener. The address never reaches the application's
page, for the reason above: a page on the application's port navigating to the
panel's port arrives `same-site` and would be refused. When no browser can be
opened the address goes to the launcher's terminal, and the page says so. A
launcher started with `serve <appId>` has no panel; the page's probe at load
hears `available: false` and draws no mark.

Creating an application ends the same way. `launcher.appCreate` is a `write`,
which on channel `user` is a person's own click, and it finishes by opening the
new application's tab through the same function `appOpen` uses — so the address
never reaches the page that asked for it. The engineer's `apps.create` is
`external`, because the one thing creation does that opening does not is fetch:
the starter's dependencies come from the registry, once, in the same install
`import` has always run. On channel `ai` that asks first, as a `write` would
have, and it opens nothing: a tool that reported a tab had opened would be
telling somebody about a screen that had not changed. Neither route returns a
path outside the launcher's root, and neither returns a URL.

Removing one is a person's action and only a person's. `launcher.appRemove` is
a `write`, and the person's own click is channel `user`; **there is no engineer
tool**, and there is not going to be one, because a model asking to delete
somebody's application is not a request this launcher relays. The route takes
the application's id twice — once as `appId` and once as `confirm`, typed into
a field beside a list of what will move — and a `confirm` that does not match
is `invalid_input` before anything happens. The `remove` command asks the same
question with `--yes`, and refuses first if a running launcher says over the
control connection that it is serving the application.

What an agent would see: nothing new to call. The MCP adapter offers an
application's own routes, not the launcher's, so `appRemove` is not reachable
from it at all; through a workflow it would arrive as a `write` on a channel
that asks. And nothing is deleted either way — the directory moves to
`<root>/trash/`, which the launcher never empties, so the worst outcome of a
removal that should not have happened is a directory in the wrong place.

## Approvals

An approval binds to `{ requestId, appId, releaseId, route, argumentsHash }`.
It is consumed once. An answer naming a different `releaseId` or
`argumentsHash` than the pending question is a mismatch and counts as a denial,
so an answer meant for one call cannot approve another that happened to be
pending under the same identifier after a rebuild, or after a model changed its
arguments between the question and the click.

**How long a question waits.** Two numbers, because two different people are
being asked two different kinds of question.

| Where | Window | Why |
|---|---|---|
| An application's own gate | **120 s** (`DEFAULT_CONFIRM_TIMEOUT_MS`) | The question comes from a workflow the person just started or an MCP call they are watching. They are at the keyboard. |
| The launcher's gate and its AI layer | **600 s** (`LAUNCHER_CONFIRM_TIMEOUT_MS`) | The engineer's questions arrive after minutes of a model composing a call. Report 08b measured seven to fourteen minutes of thinking followed by a two-minute window, and lost two of six edits to that arithmetic alone. |

The launcher passes the same 600 s to `createAi`, because the AI layer applies
a deadline of its own to a chat turn; a shorter one there would silently
undercut the gate's and the person would watch a countdown that was already
over.
A question nobody answers within the window is a denial to the gate; the
engineer is told the difference. A `rejected` that arrives no sooner than the
window is reported as "not answered within 10 minutes; nobody declined it",
so the engineer offers to run the step again rather than blaming the person,
and the launcher's tab shows a strip above the conversation, which scrolls
to the card, for as long as a question waits.

Every question carries `askedAt` and `expiresAt`, so the approvals strip and
the chat's confirm card show the time left and turn amber under a minute. The
launcher's tab also prefixes its title with the number of waiting questions and
raises a notification **only if permission was already granted** — it never asks
for permission, because a program that asks the moment it wants something is a
program people mute.

An unanswered question is a **denial**, not a pause. Nothing runs unattended.

## The control connection

The launcher listens on an ephemeral port on `127.0.0.1` so an MCP process can
reach a running application. `<root>/launcher.json` holds the port and a
32-byte hex secret, written atomically at mode `0600` and removed when the
launcher exits. A connection sends an auth line first or the socket closes; the
secret is compared with a constant-time equality, there is a two-second auth
deadline and a one-megabyte line cap.

The secret lives in the launcher process and in that file. It never crosses
IPC — the launcher authenticates the connection and forwards only
`{ route, input, client, requestId }` — and it is in no log, no run record and
no journal row.

**`panel`.** `broapp-autoapp open` against a launcher that is already running
asks it for a panel address with `{ type: "panel" }` instead of starting a
second launcher, and gets `{ ok: true, url }` or a refusal. This request hands
out a credential, and it is on the same terms as `invoke` on purpose: the secret
already reaches `invoke`, and through the launcher's routes `launcher.appOpen`,
which hands out an application's address, so a process holding it can already
have one. A panel address gives it nothing it could not reach. Each address
issued is written to the event log as "a panel address was issued to a local
process" (the address itself is not), and the launcher answers at most one
`panel` request per two seconds, refusing the rest `unavailable`. `serving`
still answers only whether, never where.

**On Windows the mode bits are not enforced.** The file's protection there is
the user profile directory's ACL. Anything that can read your profile can read
the secret, and with it can reach the applications this launcher is serving —
subject to the gate, which still asks the person in the tab for every write.

## MCP

`broapp-autoapp mcp <appId>` is a stdio MCP server. It reaches the application
the long way round — control connection to the launcher, IPC to the child, the
application's own gate at the end — because that is the only path that ends at
`Gate.guard` with a channel the caller did not choose. The `channel` is filled
in by the child, from the door the message came through; the client's name
becomes `caller`, which is a label and never a permission.

`read` and `write` operations are offered as tools. `external` ones are **not
offered at all** rather than offered and refused, because listing a tool that
always fails teaches an agent to keep trying. Tool annotations
(`readOnlyHint`, `destructiveHint`) are hints in the specification's own words:
a client that ignores every one of them gets the same answers, because the gate
is at the other end of the connection.

A write with no tab open is refused and says why — nobody could be asked. A
read still runs.

`autoapp.panel` is not an application route and is not offered as a tool. It
is refused with `rejected` on every channel but `user`, whatever its effect
says: an MCP client or a workflow asking for the panel is asking for a
credential, and a question to the person would not make that right. The refusal
is recorded by the application's gate like any other failed call.

## Attachment

An approval needs somebody to ask. `RunningApp.attached` is the same "is any
endpoint open" question the idle logic asks, and the routes that can only be
answered by a person are wrapped in `attachedOnly`. With no tab open, a `write`
from any channel but `user` is refused rather than queued.

## The rollback boundary

Migrations are forward only. What rollback means depends on one fact: whether
the new release has accepted a write.

- **Before the first write**, activation is a pair switch and going back is the
  same switch in reverse: `data` and `data-prev-<timestamp>` change places.
  Nothing is lost.
- **After the first write**, there are three honest options and no fourth: a
  compatible downgrade, a forward repair, or an explicitly approved restore
  that **discards the writes made since activation**. The activation journal
  records which of those the person is in.

No `data-prev-*` directory and no snapshot is ever removed by recovery. Deleting
them is a separate, explicit action that does not exist yet — see the backlog.

## Drafting a backlog is `read`

The engineer's three planning tools, `intent.open`, `intent.task` and
`intent.submit`, are `read`, so the gate asks nobody about them. A draft is the
engineer's proposal written down, as a transcript is: it changes no application
and no release, and nothing acts on it. It leaves `draft` only when a person on
channel `user` moves it, or when `intent.start`, which asks the person, does. The
three tools refuse with `conflict` once the intent is anything else.

What the classification rests on is that no draft row can cause an effect
without a person. The host adds one rule of its own on top: in a turn that
opened or changed an intent, `source.edit`, `source.change`, `candidate.build`
and `candidate.cycle` are refused before the gate is asked, so the person reads
the plan before any of it is built. The request stored is the message the tab
saw the person type, never the model's paraphrase, and whether the analysis
names anything the application has is checked by the host against the release
that is serving.

## A run answers for the person

Running a backlog (`intent.start` in the chat, **Run** in the panel) is agreeing
to one thing, and both places say it before anything starts: until the run
finishes or is stopped, edits, builds and previews of its application are
approved without asking; anything else is put to the person in the Backlog
panel and waits; activation is never approved this way.

- **What it approves itself.** The run's standing answer covers `source.edit`,
  `source.change`, `candidate.cycle`, `candidate.build`, `candidate.preview` and
  `preview.stop`, and only when the call names the run's own application. It is
  not a grant: `launcher.grants*` means capabilities, and nothing here changes
  what an application may do.
- **What it brings to the person.** Every other question — another tool that
  asks, an `external` tool, a listed tool naming a different application — is
  left in the approval table and shown at the top of the Backlog panel with
  **Approve** and **Deny**, which answer through the same `ai.chatConfirm` a chat's
  card uses. The turn waits. If the gate's window (ten minutes) passes
  unanswered, the run stops and the task is interrupted without costing an
  attempt.
- **What a builder can never do.** `release.activate` and `apps.create` are
  refused outright and never forwarded. Activation stays a person's click on a
  candidate they have looked at. A builder also may not plan, change the
  backlog, or start a run: the planning tools and `intent.start` refuse any turn
  whose run id starts `intent-`.
- **Every answer is still asked and recorded.** The gate asks every question
  and consumes each answer once, bound to its arguments, exactly as for a
  person. The core change behind this is small: an in-process turn's stand-in
  may answer `'defer'`, which leaves the question for somebody else, so no
  question is ever answered twice. The gate's record shows the caller as
  `ai:intent-<intentId>-<slug>-a<n>`, which names the intent and the task; it has
  no field for who answered, so the launcher's log carries one `log` event per
  answer: "the run's standing answer approved …", "the run refused …", or "the
  run put … to the person".
- **The code it builds is trusted local code**, as every candidate is: it runs
  on this machine with the application's permissions, and its preview uses a
  copy of the data. Nothing about a run contains it further.

While a run works on an application, tools that write to it from any other
turn, and `launcher.activate`, are refused with `conflict`, so two hands never
edit one workspace.

## What is recorded

Every gate decision — allowed, confirmed, denied, refused — is written to
`runs.sqlite` inside the application's own data directory, with the channel,
the caller, the release, the arguments hash and the outcome. A preview child
writes to the copy; a live child writes to the real one.

Secrets are never in a run record, a journal row, a log line or a
`PublicError` message. The launcher's control secret lives in the launcher
process and in `<root>/launcher.json` at mode `0600`, and never crosses IPC.

**The knowledge database.** `<root>/launcher/knowledge.sqlite` records what the
engineer did (see [learning.md](learning.md)). Its events hold sanitised text
and allow-listed fields only. Each event kind has a list of the fields it may
carry, and any field not on the list is dropped, not stored. Free text (a
message, a build problem, a check's detail, a person's request, an edit
summary) passes `sanitise()` first. `sanitise()` removes these patterns:

- a value after `api_key`, `secret`, `token`, `password` or `authorization`,
  including a `Bearer` or `Basic` scheme word
- a `Bearer` token
- an `sk-` provider key
- a hex run of 40 or more characters, or a base64-like run of 40 or more (a
  release id is exactly 32 hex characters and is kept)
- a URL's `user:pass@` and its query string, which is where a launch token is
- the home directory, which becomes `~`

It cannot catch a secret that looks like an ordinary word, or one split across
two fields. A launch URL is never recorded: no tool returns one, and a URL that
reaches a message loses its query. The control secret is never recorded.

What the log prints to the launcher's terminal is sanitised the same way as
what it writes, for every caller: its own warnings and errors, a supervised
child's stderr, and the line saying a write failed. The one exception is
`announce`, for a launch address a person has to open: printed whole, stored
without its query. A test holds its callers to the one line that opens a tab
when no browser can.

`contexts` is the exception, on purpose. It keeps the instructions, the system
prompt and each delivered document **verbatim**, because it is the record of
exactly what a model was sent, and a record that differs from it by one
substitution records something that did not happen. Everything in it was
already sent to the configured provider.

**Starting a preview again is a write.** `launcher.previewStart` copies the
application's data and starts the candidate's code in a child process, so it
is `effect: 'write'` and not a read. On channel `user` it is the person's own
click. `launcher.previewOpen` stays what it was: it opens a preview that is
already running, and refuses when there is none.

**What the engineer is served.** Each turn's orientation, task evidence and
lessons reach the model as documents, under the existing rule that documents are
data and instructions inside one are not instructions. Lessons and build hints
are facts; the method the engineer follows stays in its instructions, which are
the only trusted statement of how to work, and no served document repeats or
amends them. `source.search` is a `read` bounded to the workspace: it searches
only the files `source.list` would list, its `files` glob matches
workspace-relative paths, so a glob that climbs out matches nothing, and it
returns no path outside the workspace. Selecting an application
(`launcher.appSelect`) is a `write` because it changes what the next turn is
about; it stores only the id.

`source.search` compiles a model-supplied pattern, and JavaScript has no timeout
on a regular expression. It refuses a pattern over 200 characters and one that
repeats a group that already repeats (`(a+)+`), and tests each line against its
first 1,000 characters only. The symbol index behind the task evidence follows
no symbolic link and reads every file through the same containment check.

**The distiller.** Reads blobs only — what the case and the turn's `contexts`
row recorded — never a live file, and sends them to the configured provider,
which the turn itself was already sent. Its answer passes the same `sanitise()`
as everything else, and a lesson whose text names a path on this machine, an
address with a port, or anything the sanitiser would change is dropped. A
`method_unclear` lesson never enters a prompt: it is not served, not hinted,
and `knowledge.show` refuses it. Nothing the distiller writes changes a
lesson's status except superseding a provisional one; confirming and retiring
are the `knowledge` command, run by a person, which refuses while a launcher is
serving.

**Replay and evaluation answer their own questions.** `knowledge replay` and
`knowledge evaluate` run the engineer with nobody watching, so the run stands in
for the person: it allows `candidate.cycle`, `source.edit`, `source.change`,
`candidate.build`, `candidate.preview` and `preview.stop`, and declines everything else —
`release.activate` and `apps.create` above all — through the same gate and
approval table a click would use. What it allows can only reach the run's own
directory under `<root>/replay/` or `<root>/evaluate/`: a clone of the workspace,
a copied release, a copied data snapshot, and children started on those. The
live workspace is only read (`git clone`), the live release and data only
copied. A person starts both commands from a terminal; nothing starts them on
its own. They send the case's request, the instructions and the documents a run
is served to the configured provider, which is what the engineer's own turn
sends. Their results are shown by `knowledge confirm`; they confirm nothing.

**The change cycle asks once per action.** `candidate.cycle` patches, builds,
and when the build passes previews and checks, in one tool call. It does not
widen any approval: its own question is the patch's, and the build and the
preview are the existing tools, each asking its own question under
`<requestId>.build` and `<requestId>.preview`, so each answer binds to one
action and its own arguments. The check is a read. The chat puts a step's
question on the cycle's card and says which step it is. The preview runs the
candidate's code with the application's permissions on a copy of the data, and
approving a patch is not approving that.

## What none of this protects against

A candidate release's host code is **trusted local code**: crash-isolated in
its own child process, not permission-isolated. It runs as the person who
started the launcher, with their files and their network. The gate decides
whether that code is *asked to run*; it does not constrain what the code does
once it is running. The words "sandbox" and "isolated" are not used for it, and
the engineer is instructed never to use them either.

Generated *browser* code does not exist. The page runs the pinned renderer over
a declarative view specification with no JavaScript expressions and no raw
HTML, so a proposal cannot introduce script into a page whose CSP is pinned to
the hashes the build computed.

## What is deferred, deliberately

Two things a reader might expect to find here are not built, and are not
half-built either.

- **An OS sandbox for application children** — `sandbox-exec` on macOS,
  Landlock or bubblewrap on Linux, a restricted token or AppContainer on
  Windows — or a broker model where privileged work is only available through
  launcher-provided operations. v1 does neither. Containment per platform,
  before the loop it protects existed, would have cost the loop.
- **Enforced capabilities.** `manifest.capabilities` is a declaration a person
  grants; nothing constrains a child to what it was granted. The declaration is
  what an approval is shown against, not a boundary.

Both are the first section of [the backlog](backlog.md), with the precondition
for starting each. Until then, the sentence at the top of this section is the
whole of it: the child is trusted local code.
