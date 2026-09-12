# Autoapp: what the launcher remembers

The engineer forgets everything between turns. The launcher does not: it writes
down what the engineer did, at the moment it happened and with the identity it
had then, so that a restart resumes where the person left off and a later step
can learn from what went wrong. The design is in [design.md](design.md); what is
kept out of this record is in [security.md](security.md).

This page covers what is written down, what is served back to the engineer
from it, how a resolved case becomes a provisional lesson, and how a case is
replayed so that the person confirming a lesson has evidence to confirm on.
The model is called by the engineer's own turn, by the distiller, and by a
replay or an evaluation a person starts; nothing else calls one.

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
| `lessons`, `lessons_fts`, `corpus_versions` | Facts served to the engineer. Seven curated seeds, each written once when the table does not hold it, one corpus version each; and lessons distilled from cases. |
| `servings` | One row per lesson a turn or a build failure was given, whether it reached the model, and what the next build or check found. |
| `replays` | One row per replayed run: the case, the lesson under test, the arm, the outcome, the calls, time and tokens, and the manifest it ran from. |

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
3. **Supporting evidence.** A `lessons` document with up to three lessons that
   share at least two words with the request, or that apply to a route the task
   evidence names; and, beside a failed build, up to three `hints` that share a
   word with its problems and whose stage is exactly the problem's stage. A
   lesson that names no stage is never a hint (12c watched the stageless MCP
   seed be hinted for a contract failure through the word "effect", and be
   credited with its repair). One shared word is not enough for a turn: in
   12b's rerun "list" served the migration seed to a request about tags. A provisional lesson is labelled
   `(provisional)`, and one a person should look at again
   `(needs review: <reason>)`.

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

**The change cycle.** The instructions send every change through
`candidate.cycle`, which applies the hunks, builds, and when the build passes
starts the preview and runs the checks, asking the person before the patch,
the build and the preview. What it returns is the next thing to do: each build
problem with the file, line and lines around it that it points at; whether
those are the problems the last build had (the change did not reach them); or
which examples failed and why. Its build and preview are the existing tools
under their own request ids (`<callId>.build`, `<callId>.preview`), so their
events, cases and servings are written down exactly as before.

**Where a cycle stopped.** Every step of a cycle — patched, built, previewed,
checked, a build or preview the person declined, a failing build — is written
to `candidate.json` with the workspace revision, the release, the failures by
signature and the next step. A turn that was interrupted, by a restart or by
running out, is picked up by the next one: its orientation says "Last cycle:
built … and not checked — it stopped there" and "Next: candidate.cycle with no
hunks, to finish verifying the last change". A cycle with no hunks and no files
verifies the workspace as it is.

**When it goes round.** A failure is the same failure when its signatures are,
for a build problem or a failed example alike, and a cycle says so
(`sameAsLastBuild`, `sameAsLastCheck`). Three cycles in one turn that end with
the same failure are the limit: the third says to stop, tell the person what
was tried and ask how to go on, and a fourth in the same turn is refused. The
person's next message is a new turn and the count starts again. A read the turn
has already made twice, with nothing changed since, says so the third time;
nothing is refused for it.

## Distillation

When a turn ends, every resolved case that has not been asked about is queued,
and the engineer's own model is asked one structured question about each, one
at a time, with a 60-second limit: what explains the failure, and could the
engineer have known? The answer is one of six:

| Diagnosis | Meaning | What is written |
|---|---|---|
| `knowledge_missing` | The fact it needed was nowhere in what it was given. | The diagnosis, and a provisional lesson. |
| `knowledge_not_retrieved` | The fact existed as a lesson but was not delivered. | The diagnosis, and a `search` event with `miss = 1` naming the lesson. |
| `method_unclear` | The instructions covered it, unclearly. | The diagnosis, and a provisional lesson that is **never served**: it is the queue a person reads before changing `instructions.ts`. |
| `method_not_followed` | The instructions were clear and not followed. | The diagnosis. |
| `tool_or_environment` | A tool, the build or the machine failed. | The diagnosis. |
| `insufficient_evidence` | The record cannot say. | The diagnosis. |

The diagnosis and the model's reasoning are always written to the case, once
(`episodes.diagnosis`, as JSON). A case whose question fails stays `pending` and
is asked again at the end of a later turn; after three attempts it is `failed`.
A second question about the same case is a no-op.

**What the distiller is shown.** Blobs, never live files: the person's request;
the instructions and every document exactly as delivered to the turn that met
the failure, from its `contexts` row; the problem and its stage; the acceptance
example for a check case; the edits, with how each hunk matched; both source
revisions and releases; and the last 20 events for the application while the
case was open. When a lesson for the same failure already exists, it is shown
too, with whether it existed at the turn's corpus version and whether it was
among the delivered documents.

**Why a lesson is provisional.** A model's account of its own failure is a
hypothesis. A provisional lesson is served, ranked below confirmed ones and
labelled so; nothing in the launcher confirms, retires or promotes one. Every
lesson records the case it came from, where it applies (`stage`, `files`,
`routes`, and the failure's signature), the hash of the instructions it was
written against and the launcher version that wrote it. A lesson whose text
names a path on this machine, an address with a port, or anything shaped like
a secret is dropped and the diagnosis kept.

**Supersession.** When the model says a new lesson has the same cause as an
existing one, the new one records `supersedes`. An old provisional lesson
becomes `superseded` and leaves the index. An old *confirmed* one keeps its
status — a person confirmed it — and is flagged `needs_review:superseded`.

**Review flags.** On start, the launcher flags, and never changes the status of:

- `needs_review:recurring` — served three times for a failure that came back,
  and never once resolved, since it was last reviewed;
- `needs_review:instructions_changed` — written for other instructions than the
  running ones, and recurred twice since;
- `needs_review:autoapp_upgraded` — distilled by a launcher of another minor
  version, and never reviewed.

**Reviewing.** From the launcher binary, reading the database directly:

```
broapp-autoapp knowledge list [--provisional|--confirmed|--review|--method]
broapp-autoapp knowledge show <id>
broapp-autoapp knowledge confirm <id> [--by <name>]
broapp-autoapp knowledge retire <id>
broapp-autoapp knowledge export [--json]
```

`list` shows each lesson's servings as resolved/recurred/blocked/unrelated.
`show` adds each outcome's count, and beside `resolved` how many of those were
hints whose lesson named another stage, or none: "of which unrelated by stage".
A repair resolves every hint served for its failure, the one that helped and
the one that only shared a word, so that number is the noise in the count.
`confirm` and `retire` record who and when, clear the flag and write a corpus
version; `retire` takes the lesson out of the index. Both refuse while a
launcher is serving from the same root, because it holds the database and
serves lessons from memory. The engineer can read one lesson's detail with the
`knowledge.show` tool (a `read`), which omits the reviewer's name and refuses a
`method_unclear` lesson. The tool is for the id a hint names: a turn in the
launcher was watched walking ids one after another, seven lessons in a row,
because nothing said there was no list. Now the description and the
instructions say so, a miss says so, and from the second lesson a turn reads
in full the result says how many that makes.

## Replay

A provisional lesson claims that knowing it would have avoided a failure. A
replay tests the claim:

```
broapp-autoapp knowledge replay <caseId> [--with <lessonId>] [--runs n]
```

It runs the engineer again on the case's original request, from the source
revision the failure was met at, several times with the lesson and several
times without it (three each by default, interleaved), and judges each run by
what failed: a **build case** passes when the build runs the failing stage and
no problem carries the case's signature; a **check case** passes when the
acceptance example — the case's own, by its content hash, never the
workspace's copy — passes on a preview of what the run left. Activation is
never part of it. Without `--with`, the lesson distilled from the case is the
one under test; with none, only the `without` arm runs.

**What is held still.** Everything is named in a manifest, written before
anything runs and stored as a blob on every result row: the case, the two
revisions and the release, the data snapshot for a check case, the hashes of
`package.json` and the lockfile at that revision, the request, the
instructions the replay runs with and the ones the case's turn was given, the
example, the model, the launcher version, the lesson, the runs, the step cap
(40) and the time a turn is given (20 minutes; a run that runs out of time is
judged by what it left). Each run is a fresh `git clone` of the workspace at
that revision under `<root>/replay/<caseId>/<arm>/<n>/`, the workspace's own
`node_modules` linked in, the release copied and made current, and for a check
case a copy of the data. The corpus is frozen: the `with` arm is given the
lesson under test on every turn and nothing else, the `without` arm no lesson
at all, and curated facts reach neither. Orientation and task evidence stay on
in both, because they are not what is being tested. The run answers the
engineer's questions itself: yes to edits, builds and previews, no to
activation and creation.

**What a replay is not.** It is the same machine, the same vendored
dependencies and a copy of the data. It is not the same model sample and not
the same conversation, and the instructions are this launcher's, which may
have changed since the case. Cases do not record a data snapshot today, so a
check case is replayed on a copy of the application's data taken the first
time it is replayed; the manifest says `from: live` when that is so.

**Where it writes.** Each case's runs write to a store of their own,
`<root>/replay/<caseId>/knowledge.sqlite`, logged with source `replay`, and
nothing is distilled there. The launcher's own store gains the manifest blob
and one `replays` row per run, and no serving, case or context: a replay can
never be what a learning query learns from. Run directories are kept for a
person to look at; the oldest beyond twenty per case are removed on the next
replay.

**The verdict.** Printed beside the two arms, never applied:

| Word | Meaning |
|---|---|
| `supports` | Passed only with the lesson. |
| `unrelated` | Passed with it and without it. |
| `no effect` | Failed both ways. |
| `against` | Passed only without it — the case the other three leave out. |
| `inconclusive` | An arm had no run that could be judged: every one failed on its provider, lost its preview child, or could not be prepared. |

After the arms, the **regression set** runs: every other resolved case of the
application whose lesson is confirmed, replayed once with the new lesson and
the confirmed corpus. A regression that fails is printed; it blocks nothing.

**Confirmation stays a person's.** `knowledge confirm <id>` prints the latest
replay's table, its verdict and the regression results, and asks `y/N`;
`--yes` skips the question. With no replay it says so — "no replay has been
run; `knowledge replay …` first" — and confirms as before, because a person may
have other evidence. No number here promotes anything.

## Evaluation

```
broapp-autoapp knowledge evaluate [--runs n] [--out <path>] [--notes <dir>]
```

The same harness, measuring the knowledge path itself: four tasks (the 07/08c
Notes request; "add a `done` filter to the items table" on the starter; "add
tags to notes and a filter by tag" on Notes; and a priority with a filter by it
on the starter), each under four conditions —
`baseline` (no documents and no hints, the launcher before 12b),
`orientation` (the digest alone), `orientation+facts` (12b as shipped) and
`learned` (that, plus every provisional and confirmed distilled lesson in the
launcher's store) — `n` runs each on the configured model. Each task's
acceptance example is added to the workspace before any run and judged from
the evaluation's own copy, by hash. Each example says what must be there
(with `match`, which ignores ids and timestamps a step cannot know) and what
must not, so a route that returns nothing cannot pass; none can yet say that
a change survives a restart or shows in the interface. The table gives two
scores — **working code** (the evaluation built and previewed what the turn
left, and the example passed) and **workflow completed** (the engineer itself
checked the release it last built, with the example intact, and every example
passed) — then calls to the first edit and to the first build, runs that
reached a build, failed builds, model time and tool time apart, approvals,
tokens, failure signatures that recurred from earlier runs, the files the
turn's documents named that it then read or edited (and ignored), the files it
read that nothing named, and the unrelated hint credit above. It installs
nothing, so it is run from a checkout, where the workspaces resolve their
dependencies from the repository.

The last two tasks are **two turns**. Turn one is the request, stopped the
moment a call that edits has its result, as a person pressing stop would. Turn
two says `continue`, with the request and turn one's words as history, under two
history modes: `text`, where that is all it gets, and `structured`, where the
assistant turn names turn one's run and the host gives the model that run's tool
calls and results (see "What the host keeps per run" in the AI guide). Every
condition runs both. The priority task is `touch-file`: between the turns the
evaluation commits a comment line to `src/shared/contract.ts`, so turn two's
`source.read` sees a revision turn one never saw. For `orientation+facts` a
third cell runs turn two with the launcher restarted — a fresh harness over the
same root and AI data directory — and the table marks it `restart`. Two-turn
cells have their own table: working code and workflow completed as above, and
for turn two the reads (`source.read`, `source.list`, `source.search`,
`spec.read`, `spec.reference`) before its first edit, the repeated reads (a
path, application or topic turn one had read), the repeated actions (a hunk
whose `find` turn one applied, or a creation of something that existed), its
tokens, turn one's calls, and for `touch-file` whether it read the changed file
before editing it.

## Retention

When the store opens, events older than 30 days are deleted, and then the oldest
events beyond 50,000. Blobs older than 30 days that no case or context refers to
are deleted. Cases and contexts are never deleted.

## Not yet done

| What | Where |
|---|---|
| A Lessons panel in the launcher tab, with the replay table beside each lesson | [backlog](backlog.md) |
| Promoting a lesson without a person | [backlog](backlog.md) |
| Recording a data snapshot when a check case opens | [backlog](backlog.md) |
