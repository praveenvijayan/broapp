# 07 — The engineer service

## What was built

- **Core change (named in the prompt).** `AiAppDescription.instructions`,
  appended verbatim after the purpose and before the rules in the system
  prompt.
- `src/engineer/workspace.ts` — `readTree`, `readWorkspaceFile`, `snapshot`,
  `applyChange`, `diffSummary`. Every path is resolved and contained; writes are
  limited to `src/` and `autoapp.json`; changes are committed with git or kept
  in `source-history/`.
- `src/engineer/instructions.ts` — 58 lines, five sections.
- `src/engineer/state.ts` — the per-application candidate state, whose preview
  URL never leaves the host.
- `src/engineer/tools.ts` — the ten tools, every one a `guardedTool`.
- `src/launcher/contract.ts`, `app.ts`, `tab.ts`, `ui/` — the launcher as a
  Broapp application, with the engineer in a side column.
- `src/launcher/main.ts` — `serve` with no application opens the launcher's own
  tab; `open` does the same.
- `scripts/build-page.ts` and a `build:page` step, so the launcher's page is
  inlined into its binary the way an application's is.
- `tests/autoapp-engineer.test.ts` — 19 tests.

## Deviations, and why

1. **The launcher's tab is ordinary React, not the renderer.** The prompt allows
   this where the renderer's primitives are not enough, and two of the things
   this tab must do — open a browser tab at an address it was just handed, and
   show a failed build's problems — are not expressible as a view
   specification. `launcher.viewsGet` was therefore dropped.
2. **`launcher` is not a reserved route group.** Nothing but the AI layer is
   ever mounted on the launcher's bridge, so `createHostApp` suffices and no
   core change was needed.
3. **`createLauncherTab` assembles the tab**, so a test can build the same thing
   without a compiled binary.
4. **`buildCandidate` now refuses a change the release identity cannot
   represent** — see the finding below.
5. **`hasGit` asks whether the workspace is a repository *of its own***, not
   whether it is inside one. This is not hypothetical: before the fix, the
   workspace test's `applyChange(..., 'break it')` ran `git add -A` and
   `git commit` with the *repository's* work tree, and committed this whole
   repository under the message `break it`. That commit has been squashed away
   and the working tree is unchanged, but it is the clearest possible argument
   for the check: an agent editing a workspace inside somebody's checkout would
   otherwise write into their project's history.
6. The commit trailer names Claude Opus 5, per this session's attribution
   instruction.

## The demo

**Provider.** The prompt asks for a real provider. The only one reachable here
without sending anything off this machine is the **local Ollama**, so the demo
ran against `qwen3.8:27b-mlx` over `http://127.0.0.1:11434`. Nothing left the
computer. (`glm-5.2:cloud` was listed and deliberately not used.)

### What happened

| Step | Outcome |
|---|---|
| 1. `serve`, launcher tab opens | Tab loaded, "Connected", Notes listed after `import` |
| Settings → Ollama | Provider listed its five local models; "Connected to Ollama (local). (14 ms)" |
| 2. Open Notes, create three notes | `launcher.appOpen` returned a launch URL, the tab opened it, the row showed `yes (pid …)` and `schema 2`. Three notes created |
| 3. "Add tags and an Archive action…" | **Did not complete.** See below |
| 3′. A smaller request | Completed the whole loop — see below |
| 4. Tool sequence | `spec.read`, `source.list`, 8 × `source.read`, then (on the smaller request) `source.change`, `candidate.build`, `candidate.preview`, `candidate.check`, `candidate.explain` |
| 5–8. Preview, grant, activate, workflow | **Not reached** by the model. Each is covered by a test instead |

### Where the large request stalls, exactly

The engineer read the specification and eight source files — correctly, unaided,
and in the order its instructions give — and then spent **22 minutes** composing
the `source.change` call without emitting it. The turn never failed; it was
still generating when I stopped it.

The cause is the tool's shape, not the model's competence. `source.change` takes
the **whole new contents** of every file it touches. The tags-and-archive change
needs `contract.ts`, `db.ts`, `operations.ts`, `views.ts` and `autoapp.json`
rewritten in full — several thousand lines of generated tool arguments, in one
uninterrupted structured emission, on a 27B model running locally.

The second, much smaller request confirms the diagnosis rather than the
alternative. Told to change one small file and explicitly told not to read
first, the model **refused**, in its own words: *"I can't do that without
reading first — guessing autoapp.json's contents and overwriting the whole file
risks clobbering the existing acceptance list."* It then read the file and
produced a correct `source.change` — which took a further nine minutes for a
1.5 kB file. So the tool works, the model follows its instructions, and the
cost is linear in the size of the files rather than in the size of the change.

**This belongs in prompt 10's backlog: `source.change` needs a patch shape** — an
anchored replacement, or a line range — so the cost tracks the edit rather than
the file.

### What the smaller request proved

Every step of the gate behaved as designed, against a real model:

- `spec.read`, `source.list`, `source.read`, `candidate.check` and
  `candidate.explain` ran with nobody asked — they are `read`.
- `source.change`, `candidate.build` and `candidate.preview` each stopped and
  showed **Allow / Decline** in the chat, and ran only after Allow.
- The change landed correctly: `count-empty` appended, both migrations and all
  three existing acceptance examples intact, committed as
  `Add acceptance example count-empty calling notes.status`.
- The launcher's own panel updated to "Changed: autoapp.json" and then
  "Built 899a7406.", with "Open preview" and "Activate".

## A real bug the demo found

`releaseId` is the hash of the page, the host bundle and the exported contract —
fixed by `00-common-rules.md`, so I have not changed it. The consequence is that
**a change touching only `autoapp.json` hashes to the release it came from.**
`writeRelease` refused it as a conflict, and `buildCandidate` reported
`ok: true, rebuilt: false` — a success. The stored release kept the old
specification, so the engineer's new acceptance example would never have run,
even though the panel said "Built".

The identity stays as the rules fix it. What changed is that the outcome is now
honest: `buildCandidate` compares the stored specification with the one it just
assembled, and when they differ it fails with a `spec` problem saying so.

**For prompt 10:** acceptance examples, migrations metadata and capabilities are
part of a specification but not of a release's identity, and `activate` runs the
acceptance examples as its check step — so a person can add a check that can
never reach a release. Either the identity should cover the whole specification,
or `autoapp.json` should not be able to change without something else changing.

## Commands run

```
bun run typecheck                            exit 0
bun test tests/autoapp-engineer.test.ts      19 pass, 0 fail
bun run --cwd packages/broapp-autoapp build:launcher   dist/broapp-autoapp
bun run check                                exit 0 - 402 pass, 0 fail (27 files)
```

## Acceptance criteria

- **Every engineer action is a `guardedTool`** — pass:

  ```
  $ grep -n "execute" packages/broapp-autoapp/src/engineer/tools.ts
  7: * There is no bare `execute` in this file, and a test greps for one.
  ```

  The only match is the comment saying so.
- **The model never receives a URL or a secret path** — pass. A test drives
  seven tools through a real preview and asserts the combined output contains no
  `127.0.0.1:<port>`, no `?bt=`, and not the launcher root's path. Confirmed
  again live: `candidate.preview` returned `{ ok: true }` and the person opened
  the preview from the tab.
- **The demo's steps are recorded with outcomes, and which the model completed
  unaided** — above. Unaided: steps 1, 2, and the whole tool loop for the
  smaller change. Not completed: step 3 as written, and therefore 5 to 8.

## Open questions

- The engineer needs a patch-shaped `source.change` before the demo's step 3 is
  reachable on a local model. A hosted model would very likely complete it as
  written; that is untested here, because testing it would mean sending this
  repository's source to somebody else's computer.
- `launcher.appsList` reads every release directory on every call. Fine for a
  handful of applications.
- The launcher's tab polls `candidateStatus` every two seconds while it is open.
  The engineer's tools run on the host and nothing pushes their results; a
  stream would be better.
