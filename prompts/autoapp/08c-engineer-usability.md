# 08c — Engineer usability from the 08b demo

## Goal

Three measured problems from report 08b, fixed: hunks fail on leading
whitespace the model cannot reproduce; the engineer cannot list
applications; a confirmation expires two minutes after a call that took
the model ten minutes to compose. After this prompt: `source.edit` matches
hunks with indentation tolerance and says exactly what it compared when it
still cannot; `apps.list` exists; the launcher's confirm window is ten
minutes and every pending question shows how long it has left.

No new design. Read report 08b's demo section before starting; the numbers
there are the reason for every change here.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `packages/broapp-autoapp/src/engineer/workspace.ts` (`applyEdits`, `Hunk`), `tools.ts`, `instructions.ts`.
- `packages/broapp-autoapp/src/launcher/app.ts` (`launcher.appsList`), `main.ts` (where the launcher's gate and `createAi` are built).
- `packages/broapp/src/host/gate.ts` (`confirmTimeoutMs`, the question and its timer), `approvals.ts` (`pending`).
- `packages/broapp/src/ai/host/run.ts` (the approver's own deadline, report 01 deviation 2).
- `packages/broapp-autoapp/src/react/ApprovalsStrip.tsx` and the launcher's chat confirm UI.
- `tests/autoapp-engineer.test.ts`, `tests/autoapp-gate.test.ts`.

## Step 1 — indentation-tolerant hunks

`applyEdits` matches a hunk in three passes, stopping at the first that
finds exactly one match:

1. Exact, as today.
2. Line-wise with leading whitespace stripped from every line of both the
   file and `find`, and trailing whitespace stripped. When exactly one
   match, the replacement is applied with **the file's** indentation: for
   each replaced line, take the indentation of the corresponding matched
   file line when the line count is equal; otherwise use the first matched
   line's indentation for every replacement line that began with
   whitespace in `replace`, and none for lines that did not. Record which
   pass matched in the result (`matchedBy: 'exact' | 'indent'`).
3. No match: the error names the file, the first line of `find`, and the
   **nearest** file line by a simple similarity (longest common prefix
   after stripping), quoted verbatim with its line number, in the form
   `not found in <path>. Closest line <n>: "<text>"`. An ambiguous match at
   either pass reports the line numbers of every match.

Every hunk is still checked before any is applied; all-or-nothing holds.
Keep the `find` size unchanged; do not add fuzzy matching beyond
whitespace. Say in a comment why: a hunk that matches something the model
did not mean is worse than one that fails.

Tests: exact still wins over indent; a hunk with one extra leading space
matches by indent and the file keeps its own indentation; a hunk whose
`replace` adds a line gets the matched block's indentation; two indent
matches are ambiguous; the not-found message quotes the nearest line;
mixed tabs and spaces in the file, spaces in the hunk, match by indent
and keep tabs.

`instructions.ts`: tell the model that leading whitespace need not match
and that `find` should be the smallest unique block, ideally three to
eight lines; report 08b measured hunks under 1 kB succeeding and those
over 2 kB failing. Stay under 70 lines.

## Step 2 — `apps.list`

`engineer/tools.ts`: `apps.list` (`read`, input void) returning, for every
application, `{ appId, name, currentRelease, serving, schemaVersion }`,
built from the same helpers `launcher.appsList` uses; factor those into
`launcher/apps.ts` so the tool and the route share one implementation.
Add it first in the instructions' loop: "find the application with
`apps.list` if you were not told its id".

Test: the tool lists the fixture app; a scripted model that starts with
`apps.list` then `spec.read` proceeds without a nudge.

## Step 3 — a confirm window that fits the engineer

`gate.ts`: `GateOptions.confirmTimeoutMs` stays. `ApprovalQuestion` gains
`readonly askedAt: number` and `readonly expiresAt: number`, set by the
gate when it asks. `PendingApprovals.pending` therefore carries them.

Launcher: build its gate with `confirmTimeoutMs: 600_000` and pass the
same value to `createAi`, so the AI approver's own deadline (report 01
deviation 2) does not undercut it. Application children keep the default
120 s; their questions come from a person's own workflow run or an MCP
call and two minutes is right there. State both numbers in
`docs/autoapp/security.md` under approvals.

UI: the approvals strip and the launcher chat's confirm card show a
countdown from `expiresAt` ("expires in 9:41") and turn the card amber
under one minute. Bring the launcher tab to the front when a question
arrives: `document.title` prefixed with `(1) ` while a question is
pending, and `Notification` if permission was already granted — never
request it. Test the title change with `react-dom/server` or the existing
render approach; do not add a test library.

Tests in `tests/autoapp-gate.test.ts`: `askedAt`/`expiresAt` present and
`expiresAt - askedAt === confirmTimeoutMs`; a launcher-shaped gate with
`600_000` still times out (use a fake timer or a 50 ms override to prove
the option is honoured, not the constant).

## Step 4 — rerun the demo's third step only

With the same provider as report 08b, send the large request once. Answer
every confirmation within its window. Record the same table as 08b (think
time, bytes, hunks, result, `matchedBy`), and whether a build was reached.
Stop after `candidate.build` returns; steps 5 to 8 are not the subject
here. Never enter a key.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

## Acceptance criteria

- The three whitespace failures from report 08b, replayed as unit tests with the exact hunks quoted there if the report has them (else equivalent one-space-off hunks), now apply.
- A not-found hunk error quotes a real nearby line.
- `apps.list` exists and the instructions name it first.
- The launcher's questions last ten minutes and show it.

## Report

`prompts/autoapp/reports/08c-usability.md`.

## Commit

```
Make the engineer's edits tolerant of indentation and its questions patient

Hunks match with leading whitespace ignored and are applied with the
file's own indentation; a miss quotes the nearest real line. The engineer
can list applications. The launcher's confirmation window is ten minutes
and every pending question shows when it expires.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
