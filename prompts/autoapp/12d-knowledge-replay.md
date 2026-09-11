# 12d — Replay and evaluation: evidence a person can confirm on

## Goal

A provisional lesson says what would have avoided a failure. Nothing yet tests that
claim. After this prompt a case can be replayed: the engineer is run again on the
original request from the original source revision, with the lesson and without it,
several times each, with every other lesson frozen out, and the unchanged acceptance
example (or the failing build stage) decides. The result is shown to the person who
runs `knowledge confirm`; it does not confirm anything by itself. The same harness
runs the evaluation that decides whether the knowledge path moved the measured
blocker: four conditions, three tasks, three runs each.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report so far, 12a–12c and their
  reports with care; report 08c's demo table is the baseline shape.
- `packages/broapp-autoapp/src/knowledge/*`.
- `packages/broapp-autoapp/src/launcher/tab.ts`, `candidate.ts`, `snapshot.ts`,
  `supervisor.ts` (`migrate`), `workspace.ts` (`prepareWorkspace`, install hooks),
  `engineer/tools.ts` (`candidate.check` over IPC).
- `scripts/autoapp-smoke.ts` — how a script drives the launcher end to end without a
  browser; `tests/autoapp-launcher.ts` (`ensureLauncher`).
- `packages/broapp/src/ai/host/create-ai.ts` (`maxSteps`, `contextBudgetChars`).

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| A replay is a manifest | Written before anything runs, as a blob, and stored on every result row. It names: episode id; `source_rev_before`; `release_before`; the data snapshot for a check case; the `package.json` and lockfile hashes; the request blob; the instructions blob; the example blob; model provider and id; `autoapp_version`; the lesson under test; `runs` per arm; `maxSteps`. |
| Arms | `with` and `without`. Each run of each arm starts from a fresh `git worktree`-free checkout (`git archive` of `source_rev_before` into `<root>/replay/<episodeId>/<arm>/<n>/source/`), the workspace's own vendored `node_modules` symlinked in, and for a check case the data snapshot copied as its data directory. Nothing from the live application is touched. |
| Frozen corpus | The replay's `createServe` is built with a lesson filter that admits only the lesson under test (`with`) or nothing (`without`). Curated facts are excluded from both arms so the advice cannot arrive as a hint. Orientation and task evidence stay on in both arms — they are not the thing under test. |
| Success | A build case: `stagesRun` includes the failing stage and no problem carries the episode's signature. A check case: the example, by its original hash and content, passes on a preview of the replayed candidate. Activation is never part of success. |
| Isolation of records | Every replay run uses its own `createLauncherTab` over the replay directory with a knowledge database of its own (`<root>/replay/<episodeId>/knowledge.sqlite`), logging with `source='replay'`. The production database receives only the `replays` rows. No serving, episode or context from a replay is ever visible to a learning query — the databases are different files. |
| Verdict | Shown, not applied. `knowledge confirm <id>` prints the replay table and the regression result and asks `y/N`; `--yes` skips the question. A lesson that passes with and without is reported `unrelated`; one that fails both ways `no effect`; one that passes only with `supports`. No thresholds are encoded as promotion rules in this prompt. |
| Regression set | Every resolved case of the application whose lesson is confirmed, replayed once in the `with` arm of the new lesson plus the confirmed corpus. A regression that fails is printed; it does not block. |
| Step cap | Every replay and evaluation run uses `LAUNCHER_MAX_STEPS` (12c) and records it in the manifest and the table. The 08c and 12b baselines ran under the default 8; say so beside their numbers rather than comparing across caps silently. |
| Model | The configured provider through `Ai.model()`. A replay with no model configured says so and exits 2. Tests run the harness on the fake adapter with scripted arms and assert the bookkeeping, never a verdict. |
| Evaluation | `knowledge evaluate` runs the 12b baseline task and two more from `templates/autoapp-starter` and `examples/notes` under four conditions and writes one Markdown table; the report copies it. |

## Step 0 — two carry-overs from the 12c review

1. **A hint with no stage gets credit for everything.** Report 12c: seed 6 (the MCP
   fact) has no `applies.stage`, matched the one word "effect", was hinted for a
   `contract` failure and was scored `resolved` beside the lesson that actually
   applied. Change `hints()` in `serve.ts` so a lesson is offered as a hint only when
   its `applies.stage` equals the problem's stage; a lesson with no stage is never a
   hint (it can still be served to a turn). Give seed 6 `applies.stage='contract'` if
   it is meant to be hinted there, else leave it stageless. Test: a stageless lesson is
   not hinted; a same-stage one is.
2. **Count false credit.** In the evaluation table, add a column *hint servings
   resolved whose lesson's stage or routes did not match the failing problem*, computed
   from `servings` joined on `lessons.applies`. That number is the association noise
   the person confirming a lesson should see; print it in `knowledge show` beside the
   outcome counts as "of which unrelated by stage: n".

## Step 1 — `knowledge/replay.ts`

```ts
export interface ReplayManifest { … the fields in the decisions table … }
export interface ReplayResult { arm: 'with' | 'without'; n: number; outcome: 'passed' | 'failed' | 'inconclusive'; steps: number; ms: number; tokens: { input: number; output: number }; buildReached: boolean }
export interface ReplayOptions { knowledge: Knowledge; layout: Layout; episodeId: number; lessonId: number | null; runs?: number; model: () => Promise<LanguageModel>; providers: readonly ProviderAdapter[]; logger: HostLogger; install?: PrepareOptions['install'] }
export function manifestFor(options: ReplayOptions): ReplayManifest;
export async function replay(options: ReplayOptions): Promise<{ manifest: ReplayManifest; results: readonly ReplayResult[] }>;
```

Schema, one migration:

```sql
CREATE TABLE replays (
  id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL, lesson_id INTEGER, arm TEXT NOT NULL, n INTEGER NOT NULL,
  outcome TEXT NOT NULL, steps INTEGER NOT NULL, ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  build_reached INTEGER NOT NULL, manifest_blob TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX replays_lesson ON replays(lesson_id, at);
```

One run: prepare the directory; build a `createLauncherTab` over a `Layout` rooted at
the run directory with the frozen `createServe`, the 12a log at `source='replay'`, the
fake or real providers, `install` injected to do nothing (dependencies are the symlink);
send the request as one `ai.chat` turn through the same in-process path
`tests/autoapp-engineer.test.ts`'s `start` uses (no browser, no bridge: call
`runChat`'s route through `host.stream` the way the harness does, or expose a
`tab.ai.turn(message)` helper for scripts — choose one and say which); when the turn
ends, run `candidate.build` yourself and, for a check case, `candidate.preview` +
`candidate.check` on the original example; record the result; stop every child;
remove nothing (a person may want to look), but cap the replay directory by deleting
the oldest runs beyond 20 per episode on the next replay.

## Step 2 — the commands

`knowledge replay <episodeId> [--with <lessonId>] [--runs n]`: prints the manifest
summary, then one line per run as it finishes, then the two arms side by side and the
verdict word. `knowledge confirm <id>` (12c) gains the table and the regression pass
when `replays` rows exist for the lesson, and says "no replay has been run; `knowledge
replay …` first" when they do not — it still allows confirmation, because a person may
have other evidence.

`knowledge evaluate [--runs n] [--out <path>]`: the three tasks —

1. the 08c Notes request, on `examples/notes` imported fresh;
2. "add a `done` filter to the items table" on the starter;
3. "add tags to notes and a filter by tag" on Notes (touches contract, migration, views
   and an acceptance example);

under four conditions — `baseline` (no `context` at all, the launcher as it was before
12b), `orientation` (digest only), `orientation+facts` (12b as shipped), `learned`
(12b plus every provisional and confirmed distilled lesson) — `n` runs each, on the
configured model. Verified completion is the task's acceptance example passing on a
preview: the command adds that example to the workspace before the run, by hash, and
never changes it. Output columns: condition, task, runs, verified, mean tool calls to
first `source.edit`, mean tool calls to first `candidate.build`, runs that reached a
build, mean ms, mean tokens, signatures recurring from earlier runs, included refs
then read or edited, included refs ignored, files read that were not offered. Written
as Markdown to `--out` (default stdout).

## Step 3 — docs

- `docs/autoapp/learning.md`: what a replay is and is not (same machine, same vendored
  dependencies, a copied snapshot; not the same model sample, not the same
  conversation); the three verdict words; that confirmation stays a person's.
- `docs/autoapp/backlog.md`: the automatic-promotion row's precondition becomes
  "twenty confirmed lessons whose replay verdict matched the person's decision, and a
  written rule derived from them"; the run-timeout row is resolved one way or the
  other from the evaluation.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-knowledge.test.ts
bun test tests
bun run check
```

New cases, on the fake adapter, with scripted arms:

1. `manifestFor` on a resolved build case names every field; the blob is stored and
   its hash is on each result row.
2. A replay of a build case with `runs=2`: four run directories exist under
   `<root>/replay/<id>/`, each a checkout of `source_rev_before`; the `with` arm's
   replay database has a `contexts` row whose `included` names `lesson:<id>` and the
   `without` arm's does not; no curated lesson appears in either; the production
   database gained exactly four `replays` rows and no `servings`, `episodes` or
   `contexts` rows.
3. A check case copies the snapshot into the run's data directory and runs the example
   by hash; the outcome is what the scripted arm produced.
4. `knowledge confirm` prints the table when rows exist and confirms only on `y` or
   `--yes`; with no rows it prints the "no replay" sentence.
5. A run whose child dies is `inconclusive`, not `failed`.
6. `knowledge evaluate --runs 1` on the fake adapter produces a table with every
   column for every condition and task, from a scripted turn that makes one edit.

## Acceptance criteria

- A case replays from its manifest into fresh directories with a frozen corpus, and
  the production learning records are untouched by it.
- `knowledge confirm` shows the person the with/without table and the regression
  result and leaves the decision to them.
- `knowledge evaluate` produces the four-condition table from real runs on the
  configured model.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12d-knowledge-replay.md`. Include the evaluation table from a
real run on the same local model as 08c and 12b (`--runs 3`); the replay table for at
least one distilled lesson; a sentence on each: did orientation alone move tool calls
to first edit; did guidance move the share of runs reaching a build; did any learned
lesson change verified completion; how often the verdict was `unrelated`. Update
`docs/autoapp/backlog.md`'s "What was measured" with the new numbers beside the old.

## Commit

```
Replay a case with and without its lesson, and measure the path

A resolved case replays from a manifest into fresh checkouts with every
other lesson frozen out, several runs per arm, judged by the unchanged
acceptance example or the failing build stage. The person confirming a
lesson sees the table; nothing is promoted by a number. The same harness
runs the four-condition evaluation against the 08c baseline.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
