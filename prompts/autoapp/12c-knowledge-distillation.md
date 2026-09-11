# 12c — Distillation: provisional lessons, diagnosis, review

## Goal

12a records every failure and its repair as an immutable case. 12b serves curated
facts. Nothing yet turns a case into something the engineer can be told next time.
After this prompt, when a case resolves, the launcher asks the engineer's own model
one structured question about it — what happened, and could the engineer have known —
and stores the answer as a diagnosis and, only when the diagnosis warrants it, a
**provisional** lesson with its provenance, where it applies and what it was written
against. A person reviews lessons from the command line. Nothing is promoted or
retired automatically. The one core change is a way to get the configured model.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report so far, `12a` and `12b` and their
  reports with care.
- `packages/broapp-autoapp/src/knowledge/*`.
- `packages/broapp/src/ai/host/create-ai.ts` (`Ai`, `registry`), `registry.ts`
  (`resolve`), `adapter.ts:49-66` (`model()` and its comment), `fake.ts` (what the
  mock implements), `run.ts:340` (how a tool schema is wrapped with `jsonSchema`).
- `node_modules/ai/dist/index.d.ts`: `streamObject`, `jsonSchema`, `FlexibleSchema`.
  The fake adapter's `MockLanguageModelV4` implements `doStream` only, so the side call
  is `streamObject`; `generateObject` would throw `notImplemented` in every test.
- `packages/broapp/src/shared/schema.ts` (`s.enum`, `s.nullable`, `toJsonSchema`).
- `packages/broapp-autoapp/src/launcher/main.ts` (`HELP`, the command switch, how
  `status` reads the root without a running launcher).

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Core change D | `Ai.model(override?: { modelId?: string }): Promise<LanguageModel>` in `create-ai.ts`: `registry.resolve(override)` then `adapter.model(config, modelId)`. The comment at `adapter.ts:65` becomes "Only `broapp/ai/host` calls this; other host code asks `Ai.model()`." Nothing else in core. |
| The call | `streamObject({ model, schema: jsonSchema(DIAGNOSIS.toJsonSchema()), system, prompt, abortSignal })`, then `DIAGNOSIS.parse(await result.object)`. `jsonSchema` without `validate` validates nothing; the `parse` is the validation. |
| When | From `onRunEnd`, for every resolved episode with `distill_state='pending'`, serialised on one promise chain, each under `AbortSignal.timeout(60_000)`. Never during a turn's own model call; never more than one at a time. |
| Diagnosis | One of `knowledge_missing`, `knowledge_not_retrieved`, `method_unclear`, `method_not_followed`, `tool_or_environment`, `insufficient_evidence`. Always written to the episode. Only `knowledge_missing` and `method_unclear` may carry a lesson. |
| A lesson is provisional | `status='provisional'` on insert. Served (ranked below confirmed, labelled) but never promoted by the launcher. `knowledge confirm` is the only path to `confirmed`; `knowledge retire` the only path to `retired`. |
| Supersession | Same `(applies.signature, scope)` as an existing lesson: the new row sets `supersedes`, the old becomes `superseded` and leaves the FTS index. The distiller is shown the existing lesson and asked whether the cause is the same. |
| Freshness | `recurred ≥ 3` with no `resolved` → `review='needs_review:recurring'`. Served under a different `instructions_hash` than written for, and `recurred ≥ 2` → `needs_review:instructions_changed`. A change of the launcher's major or minor version → every distilled lesson `needs_review:autoapp_upgraded`. All three keep `status`; a person decides. |
| Idempotence | `lessons_episode` is unique; a second distillation of the same episode is a no-op. `distill_attempts` is bumped in the transaction that reads the row; `failed` after three. |
| Isolation | The distiller reads blobs, never live files: the request, the instructions and documents as delivered, the example content, the edits, both revisions, and the last 20 events for the app in the window. What the engineer knew is what the `contexts` row says it was given, at `corpus_version`. |
| Guardrails | `sanitise()` on every string; drop the lesson (keep the diagnosis) when `summary` exceeds 400 characters, contains an absolute path, a URL with a port, or a secret pattern. |
| Review path | A `knowledge` subcommand on the launcher binary, reading the database directly like `status` does. No UI in this prompt. |

## Step 0 — three carry-overs from the 12b review

1. **The step cap.** Report 12b showed the 08c rerun ending after exactly 8 model
   steps: the AI layer's `DEFAULT_MAX_STEPS`, which the launcher never overrides. A
   loop of read, edit, build, preview, check, explain cannot fit in eight. Add
   `LAUNCHER_MAX_STEPS = 40` in `launcher/app.ts` beside `LAUNCHER_CONFIRM_TIMEOUT_MS`,
   with a comment giving the 12b numbers, and pass it as `maxSteps` in
   `createLauncherTab` (an optional override for tests). The Notes example and every
   other `createAi` caller keep the default. Nothing else about the run loop changes.
   Until this lands, no build happens, so no case resolves, so nothing distils; that is
   why it is first.
2. **Weak matches.** `OR`-joined FTS serves a lesson on one shared word ("list"
   matched the migration seed). In `serve.ts`, after the FTS query, keep a lesson for a
   turn serving only when at least two distinct query tokens occur in its `summary` or
   `trigger`, or its `applies.routes` names a route the evidence document also names.
   Hints keep the stage filter 12b added and need one token. Add both cases to the
   12b matching test.
3. **A missing fact.** The rerun's model said saved workflows do not exist; they do,
   in the runtime (prompt 06), not in the workspace. Add seed 7: *"Saved workflows and
   their promotion to a view action live in the application's runtime and run store,
   not in the source workspace; a request to 'save this as a workflow' is met by
   promoting one from a run, not by editing views.ts."* `applies.stage='views'`.
4. **The symbol index reads through symlinks.** `indexWorkspace` in `path.ts` walks
   `Bun.Glob` without the `within` check `source.search` uses. Pass
   `followSymlinks: false`, skip any entry whose `lstatSync` is a symbolic link, and
   resolve every file through `within(sourceDir, path)` before reading. Test: a
   symlink inside `src/` pointing outside the workspace is not indexed and the
   evidence document never names it.
5. **`source.search` compiles a model-supplied regex with no guard.** In
   `searchWorkspace` (`workspace.ts`): cap `pattern` at 200 characters; refuse with
   `invalid_input` a pattern that applies a quantifier to a group containing a
   quantifier (`/\([^()]*[+*][^()]*\)\s*[+*{]/` is enough for the known catastrophic
   shapes); test each line against at most its first 1,000 characters. Test: `(a+)+b`
   is refused; a 300-character pattern is refused; a literal still matches.
6. **The per-run scratch map in `serve.ts` leaks** when a turn throws between
   `search` and `onContext`. Evict an entry in `scoreRunEnd` for its run and, on every
   `search`, drop entries older than one hour. Test: a run that never delivers is gone
   after `scoreRunEnd`.

## Step 1 — `Ai.model()`

Four lines in `create-ai.ts`, exported on `Ai`; a test in `tests/ai-host.test.ts`
proves it returns the fake's model instance and throws the registry's `unavailable`
error when nothing is configured. `adapter.ts` comment updated.

## Step 2 — `knowledge/distil.ts`

```ts
export const DIAGNOSES = ['knowledge_missing','knowledge_not_retrieved','method_unclear','method_not_followed','tool_or_environment','insufficient_evidence'] as const;
export const DIAGNOSIS = s.object({
  diagnosis: s.enum(DIAGNOSES),
  reasoning: s.string({ max: 600 }),
  sameCauseAs: s.nullable(s.number()),          // an existing lesson id, when the cause is the same
  lesson: s.nullable(s.object({
    scope: s.enum(['global', 'app']),
    applies: s.object({ stage: s.optional(s.enum([...BUILD_STAGES, 'check'])), files: s.optional(s.array(s.string({ max: 120 }), { max: 5 })), routes: s.optional(s.array(s.string({ max: 80 }), { max: 5 })) }),
    summary: s.string({ min: 20, max: 400 }),
    detail: s.string({ min: 20, max: 2000 }),
    trigger: s.array(s.string({ min: 3, max: 40 }), { min: 3, max: 8 }),
  })),
});
export interface Distiller { enqueue(episodeIds: readonly number[]): void; idle(): Promise<void>; close(): Promise<void> }
export function createDistiller(input: { knowledge: Knowledge; log: EventLog; model: () => Promise<LanguageModel>; instructions: string; autoappVersion: string }): Distiller;
```

The system prompt to the distiller is fixed text in the file, and it carries the
attribution test in these words: *"You are reviewing one failure the engineer hit and
the repair that followed. You are shown exactly what the engineer had been told at the
time. Decide which one thing explains the failure: the fact it needed was nowhere in
what it was given (knowledge_missing); the fact existed as a lesson but was not in what
it was given (knowledge_not_retrieved); the instructions covered this but were unclear
(method_unclear); the instructions were clear and were not followed
(method_not_followed); a tool, the build or the environment failed rather than the
engineer (tool_or_environment); or you cannot tell from this evidence
(insufficient_evidence). Write a lesson only for knowledge_missing or method_unclear.
A lesson is one fact or one rule, stated once, that would have let the engineer avoid
this failure. Do not restate the instructions. Do not include paths from this machine."*

The user prompt is assembled from blobs: the request; the instructions as delivered;
each included document, titled; the problem and its stage; the example content for a
check case; the edits with their `matchedBy`; the two revisions; the events; and, when
a lesson with the same `applies.signature` and scope exists, that lesson with its id
and the sentence "this lesson existed when the failure happened and was / was not
among the documents delivered" — computed from `contexts.included` and
`lessons.version ≤ contexts.corpus_version`.

Handling the answer, in one transaction: write `diagnosis` and `distill_state='done'`
to the episode; when `lesson` is present and the diagnosis allows it, apply the
guardrails, then insert with `origin='distilled'`, `status='provisional'`,
`episode_id`, `instructions_hash` (sha256 of `ENGINEER_INSTRUCTIONS`),
`autoapp_version`, `applies.signature = episodes.signature`, `scope` mapped to
`global` or `app:<id>`, `version = next corpus version`, and the FTS row; when
`sameCauseAs` names an existing lesson, set `supersedes` and mark that one
`superseded`. `knowledge_not_retrieved` writes a `search` event with `miss=1` naming
the lesson. `method_unclear` lessons are inserted with `scope='global'` and are never
returned by `search` or `hints` (filter `diagnosis <> 'method_unclear'` in 12b's
queries); they are the review queue for `instructions.ts`. Any throw: `distill_state`
stays `pending` with attempts bumped, an `error` event with the sanitised message,
`failed` after the third.

`enqueue` appends to a chain; `idle()` resolves when the chain is empty; `close()`
aborts the in-flight controller and awaits `idle()` with a 5-second cap. `tab.ts`
calls `enqueue` with the ids `resolveBuild`/`resolveCheck` returned during the run,
from `onRunEnd`, after scoring. `LauncherTab.knowledge` gains `idle()` for tests.

## Step 3 — freshness, `knowledge/freshness.ts`

```ts
export function reviewFlags(knowledge: Knowledge, input: { instructionsHash: string; autoappVersion: string }): void;
```

Run once on launcher start after seeding: the three rules from the decisions table,
each an `UPDATE lessons SET review = ? WHERE …` that never touches `status`. The
version comparison is on `major.minor` of `autoapp_version` versus the running one.
Serving in 12b already labels a provisional lesson; extend the label to
"(needs review: <reason>)" when `review` is set.

## Step 4 — the review path

`main.ts`: `knowledge <list|show|confirm|retire|export> …` in `HELP` and the switch,
implemented in `knowledge/cli.ts` over `openKnowledge` on the same root `status` uses:

- `list [--provisional|--confirmed|--review|--method]`: one line per lesson —
  id, status, review flag, scope, `applies.stage`, servings closed as
  `resolved/recurred/blocked/unrelated`, summary cut at 80.
- `show <id>`: the full record: summary, detail, applies, provenance (episode id,
  request, both revisions, release ids, diagnosis and reasoning), every serving with
  its outcome and attempt, and `supersedes`/superseded-by.
- `confirm <id> [--by <name>]` and `retire <id>`: set `status`, `reviewed_by`
  (default `$USER`), `reviewed_at`; clear `review`; retire removes the FTS row; both
  write a `corpus_versions` row. Refuse (`exit 1`) when the launcher is serving, by
  reading `launcher.json` and checking the pid the way 08's finding describes, because
  the serving process holds the database and caches lessons in memory.
- `export [--json]`: every lesson with provenance, to stdout.

`engineer/tools.ts`: `knowledge.show` (`read`): input `{ lessonId }`, output the
`show` record minus reviewer names. It lets the engineer read the `detail` behind a
hint or a served summary.

## Step 5 — docs

- `docs/autoapp/learning.md`: the six diagnoses and what each does; why a lesson is
  provisional; the review commands; supersession and the three review flags; what the
  distiller is and is not shown.
- `docs/autoapp/security.md`: the distiller reads blobs only; its output passes the
  same sanitiser and guardrails; `method_unclear` lessons never enter a prompt.
- `docs/autoapp/backlog.md`: rows for a Lessons panel in the tab (precondition: a
  person using the CLI twice a week) and for automatic promotion (precondition: 12d's
  rule).

## Verification

```bash
bun run typecheck
bun test tests/ai-host.test.ts tests/autoapp-knowledge.test.ts
bun test tests
bun run check
```

New cases in `tests/autoapp-knowledge.test.ts`, distiller fed
`createFakeAdapter({ script: [{ kind: 'text', chunks: [json] }] })` through
`adapter.model(config, 'fake-1')`:

1. `knowledge_missing` with a lesson → one `provisional` row with `episode_id`,
   `version`, `instructions_hash`, `applies.signature` = the episode's; the FTS row
   exists; `episodes.diagnosis` and `distill_state='done'`; `adapter.calls[0]` contains
   the request blob text, the delivered instructions and the problem.
2. `insufficient_evidence` → no lesson, diagnosis stored, state `done`.
3. `method_unclear` → a lesson that `search` and `hints` never return.
4. `knowledge_not_retrieved` naming a seed → a `search` event with `miss=1`.
5. The same episode enqueued twice → one lesson; a lesson whose `summary` carries an
   absolute path is dropped and the diagnosis kept.
6. `sameCauseAs` → `supersedes` set, the old lesson `superseded` and absent from FTS.
7. A model that throws → `pending`, `distill_attempts=1`, an `error` event; three
   throws → `failed`.
8. `close()` during an in-flight call resolves within 5 s and leaves the episode
   `pending`.
9. Freshness: servings closed `recurred` three times → `needs_review:recurring`,
   status unchanged; a different `instructions_hash` and two recurrences →
   `needs_review:instructions_changed`; a bumped minor version → every distilled lesson
   flagged, curated ones not.
10. CLI, inside `describe.skipIf(!available)` with `Bun.spawn` of `LAUNCHER` from
    `tests/autoapp-launcher.ts` (`ensureLauncher` builds it once) and `BROAPP_DATA_DIR`
    at the test root, the way `scripts/autoapp-smoke.ts` drives commands: `list` shows
    the lesson; `confirm`
    sets `reviewed_at` and a `corpus_versions` row; `retire` removes the FTS row;
    `confirm` while `launcher.json` names a live pid exits 1.
11. `Ai.model()` in `tests/ai-host.test.ts`: returns the fake's instance; unconfigured
    → `unavailable`.

## Acceptance criteria

- A resolved case is diagnosed exactly once, with one of six causes, from the blobs
  and nothing else; a lesson results only for the two causes that warrant one.
- Every lesson carries provenance, applicability, the method version it was written
  against, and starts provisional.
- No status changes without a person; review flags say why a person should look.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12c-knowledge-distillation.md`. Include: the distiller's
prompts verbatim; one real distillation against a local model on a case from the 12b
rerun — the input size in characters, the answer, the time; whether the local model
returned a valid object first time; the `knowledge list` output afterwards.

## Commit

```
Distil a provisional lesson from a resolved case, and let a person review it

When a failure's repair lands, the engineer's own model is asked one
structured question about it, from the evidence as delivered at the time.
The diagnosis is always kept; a lesson results only when a fact was missing
or the method was unclear, and it stays provisional until a person confirms
it from the command line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
