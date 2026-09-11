# 12d — Replay and evaluation

## What was built

- **Core** (`create-ai.ts`, `index.ts`): `Ai.turn(turn, { answer, signal, onEvent })` runs the `ai.chat` loop in-process — same tools, gate, context providers and hooks — with `answer` standing where the person's click would. Chosen over driving `host.stream`: there is no browser or bridge in a replay, and the harness is test-only.
- `knowledge/harness.ts`: `prepareRun` (a `git clone` at the revision, `node_modules` linked, release copied and made current, data copied by `VACUUM INTO`) and `openRun` (the launcher tab over the run directory with its own store; answers yes to edits, builds and previews, no to activation and creation).
- `knowledge/replay.ts`: `manifestFor`, `replay`, `regression`, `copyLessons`, `runReplayCommand`. `knowledge/evaluate.ts`: the three tasks, four conditions and the table; `runEvaluateCommand`. `knowledge/verdict.ts`: the table and the word, pure, shared with `confirm`.
- Schema: migration 2, `replays` (+ index). Retention keeps manifest blobs.
- `serve.ts`: `corpus` (`pinned`, `match`), `documents`, `seed`; hints need exactly the problem's stage. Tab: `serving` (`'off'` = before 12b) and `distil`.
- Step 0: `unrelatedHintCredit` in `scoring.ts`; `show` prints "of which unrelated by stage: n"; the evaluation has the column.
- `engineer/check.ts`: `runAcceptance`, shared by `candidate.check` and the judge.
- CLI: `knowledge replay`, `knowledge evaluate`, `confirm [--yes]` with the table and `y/N`. Docs: `learning.md` (Replay, Evaluation), `backlog.md`.
- Tests: 9 new in `autoapp-knowledge.test.ts` (the prompt's 6, step 0 ×2, the distil limit), 1 in `ai-host.test.ts`; `tests/autoapp-evaluate-child.ts`.

## Deviations, and why

1. **A clone, not `git archive`.** The checkout's `HEAD` is then the manifest's revision, so the rows a run writes carry it; nothing is registered in the live repository, which is what "worktree-free" asks. Workspace: `<run>/apps/<appId>/source/`, where a `Layout` rooted at the run puts it.
2. **`manifestFor` is async**: it asks the model first, so a replay with none fails before touching disk (exit 2).
3. **The `with` arm pins the lesson** to every turn, words or not; `included` names the `lessons:<appId>` document and `resolved` names `lesson:<id>` (lessons are one document since 12b). Test 2 asserts both.
4. **A fourth verdict word, `against`** (passed only without), and `inconclusive` when an arm has nothing to judge.
5. **Regression rows are `replays` rows with `arm = 'regression'`,** run by `knowledge replay --with` after the arms; `confirm` prints them and never runs a model.
6. **Canonical comparison in acceptance checks.** A case's example is stored as canonical JSON, keys sorted; `JSON.stringify` said `{items,count}` ≠ `{count,items}`. `candidate.check` and the judge became order-blind. **This first said "one definition of passed"; there were two** — `activate` kept its own `JSON.stringify` copy, so a stored example could pass a preview and fail activation. A later review found it; `activate` now calls `runAcceptance` too, and `candidate.check` refuses a preview of another release.
7. **The evaluation test runs `evaluate()` in a child process.** Under `bun test tests` (filter form — the gate's) `Bun.build` cannot resolve a package in a nested `node_modules` (`@brobridgejs/core`, `@ai-sdk/*`); `bun test ./tests/…` and `bun run` can. Probed both ways; `Bun.resolveSync` is fine in both. Notes' host needs those packages.
8. **12c carry-over: the distiller's length refusal.** `refusal()` measured summary, detail and trigger against 400; the schema the model is shown allows detail 2,000. The first real distillation here was `knowledge_missing` with a lesson, dropped for "longer than 400 characters". Each field is now held to its own schema limit; a test covers it.
9. **A turn has 20 minutes** (`DEFAULT_TURN_TIMEOUT_MS`), in the manifest; a run that runs out is judged by what it left. Without a limit one silent turn stops a measurement.
10. **Cases record no data snapshot** (12a never set `data_snapshot`), so a check case is replayed on a copy of live data taken at its first replay; the manifest says `from: live`. Backlog row added.
11. Existing test changed: 12c's `weak` lesson gained `stage: 'views'` (a stageless lesson is no longer hinted). Commit trailer names Claude Opus 5, per this session's rule.

## The real runs

Local Ollama, `qwen3.8:27b-mlx`, as 08c/12b/12c; nothing left the machine, no key entered.

**The case** (scratch script, reconstructed as 12c's was): Notes imported; request "Add a Mark done button to each row of the notes table…"; a row action on `notes.update` with no `confirmText` fails at `views`; adding it passes. The instructions never mention `confirmText`. Views seeds 1 and 5 were hinted for it and credited `resolved` — stage-matched, still unrelated.

**Distillation** is the weak link on this model: 6 case runs, 14 questions, 2 valid answers, both `knowledge_missing` with a lesson. The first lesson was dropped by deviation 8's bug; the second (lesson 8, detail 560 characters, which the old rule would also have dropped) was stored. The 12 failures: 5 unparsable, 4 over the 60 s limit, 3 with `reasoning` over its 600-character schema limit.

**Replay of case 1 with lesson 8** (`knowledge replay 1 --with 8 --runs 3`, 40 steps, 20 min a turn):

| run | with | without |
|---|---|---|
| 1 | passed — 15 calls, 3m59s, 128,375 tokens, built | passed — 21 calls, 16m13s, 220,686 tokens, built |
| 2 | failed — 4 calls, 2m34s, 18,419 tokens | inconclusive — provider error after 9 calls, 10m14s |
| 3 | passed — 15 calls, 10m44s, 99,989 tokens, built | passed — 20 calls, 15m50s, 209,120 tokens, built |
| | 2/3 | 2/3 |

Verdict **unrelated**: the build error names `confirmText`, so the engineer repairs it either way. Regression: no other confirmed case. `knowledge confirm 8`, answered `n`, printed this table and left the lesson provisional.

**This batch is contaminated for time.** From 20:01:44 another Claude session ran `knowledge evaluate --runs 1` with the compiled binary against this demo root, on the same local model. Only `with 1` ran alone; the other five shared the model, and `without 2`'s provider error may be that. Outcomes stand; times and tokens are not comparable. I stopped my own evaluation (three minutes in) rather than let it overlap too, and reran the replay and the evaluation after that process exited:

**Not rerun.** The release of 0.4.0 was started before the model was free: the other session's evaluation was stopped at nine of its twelve turns, and mine at four. The replay table above stands, with its timing caveat. A clean replay, one process on the root, is the first measurement to take after the release.

**No evaluation table.** `knowledge evaluate` writes its table only once every cell has run; neither of the two `--runs 1` attempts reached that point (9 of 12 turns, then 4 of 12). Their run directories and stores are still under `<root>/evaluate/` for anyone who wants to read them; no number below is taken from them. The four-condition comparison is therefore **not measured** by this prompt, and the backlog's "What was measured" table says so beside the 08c and 12b numbers.

## Commands run

```
bun run typecheck                                   exit 0
bun test tests/autoapp-knowledge.test.ts            50 pass, 0 fail
bun test tests                                      650 pass, 0 fail (39 files)
bun install && bun run check                        exit 0
knowledge replay 1 --with 8 --runs 3                table above (contaminated for time)
knowledge confirm 8                                 printed the table, answered n
knowledge evaluate --runs 1                         started twice, stopped both times, no table
```

The 0.4.0 release gate was run after this report's commit; its lines are in the
release commit's message rather than here.

## Acceptance criteria

- **A case replays from its manifest into fresh directories with a frozen corpus, and the production learning records are untouched by it** — pass (tests 2 and 3; the real replay wrote only `replays` rows).
- **`knowledge confirm` shows the with/without table and the regression result and leaves the decision to the person** — pass (the real run printed the table; answered `n`; lesson 8 stayed provisional).
- **`knowledge evaluate` produces the four-condition table from real runs on the configured model** — **not met.** The command and its test (test 6, fake adapter, child process) pass; the real run was stopped for the release before any table existed.
- **`bun run check` green; every command above exits 0** — pass at the commit; the evaluation was stopped, not failed.

## Open questions

- **The distiller is unreliable on this model**: 2 valid answers in 14, the failures unparsable, over 60 s, or over the reasoning limit the schema states. Whether a longer limit or a smaller answer shape fixes that is 12c's question, measured here, not changed here.
- **Stage matching still credits unrelated hints.** Views seeds 1 and 5 were hinted for a `confirmText` failure and credited `resolved`. `applies.files` or `routes` would narrow a hint further; the column counts routes only.
- **The verdict word hides cost.** "Unrelated" holds when the lesson changes nothing but time and tokens; the table shows them, the word does not.
- **Nothing stops two processes sharing a root.** Another session's `knowledge evaluate` ran against this demo root during the replay (see above). The backlog's multiple-instances lock would have refused it.
- **A tool's own input check reads as "The tool failed."** In the clean replay the model called `knowledge.show` with `lessonId: 0`; the tool's `parse` throws a `ValidationError`, not a `PublicError`, so the model is not told which field was wrong. Every engineer tool parses the same way; predates 12d.
- **`bun test tests` cannot bundle a package from a nested `node_modules`** (deviation 7). A Bun behaviour worth a minimal reproduction upstream.
