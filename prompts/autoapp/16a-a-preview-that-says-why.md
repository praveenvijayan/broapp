# 16a — A preview that says why it did not start, and a plan that knows what a preview refuses

## Goal

On 2026-09-18 and 19 the `background-remove` backlog (four tasks, all marked
completed) left its person with two errors at the preview stage. Both are the
platform's, not the application's.

**The first.** Release `17470f1f` could not be loaded: a file the builder wrote
held `var probeNamedImports = [useBroapp, useBridge, …]` and the child's first
message after `hello` was
`fatal: the release could not be started: useBroapp is not defined`.
`startupFailure` in `launcher/supervisor.ts` (line ~455) turns that reason into
a plain `Error`, and a plain `Error` thrown from an operation or a tool is
masked as `INTERNAL_ERROR_MESSAGE`. So `candidate.preview` and
`candidate.cycle` answered the builder
`The application could not complete that operation.` four times between 22:15
and 22:45 — the one sentence that would have ended the search in one edit never
reached it — and `launcher.previewStart` showed the person the same words the
next morning. The reason went only to the launcher's stderr. The bug in the
workspace is the builder's to fix; being told what it is, is the platform's.

The banner then stayed. `CandidatePanel.tsx` (line ~198) draws
`startPreview.error` for as long as the hook holds it, and nothing clears it, so
a newer release with a preview running and every check green still sat under a
red failure that was about a different release.

**The second.** `decide` in `packages/broapp/src/host/gate.ts` refuses `external`
in a preview for every channel, the person's own click included, and says why in
its comment. `image.remove` spawns Rembg, so it is `external`. The plan knew
this — its out-of-reach section says automated checks cannot call it — and in
the same breath its runbook said: *"With Rembg installed, click Remove
background in the preview and confirm a result PNG appears."* The person did,
and was told `image.remove is not allowed in preview`. The only thing the
planner is told is half a sentence in the `contract` topic
(`engineer/reference.ts`, line ~36). Nothing says what that means for a runbook:
an `external` route can be tried only in the activated application.

After this prompt a preview that cannot start says why to whoever asked; a
failure about one preview does not outlive it; and a plan never sends a person
to a preview to do what a preview refuses.

## Read first

- `prompts/autoapp/00-common-rules.md`; prompt and report 01 (the gate, and why
  a preview refuses `external` outright); report 05 (candidate and preview);
  report 14c (`background-remove`, refusals and what the builder is told).
- `packages/broapp-autoapp/src/launcher/supervisor.ts`: `launch`,
  `startupFailure`, `waitFor`, the `gone` error (already a `PublicError` — read
  what code it uses and why), and every `throw` inside `start`.
- `packages/broapp-autoapp/src/child/run-child.ts` line ~343: where the `fatal`
  reason is written, and what else can be in it.
- `packages/broapp-autoapp/src/engineer/preview.ts` and its two callers:
  `candidate.preview` in `engineer/tools.ts` (line ~1136), `candidate.cycle`'s
  preview stage, and `launcher.previewStart` in `launcher/app.ts` (line ~601).
- `packages/broapp/src/shared/errors.ts`: `publicError`, `PUBLIC_CODES`,
  `isPublicError` and its comment on why a refusal must not become a mystery.
  Read only; this prompt does not change `packages/broapp`.
- `packages/broapp-autoapp/src/launcher/ui/CandidatePanel.tsx` and the
  `useOperation` hook it uses: what `error` holds, and whether the hook can be
  reset or the message must be conditioned in the panel.
- `packages/broapp-autoapp/src/engineer/reference.ts`: `CONTRACT`,
  `SPLIT_RULES`, `INTENTS`; `intent/plan.ts`: `checkSection`, how a plan problem
  is worded and returned to `intent.task` / `intent.submit`; how a task's
  routes and their effects can be known at planning time (the contract may not
  hold the route yet — say in the report what is knowable and when).

## Fixed decisions

| Decision | Value |
|---|---|
| The startup reason is public | A child that does not reach `ready` fails `supervisor.start` with a `PublicError`, not a plain `Error`. The message is `The release could not be started: <reason>` — the child's `fatal` reason with its own prefix not repeated, or the exit code sentence, or the timeout — cut at 400. The code is the one `gone` already uses for a dead child unless reading shows a better one; say which and why in the report. One place: `startupFailure`. Every caller — `candidate.preview`, `candidate.cycle`, `launcher.previewStart`, activation, recovery — gets it without a change of its own; check each and say what each now shows. |
| What the reason may hold | What the child wrote: a message from loading the release's own bundle. It is the application's code failing in the application's process, shown to the application's owner and to the builder working on it. No stack, no absolute path the child did not already put in the message. If `run-child.ts` can put a data-directory path in the reason, say so in the report and leave it; it is the person's own machine. |
| The builder is told what to do | `candidate.preview` and the cycle's preview stage add one sentence after the reason: that the release built but does not load, that the reason is a fault in the workspace's source, and to fix it and cycle again. The same words in both. 15f's grouping must see four of these as the same refusal only if they are: the reason is part of the group key as it is for any tool refusal — confirm, do not change 15f. |
| The activation path | Unchanged in behaviour. If activation already reports a start failure with its reason through `result.reason`, leave it and say so. |
| A failure does not outlive its preview | In `CandidatePanel`, the start failure is shown only while it is about the candidate on screen: it goes when a preview is running, when the candidate's `releaseId` differs from the one the click was for, or when the person presses the button again. Do it in the panel; do not change the hook's contract in `packages/broapp`. The same rule for `setGrants.error` and the activate error if they have the same fault — read and say. |
| What the planner is told | `CONTRACT` says, in its `effect` bullet: an `external` route is refused in a preview for everyone, the person's own click included, so it can be tried only in the activated application. `SPLIT_RULES` gains one line: a `runbook` line that exercises an `external` route says *after activating*, names the capability the person will be asked to allow, and never says *in the preview*; what a preview can show of such a task is the page, the form and the failure path. `SPLIT_RULES` is carried by `intent.task`'s description and the `intents` topic, so both get it. Mind the description's length limit if there is one. |
| What the plan refuses | Only what can be checked without guessing. If at `intent.task` time the routes a task names and their effects are knowable (from the contract as it stands, or from the task's own declared routes), a `runbook` line that names an `external` route and the word *preview* is a plan problem, worded like the others, naming the line and saying *after activating*. If effects are not knowable at planning time, do not add a heuristic on words alone: the guidance is the fix, and the report says why there is no check. |
| What the person reads at the end | `BY_HAND` in `IntentPanel.tsx` lists runbook lines under *"Open the preview, look, then activate"*. When a finished backlog has any runbook line for a task with an `external` route — by the same knowledge as the row above, or not at all — the lede says some lines can only be tried after activating. If that is not knowable, leave the lede and say so. |
| The gate | Unchanged. No channel, no mode and no capability makes `external` run in a preview. Do not add a dry-run, a stub or a "preview with effects" switch. |
| Not in scope | Catching an undefined identifier at build time, or loading the bundle once as a build stage: a row in `docs/autoapp/backlog.md`, with this case as the evidence and what it would cost. Teaching the builder how an application's own UI layer calls operations (the reason it wrote a probe at all): a second row. Any change to `packages/broapp`. Any change to `background-remove` itself — Autoapp fixes its own application. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-supervisor.test.ts tests/autoapp-engineer.test.ts tests/autoapp-intent.test.ts tests/autoapp-intent-tools.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside the ones they extend:

1. Supervisor: a release whose bundle throws `ReferenceError: x is not defined`
   on load fails `start` with a `PublicError` whose message holds
   `x is not defined`. One that exits before `hello` holds the exit code. One
   that never says `ready` holds the timeout.
2. `candidate.preview` on that release: the tool result holds the reason and
   the sentence that says to fix the source; it is not `INTERNAL_ERROR_MESSAGE`.
3. `candidate.cycle` on it: the same words, at the preview stage, and the build
   stage still reported as passed.
4. `launcher.previewStart` on it: the step's `error` in `runs.sqlite` is the
   reason, not the mask.
5. A reason over 400 characters is cut; a reason with a newline stays one line.
6. The panel: a failed start, then a status with `previewRunning: true` — no
   alert. A failed start, then a status with a different `releaseId` — no alert.
   A failed start and nothing else — the alert, with the reason.
7. The `contract` topic and `intent.task`'s description both hold the new
   sentence; one test reads both so they cannot drift.
8. If the plan check exists: a runbook line naming an `external` route and *in
   the preview* is refused with the line named; the same line saying *after
   activating* is accepted; a line about a `write` route in the preview is
   accepted.

By hand, on a copy of the root under
`~/Library/Application Support/broapp-autoapp/autoapp` if release `17470f1f` of
`background-remove` is still there: start its preview from the panel and record
the words shown. Then start a preview of the current candidate and record that
the alert is gone. If the release is gone, build a workspace with an undefined
identifier at module scope and use that; say which.

## Acceptance criteria

- No path from "the child did not start" to a person or a builder ends in
  `The application could not complete that operation.`
- The builder that wrote a release that does not load is told the reason the
  first time, in the tool result, with what to do next.
- A start failure is never drawn over a candidate it is not about.
- A plan written after this prompt does not tell a person to try an `external`
  route in a preview; the planner has been told why in the two places it reads.
- The gate's table is unchanged and `tests` for it are untouched.
- No change to `packages/broapp`; `tests/ai-chat.test.ts` unchanged;
  `bun run check` green.

## Report

`prompts/autoapp/reports/16a-a-preview-that-says-why.md`: the code chosen for a
start failure and why; what each caller of `supervisor.start` shows now, in its
own words; whether a route's effect is knowable at planning time and so whether
the plan check and the lede exist; the by-hand run, with the words on screen;
and the two backlog rows.

## Commit

```
Say why a preview did not start, and plan around what it refuses

A child that failed to load its release told the supervisor why, and the
supervisor threw the reason as a plain Error, so the builder and the
person both read "could not complete that operation" — four times in one
evening for an undefined identifier. The reason is now a public error
from one place. The panel no longer draws a start failure over a
candidate it is not about. The contract topic and the split rules say
that an external route runs only after activation, so a runbook stops
sending people to a preview for what the gate refuses there.
```

End the commit with the co-author trailer your session's rules give you.
