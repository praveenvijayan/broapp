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
for the person: it allows `source.edit`, `source.change`, `candidate.build`,
`candidate.preview` and `preview.stop`, and declines everything else —
`release.activate` and `apps.create` above all — through the same gate and
approval table a click would use. What it allows can only reach the run's own
directory under `<root>/replay/` or `<root>/evaluate/`: a clone of the workspace,
a copied release, a copied data snapshot, and children started on those. The
live workspace is only read (`git clone`), the live release and data only
copied. A person starts both commands from a terminal; nothing starts them on
its own. They send the case's request, the instructions and the documents a run
is served to the configured provider, which is what the engineer's own turn
sends. Their results are shown by `knowledge confirm`; they confirm nothing.

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
