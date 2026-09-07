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

## What is recorded

Every gate decision — allowed, confirmed, denied, refused — is written to
`runs.sqlite` inside the application's own data directory, with the channel,
the caller, the release, the arguments hash and the outcome. A preview child
writes to the copy; a live child writes to the real one.

Secrets are never in a run record, a journal row, a log line or a
`PublicError` message. The launcher's control secret lives in the launcher
process and in `<root>/launcher.json` at mode `0600`, and never crosses IPC.

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
