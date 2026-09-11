# Autoapp: what the launcher remembers

The engineer forgets everything between turns. The launcher does not: it writes
down what the engineer did, at the moment it happened and with the identity it
had then, so that a restart resumes where the person left off and a later step
can learn from what went wrong. The design is in [design.md](design.md); what is
kept out of this record is in [security.md](security.md).

Nothing described here calls a model, and nothing here changes what the engineer
is told. This page covers what is written down. Serving it back to the engineer,
turning cases into lessons and replaying them come later, and the last section
says which later step does each.

## Where

One SQLite file, `<root>/launcher/knowledge.sqlite`, beside the launcher's own
`runs.sqlite`. It is opened by the launcher's long-running commands (`serve`,
`open`, and the bare command) before anything else starts, so the first line a
child prints is recorded. One-shot commands such as `build` and `activate`
print to the terminal and write nothing here.

| Table | What it holds |
|---|---|
| `events` | One row per build, check, edit, activation, turn, token count, child stderr line, and launcher warning. |
| `blobs` | Text stored by the `sha256` of its bytes: requests, instructions, system prompts, documents, acceptance examples. |
| `contexts` | What each turn was given: the instructions, the system prompt as sent, and each delivered document. |
| `episodes` | Cases. A failure, the edits after it, and the build or check that repaired it. |
| `lessons`, `lessons_fts`, `corpus_versions`, `servings` | Created empty, so later steps add behaviour without adding schema. Nothing writes to them yet. |

## Identity

Every row carries the run id, the call id, the application, the release and the
source revision it had **when it was written**. The run and call come from the
envelope the run loop gave the tool, never from anything the model said. A chat
turn's request id is `<runId>:<callId>`; a person's click is a single-step run
whose request id is both. The source revision is `git rev-parse HEAD` of the
application's own workspace, or `no-git` when the workspace is not a repository
of its own.

A row with no origin, such as a child's stderr line, stores `NULL` in those
columns and keeps `NULL`. Nothing attributes a row to whichever run ended next.

## Cases

A failed `candidate.build` opens one case per distinct failure. Two failures are
the same when they differ only in a path, a line number, a quoted name, a hash
or a number: the store normalises the message and hashes it with the stage, and
that hash is the case's `signature`. A failed acceptance example opens a check
case. A check case is identified by the example's content hash as well, so an
example whose `expect` was edited is a different case.

A case records the person's request, the context row of the turn, the source
revision and the running release before the repair, the model, and the
launcher's version. Edits are appended while it is open, up to 8,000 characters.

A case is resolved once:

- **A build case** is resolved by the first build that **ran its stage** and
  found nothing there. A build that stopped earlier says nothing about later
  stages, so their cases stay open. That is why a build result carries
  `stagesRun`: "the error is gone" and "the stage never ran" both look like an
  absent problem. A failing build still resolves the cases of stages that ran
  clean.
- **A check case** is resolved only by a pass of the same example content.

**Evidence is immutable.** Triggers in the database refuse any change to a
case's opening columns, any change to its edits except an append while it is
open, and any change to its resolution after the resolution is written. A
diagnosis can be written once. The distillation bookkeeping (`distill_state`,
`distill_attempts`) belongs to a later step and stays writable.

## What a restart restores

The candidate panel's state is written to `<root>/apps/<appId>/candidate.json`
on every change: the release that was built, the source revision it was built
from, the problems, the stages that ran, the last checks and the preview each
check ran on, and whether a preview was running. The preview process itself does
not survive a restart.

After a restart the panel shows the same candidate and says three things:

- **"The preview stopped when the launcher restarted."** Open preview becomes
  **Start preview**, which calls `launcher.previewStart` and then opens the
  preview.
- **"Passed n of m for an earlier preview; run the checks again."** A check
  result counts as verified only for the release it ran against, on the preview
  child it ran on. A child is identified by its release and its spawn time.
- **"Edited since this build."** The workspace's `HEAD` has moved on from the
  revision the build was made from. This is computed when the panel asks, at
  most once a second, and is never stored.

## Retention

When the store opens, events older than 30 days are deleted, and then the oldest
events beyond 50,000. Blobs older than 30 days that no case or context refers to
are deleted. Cases and contexts are never deleted.

## Not yet done

| What | Where |
|---|---|
| Serving cases and lessons back to the engineer as context, and the `search` events | 12b |
| Distilling a resolved case into a provisional lesson that a person confirms | 12c |
| Replaying a case against a later launcher to see whether it still fails | 12d |

Until then, everything here is written and nothing reads it except the
candidate panel.
