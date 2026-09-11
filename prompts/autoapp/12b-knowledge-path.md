# 12b — The knowledge path: orientation, task evidence, hints, in-turn guidance

## Goal

Report 08c measured the engineer spending its first ten minutes on `apps.list`,
`spec.read`, `source.list` and twelve `source.read` calls before touching a file, and
then, after three correct edits, twenty minutes of planning with no `candidate.build`.
It starts every turn knowing nothing about the application in front of it and nothing
about where it left off.

After this prompt every turn opens with two documents the engineer did not have to ask
for: an **orientation** (which application, what state it is in, what is verified and
what is stale, what the next verification step is) and **task evidence** (the routes,
views, migrations, acceptance examples and source symbols that the request's words
point at, each with a `file:line` to read, and a plain `unknown` where the index cannot
say). A build failure comes back with **hints**: curated facts that match the problem.
Every edit result names the next step. Every serving is recorded with whether it
actually reached the model, and every build or check that follows is scored against it
stage by stage. Still no model calls beyond the engineer's own turn; lessons are 12c.

## Read first

- `prompts/autoapp/00-common-rules.md`, every report so far, `12a-knowledge-foundations.md`
  and its report with care.
- `packages/broapp-autoapp/src/knowledge/*` as 12a left them.
- `packages/broapp/src/ai/host/run.ts` (`assembleContext`, `SEARCH_LIMIT`,
  `fitToBudget`, `renderDocuments`, `neutraliseDocumentTags`), `tool.ts`
  (`ContextRef`, `ContextDocument`, `AiContextProviders`).
- `packages/broapp-autoapp/src/engineer/tools.ts`, `instructions.ts`, `state.ts`,
  `workspace.ts` (`readTree`, `readWorkspaceFile`, `within`, the `READABLE` regex).
- `packages/broapp-autoapp/src/spec/types.ts` (`AppSpec`, `ContractExport`,
  `AcceptanceExample`), `views/types.ts` (`ViewsSpec`, `Component`), `spec/store.ts`
  (`readCurrent`, `readRelease`).
- `packages/broapp-autoapp/src/launcher/apps.ts` (`listApps`), `tab.ts`, `app.ts`.
- `node_modules/bun-types/bun.d.ts` (`Glob`, `Glob.scan`) before using it.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Where knowledge enters the prompt | `createAi({ context })` on the launcher's tab, and nowhere else. Documents render under the existing Rules that say documents are data. `instructions.ts` changes by at most three sentences (below). |
| Documents | `digest:<appId>` (orientation, ≤ 2,000 chars) and `evidence:<appId>` (task evidence, ≤ 4,000 chars). In 12c, `lessons` joins them. The budget is `contextBudgetChars`, 40,000, already applied by the AI layer; these two together stay under 6,000 so a truncation is a bug, not a tuning question. |
| Which application | Named in the message (its id, or a token of its name of length ≥ 3), else `session.selectedAppId`, else the only application when exactly one exists, else none — the engineer still has `apps.list`. `selectedAppId` is set by every tool that takes an `appId` and by a new route `launcher.appSelect` (`write`, the tab's row click). It lives in `<root>/launcher/session.json`, written with `writeAtomic`. |
| Pointers, not claims | The task-evidence index reports what it matched and marks each entry `declared` (from the release spec: routes, effects, summaries, view component ids, migrations, acceptance examples) or `pattern` (from a regex over source). A route whose handler the regex does not find is listed with `handler: unknown — use source.search`. No relationship is stated that was not matched. |
| Direct fallback | New tool `source.search` (`read`): a regex or literal over the workspace's readable files, `Bun.Glob` + line scan, at most 50 hits as `path:line: text`, text cut at 200 characters, never a path outside the workspace. |
| Hints | Only from `lessons` with `status IN ('confirmed','provisional')` and `origin='curated'` in this prompt (12c adds distilled ones). Seeds are **facts**, never procedure; procedure that is already in `instructions.ts` is not repeated in a document. |
| Exposure | A serving row is written only after `onContext` shows the document that carries it was delivered (`included = 1`). A lesson that was resolved and then cut by the budget gets `included = 0` and never an outcome. |
| Scoring | Association, never proof. One outcome per serving per **eligible** attempt. A build attempt is eligible for a serving of stage `T` only if `T ∈ stagesRun`; a check attempt only for a serving with the same `for_example_hash`. Nothing here promotes or retires anything. |
| In-turn guidance | Advisory. Every `source.edit` / `source.change` result carries `verification`; after three unverified edits a `warning`. No timeout, no refusal; 12d measures whether it moves the stall before anything stronger is designed. |

## Step 0 — one carry-over from the 12a review

`sanitise()` in `log.ts` redacts any run of 32 or more hex characters, which is also
the length of a release id, so a message such as "built 9c1d…" loses the id while the
structured field keeps it. Raise that rule to 40 characters or more (a release id is
exactly 32; a SHA-256 is 64 and stays covered) and add the case to test 4. Do not widen
anything else.

## Step 1 — `knowledge/path.ts`

```ts
export interface Orientation { appId: string; text: string; hash: string }
export interface TaskEvidence { appId: string; text: string; entries: readonly EvidenceEntry[] }
export interface EvidenceEntry {
  kind: 'route' | 'view' | 'migration' | 'example' | 'symbol' | 'constraint';
  name: string; file?: string; line?: number; confidence: 'declared' | 'pattern' | 'unknown'; note?: string;
}
export function orientation(input: { layout: Layout; appId: string; states: CandidateStates; apps: ReturnType<typeof listApps> }): Orientation;
export function taskEvidence(input: { layout: Layout; appId: string; tokens: readonly string[]; index: SymbolIndex }): TaskEvidence;
export interface SymbolIndex { rev: string; symbols: readonly IndexedSymbol[] }
export interface IndexedSymbol { file: string; line: number; kind: 'export' | 'function' | 'operation' | 'component' | 'migration'; name: string }
export function indexWorkspace(sourceDir: string, rev: string): SymbolIndex;
```

Orientation text, in this order, one line each, nothing the state does not say:

```
## <name> (<appId>)
Current release <id8> · schema v<n> · serving: yes|no
Candidate: <id8> built <relative time> from <rev7> | none
Edits since build: <n> files (<paths, at most 5>) | none
Last build: ok | failed at <stage>: <first problem message, cut at 160>
Checks: <passed>/<total> verified for the running preview | passed n/m for an earlier preview — run again | none
Preview: running | stopped when the launcher restarted — launcher.previewStart | none
Next: candidate.build | candidate.preview | candidate.check | ask the person to look at the preview, then release.activate
```

`indexWorkspace` scans `src/**/*.ts` and `src/**/*.tsx` under the workspace with
`Bun.Glob`, line by line, with these patterns and no others: `^export (async )?function
(\w+)`, `^export const (\w+)`, `app\.operation\(['"]([\w.]+)['"]`, `id: ['"]([\w-]+)['"]`
inside `views.ts` only, and migration ids from `autoapp.json`. It is recomputed when
`rev` changes and cached in memory per app. It does not follow imports, aliases or
computed names; the file's header comment says so and says why (a TypeScript parser
is not a dependency this package has, and a wrong claim costs the engineer more than
a missing one).

Task evidence: for the request's `tokens`, match against route names (whole or
segment), route summaries, view component ids, migration ids, example ids and titles,
and indexed symbol names. Emit, grouped:

```
## Evidence for "<tokens joined>" in <appId>
Routes: notes.create (write) — Create a note · handler src/host/app.ts:41 [pattern] · shown by note-form [declared]
        notes.tag (write) — … · handler: unknown — use source.search
Views: notes-table (page main) src/shared/views.ts:18 [declared]
Migrations: 3, last 0003-add-tags; next id 0004-<slug>; append only [constraint]
Acceptance: list-notes (touches notes.list) [declared]
Symbols: openStore src/host/db.ts:12 [pattern] · addNote src/host/db.ts:44 [pattern]
Constraints: every route needs effect and summary · a component keeps its id · autoapp.json and src/ only
```

When no token matches anything, the document says so in one line and lists the six
`SOURCE` files with sizes, which is what `source.list` returns today, so the engineer
loses nothing by having it early.

## Step 2 — `knowledge/serve.ts` and `knowledge/scoring.ts`

```ts
export interface Serve extends AiContextProviders {
  /** Called from tab.ts's onContext: records included refs, writes servings, keeps the message. */
  delivered(runId: string, delivered: DeliveredContext): void;
  hints(appId: string, problems: readonly BuildProblem[], origin: FullOrigin): readonly Hint[];
}
export interface Hint { lessonId: number; status: 'confirmed' | 'provisional'; text: string }
export function createServe(input: { knowledge: Knowledge; log: EventLog; layout: Layout; states: CandidateStates; session: Session; instructions: string }): Serve;
export interface Session { get(): { selectedAppId: string | null }; select(appId: string): void }
export function openSession(dataDir: string): Session;
```

`search({ text, limit, runId })`: tokens; resolve the application by the rule in the
decisions table; return `[{ ref: 'digest:<id>', title }, { ref: 'evidence:<id>', title }]`
plus lesson refs `lesson:<id>` from `lessons_fts MATCH ftsQuery(text)` joined on
`lessons` with `status IN ('confirmed','provisional') AND (scope='global' OR scope=?)`,
ordered by `bm25(lessons_fts, 1.0, 2.0) * CASE status WHEN 'confirmed' THEN 1.0 ELSE 0.6 END`,
top 3. Record `requested` per run in memory. `resolve(refs)`: render the two documents
and one `lessons` document ("Lessons from earlier work", one bullet per lesson:
`summary` and, for provisional ones, "(provisional)"). Record `resolved`.
`delivered(runId, …)`: update the run's `contexts` row (`requested`, `resolved`,
`included`), write one `servings` row per lesson whose `lessons` document was included
(`included = 1`) or resolved and not included (`included = 0`), write a `search` event
with `tokens, hits, requested, resolved, included`. The AI layer calls `search` and
`resolve` before `onContext`, so `createServe` keeps a per-run scratch map and clears
it in `delivered`.

`hints(appId, problems, origin)`: for each problem, `ftsQuery(problem.message)` over
the same lesson filter, top 2, deduped, at most 3; write a `servings` row per hint
with `how='hint'`, `for_signature = signature(stage, message)`, `for_stage`,
`included = 1` (a tool result is delivered by construction).

`scoring.ts`:

```ts
export type Outcome = 'resolved' | 'recurred' | 'blocked' | 'inconclusive' | 'unrelated' | 'none';
export function scoreBuild(knowledge: Knowledge, appId: string, result: BuildCandidateResult, origin: FullOrigin): void;
export function scoreCheck(knowledge: Knowledge, appId: string, results: readonly CheckResult[], examples: readonly { id: string; hash: string }[], releaseId: string, origin: FullOrigin): void;
export function scoreRunEnd(knowledge: Knowledge, runId: string): void;   // open servings of the run → 'none'
```

`scoreBuild`, for every open serving of the app (`outcome IS NULL`):

- `for_stage` set and `for_stage ∉ result.stagesRun` → `blocked`, **stays open**
  (write nothing but an event).
- `for_stage ∈ stagesRun`: no problem in `result` with `signature === for_signature`
  → `resolved`; one present → `recurred`.
- `for_example_hash` set → untouched; builds never close check servings.
- `for_signature` empty (a turn serving of a lesson with only `applies.files/routes`):
  `resolved` when the build passed and the run's `edit` events touched a file matching
  `applies.files`, else `unrelated`.

`scoreCheck`: for servings with `for_example_hash` among the examples run: the example
passed → `resolved`; failed with the same signature → `recurred`; the child died or
timed out → `inconclusive`. A closed serving records `attempt_call_id`,
`attempt_kind`, `attempt_release`, `attempt_at`. A serving is closed at most once; the
`UPDATE … WHERE outcome IS NULL` guarantees it.

## Step 3 — `knowledge/seed.ts`

`SEED_LESSONS`: six to eight rows, `origin='curated'`, `status='confirmed'`,
`scope='global'`, `applies` with a `stage` where one fits, `trigger` keywords, each a
fact the engineer cannot read off the workspace:

- the renderer has no navigation action; a button that only moves the person calls a
  read operation (`applies.stage='views'`);
- every route in `contract.ts` needs `effect` and `summary`, and the build refuses one
  without (`applies.stage='contract'`);
- a release inlines everything except `bun:sqlite` and Node builtins; a new dependency
  cannot be added by editing `package.json` alone (`applies.stage='host'`);
- `MigrationSpec.checksum` is validated for shape and not verified; migrations append
  and never change (`applies.stage='spec'`);
- a `source.edit` hunk over 2 KB was measured not to land; three to eight lines do;
- a component id in `views.ts` is what a person's customisations key on;
- `notes.backup`-style operations that write a file are `write`, not `external`, and
  are therefore offered over MCP.

Inserted on first open when `lessons` is empty, with one `corpus_versions` row per
insert. Wording under 300 characters each; a test asserts none of them repeats a
sentence from `ENGINEER_INSTRUCTIONS` (compare normalised sentences).

## Step 4 — the tools

`engineer/tools.ts`:

- `source.search` (`read`): input `{ appId, pattern: string (1–200), literal?: boolean,
  files?: string (glob, default 'src/**') }`, output `{ hits: [{ path, line, text }],
  truncated: boolean }`. A pattern that does not compile is `invalid_input`. Uses
  `within` and `READABLE` from `workspace.ts` so nothing outside the workspace is read.
- `source.edit` / `source.change` results gain
  `verification: { editsSinceBuild: number; lastBuild: 'ok' | 'failed' | 'none'; next: 'candidate.build' }`
  and, from the third unverified edit, `warning: 'three edits are unverified; build
  before editing more'` (the number is the count). `editsSinceBuild` here is the count
  of edit calls since the last build in this launcher process, kept on
  `CandidateStates`, reset by `candidate.build`; it is not the git comparison, which
  answers a different question.
- `candidate.build` failure output gains `hints`; success and failure both call
  `scoreBuild`. `candidate.check` calls `scoreCheck`.
- Every tool that takes `appId` calls `session.select(appId)` after validating it.

`instructions.ts`, "How to work", three sentences and nothing else: before step 1,
*"Each message comes with an orientation for the application and evidence for the
request: read them before calling any tool. They say what is built, what is verified
and what to do next."* In step 3: *"When a build fails, its `hints` are facts from
earlier work; a hint marked provisional has not been confirmed."* `INSTRUCTION_SECTIONS`
does not change; the line-limit test from 08c must still pass — trim elsewhere if it
does not.

`tab.ts`: build `createServe(...)`, pass it as `context`, call `serve.delivered` from
`onContext` (before the 12a recording so the servings see the same `included`), call
`scoreRunEnd` from `onRunEnd`. `launcher/app.ts` + `contract.ts`: `launcher.appSelect`
(`write`, `appIdInput`, `{ ok }`); `App.tsx` calls it when a row is selected.

## Step 5 — docs

- `docs/autoapp/learning.md`: the three levels (orientation, task evidence, supporting
  evidence), how an application is chosen for a turn, what `declared`/`pattern`/
  `unknown` mean, what a serving is, what the six outcomes mean and that none of them
  promotes anything.
- `docs/autoapp/security.md`: `source.search` is bounded to the workspace and returns
  no path outside it; documents are data by the existing rule; hints are facts, and
  the trusted method stays in `instructions.ts`.
- `docs/autoapp/backlog.md`: "The engineer reaches edits and stops before a build" gains
  "in-turn guidance landed in 12b; measured in 12d".

## Verification

```bash
bun run typecheck
bun test tests/autoapp-knowledge.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts tests/ai-chat.test.ts
bun test tests
bun run check
```

New cases in `tests/autoapp-knowledge.test.ts`:

1. Orientation text for a world with a built candidate, a stale check and a lost
   preview contains each of the eight lines with the expected values; the `Next:` line
   says `launcher.previewStart`.
2. `indexWorkspace` on the starter finds `start`, `migrate`, every `items.*` operation
   literal with the right line, and every component id; a handler declared through an
   alias is reported `unknown`.
3. `taskEvidence` for tokens `['items','add']` lists `items.add` with its handler line
   and the matching example; for `['zebra']` it says nothing matched and lists the
   `SOURCE` files.
4. Application choice: a message naming another app's id gets that app's documents; a
   message naming nothing after `session.select('items')` gets `items`; with two apps
   and no selection, no documents and a `search` event with `hits=0`.
5. Delivered: over the harness with the fake adapter, `adapter.calls[0]`'s system prompt
   contains the digest and evidence documents; `contexts.included` names both refs; a
   seeded lesson matched by the message has a `servings` row with `included=1`; with
   `contextBudgetChars` set to 1,000 in the test's `createLauncherTab`, the `lessons`
   document is cut and its serving has `included=0`.
6. Hints: a `contract` failure returns the `effect` seed as a hint with `for_stage=
   'contract'`; an unrelated `host` problem returns `hints: []`.
7. Scoring: after that hint, a build that stops at `spec` marks nothing (`blocked` event,
   serving open); a build with `contract ∈ stagesRun` and no such problem → `resolved`;
   repeating the failure → `recurred`; a check-example serving is untouched by any build
   and `resolved` only by a check on its hash; a run ending with an open serving → `none`.
8. Guidance: the third `source.edit` without a build returns `verification.warning`;
   `candidate.build` resets it.
9. `source.search` finds a literal and a regex, caps at 50 with `truncated=true`, refuses
   a bad regex with `invalid_input`, and never returns a path with `..` or outside `src/`.
10. Seeds: inserted once, `corpus_versions` has one row per seed, no seed sentence
    appears in `ENGINEER_INSTRUCTIONS`.
11. `INSTRUCTION_SECTIONS` unchanged; the 08c line limit holds.

## Acceptance criteria

- A turn's system prompt carries the orientation and the task evidence for the
  application the message is about, and the engineer is told to read them first.
- Every entry in the evidence is a `file:line` marked `declared` or `pattern`, or an
  honest `unknown` with `source.search` as the way forward.
- A build failure returns matching curated facts as hints, each recorded as a serving.
- Every serving records whether it reached the model; every later build or check
  closes it with one of six outcomes by the stage-aware rules; nothing promotes.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12b-knowledge-path.md`. Include: the size in characters of
the orientation and evidence documents for the starter and for Notes; which symbols
the regex index missed in Notes and why; a rerun of the 08c request against a local
model with the tool-call sequence before the first `source.edit` (08c: 15) and whether
`candidate.build` was reached — one row per step, as 08c's report. This is the baseline
12d compares against.

## Commit

```
Give the engineer its bearings before it asks

Every turn opens with an orientation for the application and evidence for
the request, each entry a file and line or an honest unknown. Build failures
return matching facts as hints. Every serving records whether it reached the
model and is scored stage by stage against the build or check that follows.
Nothing is promoted; nothing is distilled yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
