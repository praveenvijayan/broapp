# Autoapp: what the launcher remembers

The engineer forgets everything between turns. The launcher does not: it writes
down what the engineer did, at the moment it happened and with the identity it
had then, so that a restart resumes where the person left off and a later step
can learn from what went wrong. The design is in [design.md](design.md); what is
kept out of this record is in [security.md](security.md).

Nothing described here calls a model beyond the engineer's own turn. This page
covers what is written down and what is served back to the engineer from it.
Turning cases into lessons and replaying them come later, and the last section
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
| `lessons`, `lessons_fts`, `corpus_versions` | Facts served to the engineer. Six curated seeds are written the first time the table is empty, one corpus version each. |
| `servings` | One row per lesson a turn or a build failure was given, whether it reached the model, and what the next build or check found. |

The application the person last selected, by a row click or through any tool
that names an application, is kept in `<root>/launcher/session.json`.

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

## What a turn is told

Every turn of the launcher's engineer opens with documents it did not have to
ask for. They arrive through the AI layer's context providers, under the Rules
that say documents are data, and nowhere else. The engineer's instructions
change by three sentences only: read the documents first, and treat a build's
`hints` as facts from earlier work.

1. **Orientation** (`digest:<appId>`, at most 2,000 characters). Eight lines:
   the application, the current release and its schema version, the candidate
   and the revision it was built from, the files edited since that build, the
   last build's result, which checks are verified for the running preview, the
   preview, and the next verification step. Nothing in it that the candidate
   state does not say.
2. **Task evidence** (`evidence:<appId>`, at most 4,000 characters). The routes,
   views, migrations, acceptance examples and source symbols the request's words
   match, each with a `file:line`, followed by the migration numbering and the
   fixed constraints. When nothing matches it says so and lists the workspace's
   main files with their sizes.
3. **Supporting evidence.** A `lessons` document with up to three facts whose
   words match the request, and, beside a failed build, up to three `hints`
   whose words match its problems and whose stage is the problem's stage or
   none.

**Which application.** The one the message names by its id or a word of its
name; else the one last selected; else the only one there is; else none, and
the engineer uses `apps.list`.

**How an entry is known.** `declared` comes from the release specification the
build validated — the candidate's when one was built, else the current one.
`pattern` comes from five regular expressions over `src/` (`export function`,
`export const`, `app.operation('…')`, `id: '…'` in `views.ts`) and the migration
ids in `autoapp.json`; it is a pointer to read, not a claim. A route whose
handler no pattern found says `handler: unknown — use source.search`. The index
does not follow imports, aliases or computed names.

**Servings.** A lesson is recorded as served only after the AI layer reports
what it delivered. `included = 1` means its whole line reached the model;
a lesson resolved and then cut by the budget is `included = 0` and is never
scored. A hint is in a tool result, so it is always delivered.

**Outcomes.** Each delivered serving is closed once, by the first build or check
that could say something about it:

| Outcome | Meaning |
|---|---|
| `resolved` | The build ran the serving's stage and the failure it was served for was gone; or the check's example passed; or, for a turn serving with no failure, the build passed after the turn edited a file the lesson names. |
| `recurred` | The same failure, by signature, was still there. |
| `blocked` | The build stopped before the serving's stage. Only an event; the serving stays open. |
| `inconclusive` | The example failed some other way: the child died, a step timed out, or a different failure. |
| `unrelated` | A turn serving whose lesson names no file the turn edited, or a build that failed. |
| `none` | The turn ended with the serving still open. |

A build never closes a check serving. **None of these promotes, retires or
ranks anything.** An outcome is a fact about one attempt.

**In-turn guidance.** Every `source.edit` and `source.change` result carries
`verification`: the edits since the last build in this launcher process, the
last build's result, and `next: candidate.build`. From the third unverified
edit it adds a warning. It is advice; nothing is refused and nothing times out.

## Retention

When the store opens, events older than 30 days are deleted, and then the oldest
events beyond 50,000. Blobs older than 30 days that no case or context refers to
are deleted. Cases and contexts are never deleted.

## Not yet done

| What | Where |
|---|---|
| Distilling a resolved case into a provisional lesson that a person confirms | 12c |
| Replaying a case against a later launcher to see whether it still fails | 12d |

Until then the only lessons are the curated seeds, and cases are written but
not yet read by anything except the candidate panel.
