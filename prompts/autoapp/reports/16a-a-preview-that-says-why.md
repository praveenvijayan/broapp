# 16a — A preview that says why, and a plan that knows what a preview refuses

## What was built

- `launcher/supervisor.ts`: `startupFailure` returns `startFailed(reason)`, a `PublicError`
  `unavailable`, message `The release could not be started: <reason>`, whitespace made one line,
  cut at 400 with `…`. The child's own prefix (`NOT_STARTED`, now a constant in `ipc/messages.ts`
  that `run-child.ts` writes) is dropped. The error carries a shape marker; `startFailure(cause)`
  reads it back and `startFailedWith(sentence, advice)` keeps it. The unreachable
  `ready.type !== 'ready'` throw uses it too. Exported from `broapp-autoapp/launcher`.
- `engineer/preview.ts`: `DOES_NOT_LOAD` ("The release built but does not load: this is a fault in
  the workspace’s source, not in the data. Fix it, then run candidate.cycle again."),
  `forTheBuilder`. `startPreview` now forgets the preview it stopped before starting the new one.
- `candidate.preview` throws the reason plus `DOES_NOT_LOAD`. `candidate.cycle`'s preview stage
  returns `build: { ok: true, … }`, `preview: { started: false, error }` (the same words), and
  counts it like a build failure against the repair limit; `CYCLE_STEPS` gains `preview-failed`.
- `CandidatePanel.tsx`: `aboutCandidate` and `startFailureShown`, pure and exported.
- `reference.ts`: `EXTERNAL_IN_PREVIEW`, in the `contract` topic's `effect` bullet and in a new
  `SPLIT_RULES` line (so in `intent.task`'s description and the `intents` topic).
- `intent/plan.ts`: `externalRoutes`, `routesNamedIn`, `runbookProblems`. `intent.task` adds
  runbook problems to the plan problems. `launcher.intentGet` gives each task `afterActivating`
  (runbook line indexes). `IntentPanel` shows `AFTER_ACTIVATING` and marks lines.
- Docs: `intents.md` (two sentences), `backlog.md` (two rows).
- Tests: supervisor 5 (the prompt's 1 and 5), engineer 4 (2, 3, 4, 6), intent-tools 2 (7, 8),
  intent-run 1 (the lede). With `startFailed` made to return a plain `Error`, all 7 start tests fail.

## The code, and why

`unavailable`, the code `gone` already uses for a child that died: the release is not there to
answer. `rejected` is wrong, because the AI run loop reads it as a person saying no and turns it
into "declined". `invalid_input` is wrong because the start was asked for correctly. `conflict` is
wrong because no state collided.

## What each caller of `supervisor.start` shows now

- **`candidate.preview`**: the tool fails with `The release could not be started: useBroapp is
  not defined The release built but does not load: …`. The model gets these words, since a public
  error keeps them. The gate's step `error` holds the same words.
- **`candidate.cycle`**: the same words in `preview.error`, the build reported as passed, and
  `next`: "Fix what the preview’s error names with another candidate.cycle."
- **`launcher.previewStart`**: the panel shows the reason. The step `error` in the launcher's
  `runs.sqlite` is the reason.
- **`launcher.appOpen`** (open an application): the reason, where it used to show the mask.
- **Activation**: unchanged in behaviour. `result.reason` already carried the reason and still
  does, now inside the new sentence: `the candidate would not run the acceptance examples: The
  release could not be started: …`, `…would not open the migrated data: The release could not be
  started: …`, and at step 7 `the new release would not start: PublicError: The release could not
  be started: …` (it was `Error: the release…`). Left as it is.
- **Recovery, keepalive, the replay harness**: the same error, and they log or rethrow it as
  before. `serve` prints it rather than a mask.
- **Not covered**: a spawn that throws before any child exists (for example, a missing
  executable). That is the launcher's own fault, not the release's, so it stays a plain `Error`.

**What the reason may hold.** The child's message only. `run-child.ts` can put an absolute path
in it: `loadRelease`'s `the release directory <path> is not release <id>`, and a `mkdirSync`
failure on `BROAPP_DATA_DIR`. Both stay in, as the prompt allows. No stack is added.

**15f, confirmed and not changed: the reason is not part of the group key.** `refusalsOf` and the
executor both key on `route` + kind (`input`, `no-match`, `other`; 15f's decision 2). A start
failure is kind `other`. So four `candidate.preview` start failures are one group whatever their
reasons. The prompt assumed otherwise. The cycle's preview failure is a result, not an `{ error }`,
so 15f does not count it. The cycle's own limit does: three identical failures stall the cycle,
and its signature includes the reason.

## The panel

A start failure is shown only while `startedFor === status.releaseId` and no preview is running.
Pressing the button again clears it, because the hook's `run` resets `error`. `setGrants.error`
and the activate result and error had the same fault (hook state, drawn with no condition). They
now show only while the click's release is the candidate. There is one pre-existing fault this
exposed: a failed start left the stopped preview in state, so `previewRunning` read `true`.
`startPreview` fixes that.

## Is a route's effect knowable at planning time?

**Only for a route that already exists.** At `intent.task`, the serving release's contract is
known. `intent.open` grounds the analysis in it, and it has each route's `effect`. A task
declares no routes, so a route the task is about to add has no known effect. So the check exists
for existing routes only. It refuses a runbook line that names an `external` route of the serving
release as a whole word and contains "preview". It adds no heuristic on words alone.

`background-remove`'s own line ("click Remove background in the preview") names no route, and
`image.remove` did not exist when it was planned. **This check would not have caught it.** The
guidance is the fix there. The lede reads the release the task *completed at*, which does hold the
new route. So a finished backlog marks a line "(after activating)" when it names one, and says
why above the list.

The `intent.task` description is now 2,162 characters, up from 1,778. No limit exists in this
code, and nothing on this machine enforces one.

## By hand

This used a copy of the real root: `background-remove`'s releases, `grants.json`, `current`, and
`runs.sqlite` taken by `VACUUM INTO`. `candidate.json` was edited to name `17470f1f` and a lost
preview. No source was copied. The person's own launcher was serving the real root and was not
touched. The compiled launcher from this tree ran `open --no-open --no-restore` against the copy.
- **Start preview on `17470f1f`**. The alert read: **"The release could not be started: useBroapp
  is not defined"**. The step in the copy's `launcher/runs.sqlite`: `launcher.previewStart |
  allowed | failed | The release could not be started: useBroapp is not defined`.
- **A preview of the current candidate, `e477b8f0`**. Only an engineer tool moves the candidate,
  so a scripted OpenAI-compatible endpoint on 127.0.0.1 (in the scratchpad) asked for
  `candidate.preview` of `e477b8f0`, and I clicked Allow. The panel then read "Built e477b8f0;
  edited since this build." with **Open preview**, and **the alert was gone**.
- **Seen and not changed**: the panel's Start preview chains `previewOpen` after the start even
  when the start failed. That call is refused ("There is no preview running…") and nothing is
  drawn. It was stopped with `stop`, and nothing was left running.

## Backlog rows

**A release that does not load, caught by the build.** This case is the evidence. The cost is a
child start on every build, or a type check the binary does not carry.

**Telling the builder how an application's own UI calls its operations.** The builder wrote the
probe because it did not know this. There is one case so far.

## Deviations, and decisions I made

1. The reason is cut to 400 characters over the whole sentence, not the reason alone.
2. `startPreview` clears the stopped preview first (above). This touches a file the prompt listed
   to read, not to change, and it is needed for the panel rule.
3. The cycle's preview failure is counted by the repair limit and has its own step.
4. The plan check reads the serving release. The lede reads the task's own release.
5. The commit leaves out `README.md` and the `17a`/`17b` prompt files: another session is
   editing them. It includes this prompt's file, as 12a did. The trailer names Claude Opus 5, per
   this session's rule.
6. The report runs past 100 lines, because of the per-caller list and the by-hand run the prompt
   asks for, as 12h and 13b–14c did.

## Commands run

```
bun run typecheck                                                   exit 0
bun test tests/autoapp-{supervisor,engineer,intent,intent-tools}.test.ts   114 pass, 0 fail
bun test tests                                                      1017 pass, 0 fail (54 files)
bun run --cwd packages/broapp-autoapp build:launcher                dist/broapp-autoapp 77.8 MB
bun run scripts/autoapp-smoke.ts                                    every step passed
bun install && bun run check                                        exit 0, 1017 pass, 0 fail
git diff --stat packages/broapp tests/ai-chat.test.ts               (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| No path from a child that did not start to a person or builder ends in the mask | pass (tests 1–4; spawn-before-child excepted, above) |
| The builder is told the reason the first time, with what to do next | pass (tests 2, 3) |
| A start failure is never drawn over a candidate it is not about | pass (test 6; by hand) |
| A plan after this does not send a person to a preview for an `external` route; told in both places | pass for routes that exist (test 8); guidance in both (test 7) |
| Gate unchanged, its tests untouched; no `packages/broapp` change; `ai-chat` unchanged; check green | pass |
