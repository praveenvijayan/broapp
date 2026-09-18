# 14c — A failed task says why, and a launcher a person can stop

Built on branch `14c-work` in the worktree `/Users/pv/works/broapp-14c`, cut from `autoapp` after 14b's
code commit, as the person asked, because a 14b measurement was running from the main checkout.

## What was built

**Part one.** `intent/refusals.ts`: `refusalsOf(steps)` (pure), `refusalError`, `refusalLine`,
`INPUT_REFUSAL`, `NO_MATCH`. In `executor.ts`: `NOTHING_BUILT`, `refusalSentences`, `verdictOf(…, refusals)`
(seventh parameter, default `[]`), `advicePrompt(…, refusals)` with **# What the tools refused**, one
sentence added to `ADVICE_SYSTEM`, options `runs` and `hostCycle`, the host build (`HOST_CALL_ID`,
`HOST_BUILT_COMPLETED`). In `tools.ts`: `editInput`, `changeInput` and `cycleInput` moved to module level
as `INPUT_SCHEMAS`; `INPUT_EXAMPLES`; `createInputMemory` / `InputMemory` and the wrapper that adds the
example or `READ_AGAIN`; `INTENT_TASK_INPUT` exported from `intent-tools.ts`. `attempts.ts`: **Refused:**
per earlier attempt and the cut order below; `serve.ts` and `tab.ts` hand the run store in as `refusals`.

**Part two.** Control requests `status` (read-only) and `stop` (answers, then begins the stop);
`ControlClient.status()` and `.stop()`. In `main.ts`: `broapp-autoapp stop` and `status` with no
application, handled before any store opens; `stopChildrenOnExit` returns a `StopPath` that SIGINT,
SIGTERM, `stop` and Quit all use. With a panel, the stop runs the tab's own shutdown and `main` then
exits the process. A watch prints one line when the last panel closes. `launcher.quit` (`write`,
channel `user` only) with `LauncherApp.invoke` for tests. `ui/QuitControl.tsx`: a Quit control at the
foot of the rail, an inline confirmation, and a stopped page. `child/watch.ts`
(`AUTOAPP_LAUNCHER_PID`, `processAlive`); the child drains and exits on `disconnect`, or when a
three-second watch finds the launcher's pid gone. Docs: the README's "Stopping it", `security.md`
(`status`, `stop`, `launcher.quit`), `intents.md` (refusals, host build, repeated refusal, stopping),
and two backlog rows. `ci.yml`: `autoapp-stop` runs on every platform. The smoke has a `stop` step.

## Asked for in the report

- **A spoke turn's steps are under its run id: yes.** Test 2 shows it, and so does the real store. In the
  copied root, `getRun('intent-2-0001-store-image-and-settings-a1')` returns 73 steps and `-a2` 56, the
  builder's own calls included.
- **The constant:** none existed. `'Nothing was built.'` was a literal in `verdictOf`. It is now
  `NOTHING_BUILT`, and the refusal sentences are placed after it by value.
- **How the host's build is marked:** the run store has no field for who asked. `runs.caller` is set once per
  run from the first step, and `steps` has no caller. The host's call carries the request id
  `<runId>:host-build`, so its steps are `…:host-build.build`, `.preview` and `.check`, under the turn's run
  id. It also writes one knowledge `log` event, "the host built what turn <runId> left unbuilt…", with
  `call_id` `host-build`, plus one event for each standing answer it gives.
- **What Bun delivers when the parent is hard-killed:** on **macOS** (Bun 1.4.0), a parent killed with
  `SIGKILL` delivers `disconnect` to the child within about 0.5 s, and `process.ppid` becomes 1. I
  measured it with a two-script probe, and test 13 passes. **Linux and Windows: not measured here.**
  Test 13 is on CI's per-platform line: `SIGKILL` on Linux, `taskkill /F` on Windows. The pid watch
  covers either platform if no `disconnect` arrives. CI was not run for this commit.
- **Whether the host's call sits inside "every mutation passes one gate": yes, with one strain.** It is
  `tools['candidate.cycle'].execute`, and the gate's `guard` is inside it. The gate asks the
  approver for the cycle and for each step, and records each step (`confirmed` by the standing answer).
  The strain is **channel identity**. The table says the adapter that *received* a request sets its
  channel, but no request arrived here: the executor makes the call and sets `channel: 'ai'`,
  `caller: ai:<runId>`. Those are the turn's own values. They keep it under the builder's policy row,
  and no model chose them. Like 13c's standing answer, a record cannot tell the host's call from the
  builder's except by its request id. The `answeredBy` backlog row would now want a `madeBy` too.

## Deviations, and decisions I made

1. **Unbuilt includes "never built"**. `editsSinceBuild` is false when `builtFromRev` is null, so the host
   also builds when nothing was ever built and the workspace changed since the task began. This is
   the case in the failure this prompt came from.
2. **The input memory keeps one last error per tool per run**, not one per run. A model that
   alternates between two tools would otherwise never see an example. It sits outside the gate, so
   the record keeps the tool's own words and one error groups as one refusal.
3. **Cut order:** older attempts, then the diagnosis, then **Came back:**, then the newest attempt's
   **Refused:**, then its **Changed:** paths are trimmed to three. The prompt placed Refused after the
   diagnosis and before the paths but did not place Came back; I put Came back before Refused.
4. **The "still running" line goes through `log.warn`, not `announce`.** 14b made `announce` the one
   caller that prints whole, "for an address a person must open and nothing else", and a test holds
   its callers to a list. This line has nothing to redact. It prints after the panel has been closed
   for three seconds, so a reload does not trigger it. A panel open for less than the one-second poll
   is never seen. The test holds its panel open for 1.5 s.
5. **Exiting.** SIGTERM used to race the tab's `onShutdown` against `process.exit(0)` from
   `stopChildrenOnExit`. 13a saw WAL files left behind, which may be why. Now the panel's stop is
   `running.stop()`: the executor, AI, control file, children and stores are all closed before `main`
   calls `process.exit(code)`. A five-second unref'd fallback covers a return that never comes.
   `serve <appId>` stops as before.
6. **Existing tests changed, no assertion loosened:**
   - 13d's "a second attempt that only builds…": attempt 1 is now ended by the idle limit. That is the
     only way its edits are left unbuilt now. The test also asserts that attempt had no host build.
   - `autoapp-task-context` test 5: the host builds attempt 1's single example, so its first reason is
     now `No example named …-c2 was run.`, not `Nothing was built.`
   - `autoapp-mcp`: the fake `ControlClient` gains `status` and `stop`.
7. **Smoke:** `stop` is spawned, not `spawnSync`'d. A parent holding its loop cannot reap the launcher,
   and `kill(pid, 0)` then sees a zombie for the full fifteen seconds. A shell reaps its children, so a
   person never meets this.
8. **Section 2b does not apply to Quit.** It is launcher UI, not a renderer kind or a panel component,
   as in 12k and 13a. Native buttons, a focus-visible ring from `--launcher-accent` on rail buttons and
   `.launcher__button`, `aria-expanded`, Escape to cancel, and colours only from the `--launcher-*`
   pairs.
9. **The "edits were refused" sentence counts `source.edit` and `source.change` only**, not every
   `source.*` route as written. The by-hand replay showed a refused read being called an edit.
10. The worktree had no `dist/` until `build:assets` ran. Before that, the preview children could not
   start. The commit trailer names Claude Opus 5, per this session's attribution rule. The report runs past 100 lines because of the by-hand replay, as 12h and 13b–14a did.

## Commands run

```
bun run typecheck                                                        exit 0
bun test tests/autoapp-intent-run.test.ts tests/autoapp-task-context.test.ts tests/autoapp-engineer.test.ts   pass
bun test tests/autoapp-spike.test.ts tests/autoapp-mcp.test.ts tests/autoapp-stop.test.ts                     pass (stop: 11)
bun run --cwd packages/broapp-autoapp build:page                         launcher-page.html 1328.0 KiB
bun run --cwd packages/broapp-autoapp build:launcher                     dist/broapp-autoapp 77.7 MB
bun run scripts/autoapp-smoke.ts                                         every step passed ("✓ stop — exit 0; status: nothing is running")
bun install && bun run check                                             exit 0; 934 pass, 0 fail, 54 files
git diff --stat tests/ai-chat.test.ts packages/broapp                    (nothing)
```

## The by-hand replay

On 2026-09-18, 15:56–16:14 UTC. The real root was copied first, with every SQLite database copied by
`VACUUM INTO` on a read-only connection. Only `background-remove`, `launcher/` and the journal were
copied; the other two apps, `evaluate/` and `trash/` were left out. The copy ran with this commit's
compiled launcher, `open --no-open --no-restore`. Run was pressed as `launcher.intentRun` over the
panel's own bridge, on the same model (`z-ai/glm-5.3`, from the copy's Settings, with the copy's own
key). Intent 2, task `0001-store-image-and-settings`, started at `failed`, 2 attempts.

- **What attempt 3 was told.** Its documents were `digest`, `attempts`, `intent`, `evidence`. The
  attempts document had **Refused:** under both earlier attempts: `source.edit ×6: message: expected a
  string` and `×4: not found in src/host/store.ts` for attempt 1, and `source.edit ×10: message: …`
  and `candidate.cycle ×2: create: expected an array` for attempt 2. It also had the planning model's
  diagnosis.
- **What it did.** 17 calls, all reads (9 `source.read`, 3 `spec.reference`, 2 `source.search`, …),
  with no edit and no cycle, then silence until the 8-minute idle limit. So nothing was refused twice
  and no example was shown; the transcript has no "A valid input looks like". Its only refusal was one
  `source.read` of `node_modules/broapp/package.json`.
- **The host did not build**, correctly: the turn was aborted by the idle limit and had no edits.
- **The verdict:** "Nothing was built. 1 edit was refused; most often: node_modules/broapp/package.json
  is not part of this application's source. …" This is **a fault the replay found, and it is fixed**:
  a refused read was counted as an edit. The edits sentence now counts `source.edit` and
  `source.change` only, and the verdict test now includes a refused read.
- **Turn 4** failed at the provider on its first request: OpenRouter was out of credit ("can only afford
  81545"), and the launcher's copy of that line had the key's id `<redacted>`. That was a provider
  ending, so the task went to `interrupted` with the attempt given back, and the intent `stopped` with
  "The AI provider returned an error while building …". No advice was asked, so there is none to
  record. **The key needs topping up** before the next hosted run.
- **Quit** from the panel (`launcher.quit`): it answered `{ stopping: true }` and the launcher exited 0.
  Afterwards `status` said "No launcher is running over this root." and `pgrep` over the copy's path
  found nothing.

What this replay supports: the attempts document and the verdict carry the refusals from the real
store. On this model, the attempt after the refusals did not edit at all; it read and went silent,
which is 14a's silent shape and not the refused-input shape. A second run with credit would be needed
to see a repeated input refusal meet its example.

## Acceptance criteria

| Criterion | Result |
|---|---|
| A task failed on refused builds names the tool, count and error; the advice and the next attempt are told | pass (tests 2, 6, 7; by hand the next attempt was told; advice not reached by hand, out of credit) |
| A turn that ends on its own with unbuilt edits is built once by the host and judged on it | pass (test 5, and the aborted and self-built cases) |
| The second identical input refusal shows a valid input; every example held to its schema | pass (tests 3, 4) |
| `stop`, `status`, Quit exist; none reaches the engineer or MCP | pass (tests 9–12) |
| A child exits within 10 s of its launcher's death on all three platforms | macOS pass (test 13); Linux and Windows on CI's line, not yet run |
| A closed panel is followed by one line | pass (its own test) |
| No looser input; `ai-chat` unchanged; no `packages/broapp` change; `check` green | pass |

## Open questions

- Linux and Windows for test 13 and `disconnect`: the first CI run of this commit answers them.
- `stop` counts a zombie as alive. A launcher whose parent never reaps it reads as "did not stop".
- One orphan was on this machine during the work: a `--child` from 14b's seed in the main checkout
  (pid 13591), whose launcher had gone. It predates the watch, and I left it alone.
