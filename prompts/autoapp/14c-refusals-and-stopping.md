# 14c — A failed task says why, and a launcher a person can stop

## Goal

Two things a person met on 2026-09-18, in the order they matter.

**Part one: a failure that names its cause.** A backlog task on a hosted model
failed twice with "Nothing was built." and four "No example named … was run."
The store says what actually happened: all five `candidate.cycle` calls were
refused on their input (a hunk that did not match the file, then
`create: expected an array` three times running), the builder fell back to
`source.edit` and `source.change` (47 applied, 22 refused, 15 of those
`message: expected a string`), and both turns ended with edits and no build.
The verdict saw none of that, the main model's advice saw only the verdict, and
attempt 2 was handed an attempts document built from knowledge events, in which
a refused tool call does not exist — so it repeated attempt 1's mistake call for
call. After this part: the verdict names the refusals, a turn that ends with
unbuilt edits is built once by the host, a repeated input refusal carries an
example of a valid input, and the advice and the next attempt are both told.

**Part two: a launcher that can be found and stopped.** The launcher has no
window, no `stop` command and no quit in its panel; a person who closes the tab
leaves it and every application it serves running until the terminal is killed.
A launcher that dies without its `exit` handler (`kill -9`, a crash, a closed
terminal) leaves its children alive: `child/run-child.ts` listens for `message`
and never for `disconnect`. After this part: `stop` and `status` commands, a
**Quit** in the panel, and a child that exits when its launcher is gone.

## Read first

- `prompts/autoapp/00-common-rules.md`; reports 13c, 13d, 14a, and 14b if it has
  been written.
- `packages/broapp-autoapp/src/intent/executor.ts`: `verdictOf`, `runTask`,
  `advicePrompt`, `advise`, `createExecutor`'s options.
- `packages/broapp-autoapp/src/host/run-store.ts`: `getRun(id)` returns the
  run's `steps`, each with `route`, `decision`, `outcome`, `error`. A spoke
  turn's steps are recorded under its own run id (`intent-…`): confirm that
  with a test before relying on it.
- `packages/broapp-autoapp/src/engineer/tools.ts`: `parsed` (line ~366, where
  "the input is not what this tool takes" is thrown), `editInput`, `cycleInput`,
  and how a hunk that does not match is reported ("not found in <path>: …
  Closest line <n>").
- `packages/broapp-autoapp/src/engineer/state.ts`: `CandidateStatus.editsSinceBuild`.
- `packages/broapp-autoapp/src/knowledge/attempts.ts` as it stands after 14b.
- `packages/broapp-autoapp/src/launcher/control.ts` in full: the control file,
  the secret, how a request is authenticated and answered, the `panel` request.
- `packages/broapp-autoapp/src/launcher/main.ts`: `stopChildrenOnExit`, the
  "Join a launcher that is already running" path (line ~418), the `status`
  command, the help text.
- `packages/broapp-autoapp/src/launcher/supervisor.ts` (`shutdown` message,
  `stopAll`, `killAll`) and `child/run-child.ts` (what a child does on
  `shutdown`).
- `docs/autoapp/security.md` and `docs/autoapp/intents.md`.

## Fixed decisions — part one

| Decision | Value |
|---|---|
| Where refusals are read from | The run store, by exact run id: `runStore.getRun(runId)?.steps`. The executor is given `runs: Pick<RunStore, 'getRun'>` in its options; absent (tests that do not care), everything below is skipped and nothing else changes. No new table, no second record of tool calls. |
| `refusalsOf(steps)` | Pure, in new `intent/refusals.ts`. A refusal is a step with `outcome = 'failed'` whose `error` is a public message. Grouped by `(route, kind)` where `kind` is `input` when the error starts with "the input is not what this tool takes", `no-match` when it starts with "not found in", else `other`; each group keeps its count and its newest error, sanitised and cut at 200. Returns groups ordered by count, then route. A step the gate denied is not a refusal of this kind: leave it out. |
| 1. The verdict names the cause | When the verdict has the reason "Nothing was built." (find its exact constant; do not match on the sentence), the executor adds, after it, one sentence per refusal group of `candidate.cycle` and `candidate.build`, at most 3: "candidate.cycle was refused 3 times: create: expected an array." and then, when any `source.*` refusals exist, one summary sentence: "22 edits were refused; most often: message: expected a string." `verdictOf` stays pure: it gains a `refusals` argument and tests of its own. A completed verdict never mentions refusals. |
| 2. A turn that ends with unbuilt edits is built once | After a spoke turn ends on its own (not aborted, not a provider ending, not `needs-answer`), if `states.status(appId).editsSinceBuild` is true, the executor runs one `candidate.cycle` with no hunks and no files — "verify the workspace as it is", which the tool already offers — through the same gate, under the turn's run id, as the run's standing answer. Its result feeds the verdict exactly as if the builder had called it. One per turn, never after an aborted turn (half an edit may be on disk), and its step is recorded with a note that the host made the call: use whatever field the run store has for who asked; if none, a knowledge `log` event, and say so in the report. If the task then completes, its history note says "completed after the host built what the turn left unbuilt". This does not make a builder's closing text evidence: the build and the checks are. |
| 3. A repeated input refusal shows a valid input | In `parsed`: nothing changes for a first refusal. The engineer tools keep, per run id, the last `(tool, error)` refused; when the same tool is refused for input with the same error again in the same run, the message gains "A valid input looks like: <example>". Examples are one constant per tool, `INPUT_EXAMPLES`, for the tools that take structured input (`source.edit`, `source.change`, `candidate.cycle`, `intent.task` at least): minimal, real field names, every required field present, arrays shown as arrays — for `candidate.cycle`: `{"appId":"notes","message":"Add a done column","hunks":[{"path":"src/host/db.ts","find":"…","replace":"…"}],"create":[{"path":"migrations/002.sql","content":"…"}]}`. A test parses every example with its own schema, so an example can never drift from the tool. The map of last refusals is dropped when the turn ends (`serve.ended` is the pattern). |
| A hunk that did not match | Already says the closest line. Add one sentence, only on the second `no-match` for the same path in a run: "Read the file again before another hunk: what you remember of it is not what is on disk." No other change to hunk matching. |
| 4. The advice is told | `advicePrompt` gains a section "# What the tools refused", the groups from both the last attempt and the one before, as `<route> ×<n>: <error>`, or "(nothing was refused)". `ADVICE_SYSTEM` gains one sentence: when the builder's calls were refused for their input, the plan is not at fault and another model may be the answer; say so in the note. No new advice word. |
| The next attempt is told | `attemptsDocument` gains, per earlier attempt, **Refused:** the top 3 groups as `<route> ×<n>: <error ≤120>`, placed after **Ended with:**. It counts toward the 1,500 cap; in the cut order it goes before **Changed:** paths are trimmed and after the diagnosis. Input comes through `attemptsInput` from the same `getRun`; `serve` is given the run store the same optional way. |
| The panel | A failed task's reasons already render as a list; the new sentences arrive in it. No layout change. |
| Not in scope, part one | Changing any tool's schema or accepting looser input (a string where an array is asked stays refused); retrying a refused call on the model's behalf; a fourth advice word; choosing another model automatically; any change to `TASK_MAX_ATTEMPTS`, the idle limit or the builder's message beyond what is above. |

## Fixed decisions — part two

| Decision | Value |
|---|---|
| A `stop` request on the control port | Same authentication as every other control request. It answers `{ ok: true, output: { stopping: true, serving: [appIds], run: <intent id or null> } }` and then, after the reply is flushed, runs the launcher's existing stop path: the executor's `stop` and `idle()` with the deadline it already has, `supervisor.stopAll(STOP_DEADLINE_MS)`, the control file removed, exit 0. It is the same function `SIGTERM` runs; make it one function if it is two. It works on Windows, where a console process is not sent `SIGTERM`. |
| `broapp-autoapp stop` | Reads the control file for the root, sends `stop`, waits until the pid in the file is gone (poll, 15 s ceiling), prints "Stopped. It was serving: reading-list, notes." or "No launcher is running over this root." (exit 0 both ways). A control file whose pid is not alive is stale: say so, remove it, exit 0. If the launcher answers and is still alive after the ceiling: "It did not stop within 15 seconds; its pid is <pid>." and exit 1. Never sends a signal itself. |
| `broapp-autoapp status` with no application | Today `status` needs an `appId`. With none: whether a launcher is running over this root, its pid, how long, what it serves, whether a backlog run is active and on which task. It asks the running launcher through a new read-only `status` control request; with no launcher it says so and lists nothing. `status <appId>` is unchanged. |
| **Quit** in the panel | Route `launcher.quit`, effect `write`, channel `user` only, no engineer tool and not reachable over MCP (assert both). The rail gets a Quit control at the bottom; it opens an inline confirmation with the sentence: "Stops the launcher and every application it is serving. A running backlog task is interrupted. Start it again with broapp-autoapp open." After yes the page shows "The launcher has stopped. You can close this tab." and stops polling. The route replies before the process begins to stop. |
| When the last panel closes | The launcher already knows when no panel session is attached. When that becomes true it prints one line, once per closure: "Still running, serving <ids>. `broapp-autoapp stop` ends it." Through `announce` if 14b landed, otherwise the plain logger. No idle exit: an application is meant to stay up with the panel closed. An opt-in idle exit is a `docs/autoapp/backlog.md` row. |
| A child does not outlive its launcher | In `child/run-child.ts`: on `process.on('disconnect')`, drain as for a `shutdown` message with a 5-second deadline, then exit. Because a disconnect is not delivered in every death (confirm what Bun does when the parent is `SIGKILL`ed, on each platform, and write it down), also a parent watch: every 3 seconds, if the launcher's pid — passed at spawn, not read from `process.ppid`, which on Windows and under some shells is not the launcher — no longer exists, do the same. `process.kill(pid, 0)` is the probe; `EPERM` means alive. A child run without a launcher (tests that spawn `--child` directly) is given no pid and has no watch. |
| Orphans already there | `stop` and `status` list, and `stop` offers nothing about, children of a dead launcher: that needs scanning the process table, which this prompt does not do. A backlog row. |
| Help and docs | The help text gains `stop` and the new `status`. `docs/autoapp/README.md` or the page that says how to run it: **Stopping it** — Quit, `stop`, Ctrl+C, what happens to a served application and to a backlog run, and that a closed tab stops nothing. `security.md`: `stop` and `status` are control requests behind the same secret; `launcher.quit` is a person's route. |
| Not in scope, part two | A tray or menu-bar item; idle exit; killing orphans from earlier launchers; a launch-at-login service; any change to how `open` joins a running launcher. |

## Verification

```bash
bun run typecheck
bun test tests/autoapp-intent-run.test.ts tests/autoapp-task-context.test.ts tests/autoapp-engineer.test.ts
bun test tests/autoapp-spike.test.ts tests/autoapp-mcp.test.ts tests/autoapp-stop.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

Part one, in `tests/autoapp-intent-run.test.ts` unless said:

1. `refusalsOf`: groups by route and kind, counts, keeps the newest error,
   orders by count; a gate denial is not a refusal; errors are sanitised.
2. A scripted spoke turn that calls `candidate.cycle` with `create` as a string
   twice, then edits, then ends: its steps are under the `intent-…` run id; the
   verdict's reasons include "candidate.cycle was refused 2 times: create:
   expected an array." directly after the nothing-was-built reason.
3. The same turn: the second refusal's message carries the valid example, the
   first does not; a different error for the same tool does not; a new turn
   starts clean.
4. `INPUT_EXAMPLES`: every example parses with its tool's schema (in
   `tests/autoapp-engineer.test.ts`).
5. A turn that edits correctly and ends without building: the host runs one
   verifying cycle, the task completes, the history note says the host built it,
   and the step is marked as the host's. An aborted turn with unbuilt edits gets
   no host build. A turn that built for itself gets none.
6. The advice prompt has the refused section for both attempts; with no run
   store it says "(nothing was refused)" and nothing else changes.
7. In `tests/autoapp-task-context.test.ts`: attempt 2's attempts document has
   **Refused:** with attempt 1's groups; over the cap it is cut in the stated
   order; no run store, no line.
8. Two `no-match` refusals for one path in a run: the second carries the
   read-it-again sentence.

Part two, new `tests/autoapp-stop.test.ts`, added to CI's per-platform line with
a comment saying why (signals and process probes differ on Windows):

9. The `stop` control request with a wrong secret is refused; with the right
   one it answers with what was serving, the children exit, the control file is
   gone and the process exits 0.
10. `stop` command: no control file; a stale control file (removed, exit 0); a
    live launcher (stopped, names what it served).
11. `status` with no application: running and not running.
12. `launcher.quit`: refused on channel `ai` and over MCP; on `user` it answers,
    then the launcher stops. The engineer's tool list has no quit.
13. A launcher killed with `SIGKILL` while serving: its child is gone within 10
    seconds (POSIX). On Windows, the equivalent hard kill (`taskkill /F`): same.
    This is the case that left two orphans on this machine.
14. A `--child` started with no launcher pid runs without a watch and does not
    exit on its own.
15. A backlog run active when `stop` arrives: the task is `interrupted`, the
    intent `stopped`, no attempt spent — as a restart already does.
16. The smoke gains a step: `open --no-open`, then `stop`, then assert the pid
    is gone and `status` says nothing is running.

By hand, once: replay the failure this prompt came from. Intent 2 of
`background-remove` in the real root, task `0001-store-image-and-settings`, is
`failed` with a workspace holding two attempts' unbuilt edits. **Copy the root
first and run against the copy.** Press Run on the same model
(`z-ai/glm-5.3`). Record: what the attempts document told attempt 3, whether
any call was refused twice and what the second message said, whether the host
had to build, the verdict's sentences, the advice. Then Quit from the panel and
confirm with `status` and `pgrep` that nothing is left.

## Acceptance criteria

- A task that fails because its builds were refused says so, naming the tool,
  the count and the error; the advice and the next attempt are told the same.
- A turn that ends on its own with unbuilt edits is built once by the host, and
  the task is judged on that build.
- The second identical input refusal in a turn shows a valid input, and every
  such example is held to its schema by a test.
- `broapp-autoapp stop`, `status`, and **Quit** in the panel exist, and none of
  them is available to the engineer or over MCP.
- A child exits within 10 seconds of its launcher's death, however it died, on
  all three platforms.
- A closed panel is followed by one line saying the launcher is still running
  and how to stop it.
- No tool accepts looser input than before. `tests/ai-chat.test.ts` unchanged;
  no change to `packages/broapp`; `bun run check` green.

## Report

`prompts/autoapp/reports/14c-refusals-and-stopping.md`: whether a spoke turn's
steps really are under its run id; the constant the nothing-was-built reason
comes from; how the host's build is marked in the record; what Bun delivers to
a child when its parent is hard-killed, per platform; the by-hand replay; and
anything in the common rules' decisions table this prompt strains — the host
making a tool call for a builder is new, and the report should say plainly
whether it sits inside "every mutation passes one gate".

## Commit

```
Say why nothing was built, and give the launcher a way to be stopped

A task that fails because its candidate.cycle calls were refused now says
so, with the tool, the count and the error, to the person, to the advice
and to the next attempt; a turn that ends with unbuilt edits is built once
by the host and judged on that; a second identical input refusal shows a
valid input. The launcher gains stop and status commands and a Quit in its
panel, says it is still running when the last panel closes, and its
children exit when it is gone, however it died.
```

End the commit with the co-author trailer your session's rules give you.
