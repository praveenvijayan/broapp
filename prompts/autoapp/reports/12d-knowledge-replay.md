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
6. **Canonical comparison in acceptance checks.** A case's example is stored as canonical JSON, keys sorted; `JSON.stringify` said `{items,count}` ≠ `{count,items}`. One definition of "passed", now order-blind for objects, for `candidate.check` too.
7. **The evaluation test runs `evaluate()` in a child process.** Under `bun test tests` (filter form — the gate's) `Bun.build` cannot resolve a package in a nested `node_modules` (`@brobridgejs/core`, `@ai-sdk/*`); `bun test ./tests/…` and `bun run` can. Probed both ways; `Bun.resolveSync` is fine in both. Notes' host needs those packages.
8. **12c carry-over: the distiller's length refusal.** `refusal()` measured summary, detail and trigger against 400; the schema the model is shown allows detail 2,000. The first real distillation here was `knowledge_missing` with a lesson, dropped for "longer than 400 characters". Each field is now held to its own schema limit; a test covers it.
9. **A turn has 20 minutes** (`DEFAULT_TURN_TIMEOUT_MS`), in the manifest; a run that runs out is judged by what it left. Without a limit one silent turn stops a measurement.
10. **Cases record no data snapshot** (12a never set `data_snapshot`), so a check case is replayed on a copy of live data taken at its first replay; the manifest says `from: live`. Backlog row added.
11. Existing test changed: 12c's `weak` lesson gained `stage: 'views'` (a stageless lesson is no longer hinted). Commit trailer names Claude Opus 5, per this session's rule.

## The real runs

Local Ollama, `qwen3.8:27b-mlx`, as 08c/12b/12c; nothing left the machine, no key entered.

TBD-DISTIL

TBD-REPLAY

TBD-EVAL

## Commands run

TBD-COMMANDS

## Acceptance criteria

TBD-ACCEPTANCE

## Open questions

TBD-OPEN
