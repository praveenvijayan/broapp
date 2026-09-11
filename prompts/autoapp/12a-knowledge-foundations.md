# 12a — Knowledge foundations: identity at capture, immutable evidence, a log, resume

## Goal

The engineer forgets everything. A build failure, the edits that repaired it, the
check that then passed, the child's stderr while it ran, the candidate a person was
looking at — all of it lives in `CandidateStates` in memory and in the terminal's
scrollback, and a restart loses both. Nothing can learn from what is not written down,
and a person who closes the launcher comes back to an empty candidate panel and a
preview that says nothing is running.

After this prompt the launcher writes down, at the moment it happens and with the
identity it had then: every tool call's run and call id and source revision; every
build, check, edit and activation as a structured event; every failure and its repair
as an immutable case that a later prompt can replay; the exact instructions and
documents a run was given; and the candidate state, durably, so a restart resumes
where the person left off. Nothing here calls a model. Nothing here changes what the
engineer is told. Prompt 12b serves knowledge from it; 12c distils lessons; 12d
replays cases.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far; `08c-usability.md`
  for the measured stall, `11-new-application.md` for how a route, a tool and a
  command share one implementation.
- `docs/autoapp/backlog.md` — "Blocking the loop" and "What was measured".
- `packages/broapp/src/ai/host/tool.ts` (`GuardedToolDefinition`, `guardedTool`,
  `AiContextProviders`), `run.ts` (`assembleContext`, `fitToBudget`,
  `buildSystemPrompt`, `runChat`, `runTurn`), `create-ai.ts` (`CreateAiOptions`,
  `RunDeps` assembly), `adapter.ts:49-66`.
- `packages/broapp/src/host/gate.ts` (`Envelope`, `ExecutionRecord`, `Recorder`),
  `app.ts:93` (`HostLogger`).
- `packages/broapp-autoapp/src/engineer/state.ts`, `tools.ts` (every `states.update`
  site), `workspace.ts` (`applyEdits`, `finish`, `diffSummary`).
- `packages/broapp-autoapp/src/launcher/candidate.ts` (`buildCandidate`,
  `BuildCandidateResult`, where it returns early), `app.ts` (`launcher.previewOpen`,
  `launcher.candidateStatus`, `launcher.activate`), `contract.ts`, `tab.ts`,
  `main.ts` (`openLauncher`, where the run store is opened and closed, `HELP`),
  `supervisor.ts:280-300` (the stderr drain).
- `packages/broapp-autoapp/src/host/run-store.ts` — the store pattern to copy:
  `MIGRATIONS`, `PRAGMA user_version`, prepared statements, `redact`, `close`.
- `packages/broapp/src/ai/host/threads.ts` — the same pattern in core.
- `packages/broapp-autoapp/src/spec/store.ts` (`writeAtomic`), `layout.ts`.
- `packages/broapp-autoapp/src/launcher/ui/CandidatePanel.tsx`.
- `tests/autoapp-engineer.test.ts` (`makeWorld`, `callTool`, `asEngineer`, the
  launcher-tab `start` helper), `tests/harness.ts`.
- `node_modules/bun-types/sqlite.d.ts` and `bun.d.ts` (`CryptoHasher`, `Glob`) before
  writing any call from memory.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| New module | `packages/broapp-autoapp/src/knowledge/`, exported as `broapp-autoapp/knowledge` (add to `package.json` `exports`). Host code only. |
| Database | `<root>/launcher/knowledge.sqlite`, opened by `openKnowledge(dataDir)` beside `createRunStore(dataDir)` in `main.ts`, same `PRAGMA`s, numbered `MIGRATIONS`, `PRAGMA user_version`, `close()` checkpoints. One database for events, blobs, contexts, episodes, servings and (later) lessons. |
| Identity | Written at the moment of observation from the envelope the tool received. Never inferred later, never "claimed" by whichever run ends next. A row with no origin stays `run_id NULL` for ever. |
| Core changes, all optional in type | **A** `GuardedToolDefinition.run(input, signal, envelope?)`. **B** `AiContextProviders.search` query gains `runId`. **C** `onRunEnd(runId, status, summary, detail?)` with `detail: { usage?: { inputTokens, outputTokens }, steps, ms }`. **E** `CreateAiOptions.onContext?(runId, { system, documents })` called once per turn after `fitToBudget`, with the documents exactly as delivered. **F** `BuildCandidateResult` gains `stagesRun`. Nothing in `packages/broapp` outside `src/ai/host/{tool,run,create-ai,adapter}.ts` changes. `tests/ai-chat.test.ts` stays untouched and green. |
| Redaction | The existing `redact()` handles object keys only. Free text goes through a new `sanitise()` first. Structured event data is built from an allow-list per kind; a field not on the list is dropped, not stored. |
| Evidence is immutable | An episode's opening columns are written once. Edits append while it is open. Resolve fills the `resolved_*` columns once. Any other update to a resolved row throws inside the store; callers catch and log. |
| Blobs | Content-addressed text (`sha256` hex of the UTF-8 bytes). A blob is written with `INSERT OR IGNORE`. Blobs referenced by an episode live as long as the episode; others follow event retention. |
| Resume | `CandidateState` minus the preview handle is durable in `<root>/apps/<appId>/candidate.json`, written with `writeAtomic` on every update. A stalled condition is derived on demand (`git HEAD ≠ builtFromRev`), never stored as a fact. |
| Preview after restart | A new route `launcher.previewStart` with `effect: 'write'` starts a preview for the known candidate. It snapshots data and starts application code; it is not a read. `launcher.previewOpen` stays a read that opens a running preview and refuses otherwise, as today. |
| What is not here | No context providers on the launcher's `createAi` yet, no hints, no lessons, no CLI, no model calls. Those are 12b and later. The `lessons`, `lessons_fts`, `corpus_versions` tables are created in this prompt's schema so 12b does not need a migration for them, but nothing writes them. |
| Retention | On open: `events` older than 30 days deleted, then the oldest beyond 50,000 rows; blobs not referenced by any episode or context and older than 30 days deleted. Episodes are never deleted here. |

## Step 1 — the core changes

`packages/broapp/src/ai/host/tool.ts`:

```ts
export interface GuardedToolDefinition {
  …
  /** The envelope is the run loop's, never the model's; a tool may record it and must not act on its channel. */
  run(input: unknown, signal: AbortSignal, envelope?: Envelope): Promise<unknown>;
}
// guardedTool: (signal) => tool.run(input, signal, envelope)

export interface AiContextProviders {
  search?(query: { text: string; limit: number; runId?: string }, signal: AbortSignal): Promise<ContextRef[]>;
  …
}
```

`packages/broapp/src/ai/host/create-ai.ts`:

```ts
export interface RunEndDetail {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Tool round trips the turn made. */
  readonly steps: number;
  readonly ms: number;
}
/** What one turn was given, after the budget. Documents are exactly what the model saw. */
export interface DeliveredContext {
  readonly system: string;
  readonly documents: readonly ContextDocument[];
}
onRunEnd?: (runId: string, status: 'succeeded' | 'failed' | 'cancelled', summary: string, detail?: RunEndDetail) => void;
onContext?: (runId: string, delivered: DeliveredContext) => void;
```

`run.ts`: `assembleContext` passes `params.runId` to `search`; `runTurn` calls
`deps.onContext?.(params.runId, { system, documents })` with the string it hands to
`streamText` and the post-budget documents, before the call; `runChat` counts steps
(one per `tool-call` part) and measures wall time from its start, and passes `detail`
to `end`. The `finish` part's `totalUsage` is where the numbers already are; keep the
`usage` event as it is. Export `RunEndDetail` and `DeliveredContext` from
`ai/host/index.ts`. Hook failures are caught and logged; a hook can never fail a turn.

`packages/broapp-autoapp/src/launcher/candidate.ts`:

```ts
export const BUILD_STAGES = ['spec', 'contract', 'views', 'page', 'host'] as const;
export type BuildCandidateResult =
  | { ok: true; releaseId: string; spec: AppSpec; rebuilt: boolean; stagesRun: readonly BuildProblem['stage'][] }
  | { ok: false; problems: readonly BuildProblem[]; stagesRun: readonly BuildProblem['stage'][] };
```

`stagesRun` lists the stages that actually executed to completion or to a problem of
their own. A build that returns early after `spec` reports `['spec']`; one whose shared
layer would not bundle reports `['spec', 'contract']`. Read `buildCandidate` from top
to bottom and record the stage at each `return` and each `problems.push`; a comment
at `BUILD_STAGES` says why the list exists — "the error is gone" must be
distinguishable from "the stage never ran". Every caller that spreads the result
(`tools.ts`, `workspace.ts`, `main.ts`) still typechecks because the field is added,
not renamed; `launcher/contract.ts`'s `candidateStatus` output gains
`stagesRun: s.array(s.enum([...BUILD_STAGES]), { max: 5 })`.

## Step 2 — `knowledge/store.ts`

```ts
export interface Knowledge {
  readonly db: Database;                 // for the sibling modules in this directory only
  putBlob(content: string): string;      // returns the hash; INSERT OR IGNORE
  getBlob(hash: string): string | null;
  close(): void;
}
export function openKnowledge(dataDir: string): Knowledge;
export function signature(stage: string, message: string): string;
export function tokens(text: string): readonly string[];
export function ftsQuery(text: string): string | null;
export const KNOWLEDGE_FILE = 'knowledge.sqlite';
```

Schema, one migration:

```sql
CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  level TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
  app_id TEXT, run_id TEXT, call_id TEXT, release_id TEXT, source_rev TEXT,
  message TEXT NOT NULL, data TEXT);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_run ON events(run_id, at);
CREATE INDEX events_app ON events(app_id, at);
CREATE TABLE contexts (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, app_id TEXT,
  corpus_version INTEGER NOT NULL,
  instructions_blob TEXT NOT NULL, system_blob TEXT NOT NULL,
  requested TEXT NOT NULL, resolved TEXT NOT NULL, included TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE TABLE corpus_versions (version INTEGER PRIMARY KEY, lesson_id INTEGER, change TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, stage TEXT NOT NULL,
  signature TEXT NOT NULL, problem TEXT NOT NULL,
  example_id TEXT NOT NULL DEFAULT '', example_hash TEXT NOT NULL DEFAULT '', example_blob TEXT,
  request_blob TEXT NOT NULL, context_id INTEGER,
  run_id TEXT NOT NULL, call_id TEXT NOT NULL,
  source_rev_before TEXT NOT NULL, release_before TEXT, data_snapshot TEXT,
  model_provider TEXT, model_id TEXT, autoapp_version TEXT NOT NULL,
  edits TEXT NOT NULL DEFAULT '', opened_at INTEGER NOT NULL,
  resolved_at INTEGER, resolved_run_id TEXT, source_rev_after TEXT, release_after TEXT,
  diagnosis TEXT,
  distill_state TEXT NOT NULL DEFAULT 'pending', distill_attempts INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX episodes_open ON episodes(app_id, stage, signature, example_id, example_hash) WHERE resolved_at IS NULL;
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, review TEXT,
  origin TEXT NOT NULL, episode_id INTEGER, supersedes INTEGER, diagnosis TEXT,
  scope TEXT NOT NULL, applies TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, trigger TEXT NOT NULL,
  instructions_hash TEXT NOT NULL, autoapp_version TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reviewed_by TEXT, reviewed_at INTEGER);
CREATE UNIQUE INDEX lessons_episode ON lessons(episode_id) WHERE episode_id IS NOT NULL;
CREATE VIRTUAL TABLE lessons_fts USING fts5(summary, trigger, tokenize='unicode61');
CREATE TABLE servings (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL, run_id TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT '', how TEXT NOT NULL,
  for_signature TEXT NOT NULL DEFAULT '', for_stage TEXT NOT NULL DEFAULT '', for_example_hash TEXT NOT NULL DEFAULT '',
  included INTEGER NOT NULL, served_at INTEGER NOT NULL,
  attempt_call_id TEXT, attempt_kind TEXT, attempt_release TEXT, attempt_at INTEGER, outcome TEXT);
CREATE UNIQUE INDEX servings_once ON servings(lesson_id, run_id, app_id, how, for_signature, for_example_hash);
```

No nullable column takes part in a unique index; the `DEFAULT ''` columns are why. A
test asserts FTS5 is available by creating the table on an in-memory database.

`signature(stage, message)`: lower-case; cut any absolute path at `/source/` and keep
the remainder; remove `:<digits>:<digits>` and `:<digits>`; replace anything in single
or double quotes or backticks with `'?'`; replace hex runs of 8 or more with `#`;
replace remaining digits with `0`; collapse whitespace; take the first 200 characters;
hash `stage + '\n' + normalised` with `Bun.CryptoHasher('sha256')`, hex, first 32.

`tokens(text)`: lower-case; split on `/[^\p{L}\p{N}]+/u`; keep tokens of length ≥ 3
that are not all digits and not hex of length ≥ 8; drop a stopword list of English
function words plus `src host shared app apps ts tsx json error file line the this
that with from into`; dedupe; first 16. `ftsQuery(text)`: each token double-quoted
with inner quotes doubled, joined with ` OR `; `null` when no tokens. FTS5's implicit
operator is AND, and a whole request AND-ed would match nothing — say so in a comment.

## Step 3 — `knowledge/log.ts`

```ts
export type EventKind = 'log' | 'build' | 'check' | 'edit' | 'run' | 'usage' | 'activate' | 'stderr' | 'search' | 'dropped';
export interface Origin { runId?: string; callId?: string; appId?: string; releaseId?: string; sourceRev?: string }
export interface EventLog extends HostLogger {
  event(kind: EventKind, message: string, data?: Record<string, unknown>, origin?: Origin, source?: string): void;
  child(appId: string): HostLogger;          // source `child:<appId>`, kind `stderr`
  stats(): { written: number; dropped: number };
}
export function createEventLog(knowledge: Knowledge, options: { source: string; tee?: HostLogger }): EventLog;
export function sanitise(text: string): string;
```

`sanitise()` in order: `(?i)(api[_-]?key|secret|token|password|authorization)\s*[=:]\s*\S+`
→ `$1=<redacted>`; `Bearer\s+\S+` → `Bearer <redacted>`; `sk-[A-Za-z0-9_-]{8,}` →
`<redacted>`; runs of `[A-Fa-f0-9]{32,}` and `[A-Za-z0-9+/=]{40,}` → `<redacted>`; a URL's
`?query` and `user:pass@` parts removed; `os.homedir()` → `~`; then `redact()` for
anything that is an object. Cap `message` at 2,000 characters and `data` at 4,000
(canonical JSON) after sanitising.

Allow-lists, one per kind, applied to `data` before it is stored; anything else is
dropped silently:

| kind | fields |
|---|---|
| `build` | `ok, releaseId, stagesRun, problems[].stage, problems[].message, ms` |
| `check` | `releaseId, previewId, results[].id, results[].passed, results[].detail` |
| `edit` | `paths, hunks, matchedBy, bytes` |
| `run` | `status, steps, ms` |
| `usage` | `inputTokens, outputTokens` |
| `activate` | `ok, phase, reason, recovered, releaseId` |
| `search` | `tokens, hits, requested, resolved, included` |
| `stderr` | `pid` |
| `log`, `dropped` | none |

Writes are wrapped: a failed insert increments `dropped`, is reported once to the tee
with the cause, and never writes anything to the knowledge database in the failing
path. When a later write succeeds and `dropped > 0` since the last report, one
`dropped` event carrying the count is written and the counter resets. `warn`/`error`
write `kind='log'` with `level` accordingly and tee to `options.tee` (console in
`main.ts`, `quiet` in tests). `child(appId)` returns a logger whose `warn` writes
`kind='stderr'`, `source='child:<appId>'`, `data={pid}` when the supervisor passes one.

`main.ts`: open knowledge before the run store, create the log with `tee: console`,
and pass it as `logger` to `createLauncherTab`, `createSupervisor`, `activate`,
`recover`, `keepServing` and `startControl`. `supervisor.ts`: the stderr drain calls
`logger.child?.(appId).warn(line)` when the logger has `child`, else what it does today
(a shape check, not `instanceof`). Close order in `onShutdown`: run store, then
knowledge.

## Step 4 — `knowledge/ids.ts` and `knowledge/evidence.ts`

```ts
export interface FullOrigin extends Origin { runId: string; callId: string; appId: string; sourceRev: string }
/** From the envelope a tool received. `requestId` is `<runId>:<callId>`; anything else is a single-step run. */
export function origin(envelope: Envelope | undefined, appId: string, layout: Layout, releaseId: string | null): FullOrigin;
export function sourceRevision(sourceDir: string): string;   // `git rev-parse HEAD`, or 'no-git' when the workspace has none
```

`evidence.ts`:

```ts
export interface OpenEpisode {
  appId: string; stage: BuildProblem['stage'] | 'check'; problem: string;
  example?: { id: string; content: unknown };      // check cases only
  request: string; contextId: number | null;
  origin: FullOrigin; releaseBefore: string | null; dataSnapshot: string | null;
  model: { provider: string; id: string } | null; autoappVersion: string;
}
export interface Evidence {
  open(input: OpenEpisode): number | null;         // null when the same case is already open
  appendEdit(appId: string, summary: string): void; // to every open case of the app, capped at 8,000 chars
  resolveBuild(appId: string, stagesRun: readonly string[], origin: FullOrigin, releaseAfter: string | null): number[];
  resolveCheck(appId: string, exampleHash: string, origin: FullOrigin, releaseAfter: string): number[];
  openCases(appId: string): readonly EpisodeRow[];
  get(id: number): EpisodeRow | null;
}
export function createEvidence(knowledge: Knowledge, log: EventLog): Evidence;
export function exampleHash(example: AcceptanceExample): string;   // sha256 of canonical JSON, first 32
```

`open` writes `request_blob` and `example_blob` through `putBlob`, computes
`signature(stage, problem)` and `example_hash`, and inserts inside one transaction;
the partial unique index turns a duplicate open case into a no-op (`INSERT OR IGNORE`,
check `changes`). `resolveBuild` resolves every open build-stage case of the app whose
`stage ∈ stagesRun`; a case whose stage did not run stays open. `resolveCheck`
resolves the open check case with that exact `example_hash` only. Resolve is
`UPDATE … WHERE id = ? AND resolved_at IS NULL`; the store's one other update path,
`distill_state`, is added in 12c. Any attempt to update another column of a resolved
row is a thrown `Error` from the store; a test proves it.

The `contexts` writer lives here too:

```ts
export function recordContext(knowledge: Knowledge, input: {
  runId: string; appId: string | null; instructions: string; delivered: DeliveredContext;
  requested: readonly string[]; resolved: readonly string[];
}): number;
```

It puts the instructions and the system prompt as blobs, one blob per delivered
document, and stores `included` as `[{ ref, blob, truncated }]` where `truncated` is
whether the delivered content ends in `\n[truncated]`. `corpus_version` is
`MAX(version)` of `corpus_versions`, or 0. In this prompt `requested` and `resolved`
are `[]` because nothing serves yet; 12b fills them.

## Step 5 — resume

`engineer/state.ts`:

```ts
export interface StoredCandidate {
  readonly releaseId: string | null;
  readonly builtFromRev: string | null;
  readonly builtAt: number | null;
  readonly problems: readonly BuildProblem[];
  readonly stagesRun: readonly BuildProblem['stage'][];
  readonly checks: { releaseId: string; previewId: string; examples: readonly { id: string; hash: string }[]; results: readonly CheckResult[]; at: number } | null;
  readonly previewWasRunning: boolean;
}
export interface CandidateState extends StoredCandidate {
  readonly appId: string; readonly preview: ChildHandle | null; readonly capabilityDiff: CapabilityDiff | null;
  /** Derived at read time: `git HEAD` of the source workspace differs from `builtFromRev`. */
  readonly editsSinceBuild: boolean;
  readonly previewLost: boolean;
}
export interface CandidateStatus { …existing…; editsSinceBuild: boolean; previewLost: boolean; checksVerified: boolean; stagesRun: … }
export function createCandidateStates(layout: Layout): CandidateStates;
```

`createCandidateStates(layout)` reads `<root>/apps/<appId>/candidate.json` lazily on
first `get` (a missing or unreadable file is the empty state, logged, never deleted),
writes it with `writeAtomic` on every `update`, and never stores the preview handle.
`previewId` is the preview child's `releaseId` plus its spawn time, whatever the
supervisor already exposes that distinguishes one spawn from another; if nothing does,
add a `spawnedAt` to `ChildHandle`. `checksVerified` is `checks !== null &&
checks.releaseId === releaseId && preview !== null && preview id === checks.previewId`.
`editsSinceBuild` calls `sourceRevision` at most once per second per app (cache with a
timestamp; `git rev-parse` is cheap but not free on every poll).

`tools.ts`: `candidate.build` stores `builtFromRev` (from the origin) and `stagesRun`;
`candidate.preview` sets `previewWasRunning: true`; `candidate.check` stores the
`checks` object with example ids and hashes; `preview.stop` and the activate path set
`previewWasRunning: false`.

`launcher/app.ts` and `contract.ts`: `launcher.previewStart` (`effect: 'write'`, input
`appIdInput`, output `{ previewRunning: boolean }`), which refuses (`unavailable`) when
`releaseId` is null and otherwise runs exactly what `candidate.preview` runs — factor
that into a function both call, do not copy it. `launcher.candidateStatus` output
gains `editsSinceBuild`, `previewLost`, `checksVerified`, `stagesRun`.

`CandidatePanel.tsx`: when `previewLost`, a sentence under the Built line — "The
preview stopped when the launcher restarted." — and the Open preview button becomes
**Start preview** calling `launcher.previewStart`, then `previewOpen`. When
`checksVerified` is false and `checks` exist: "passed n of m for an earlier preview;
run the checks again". When `editsSinceBuild`: "edited since this build".

## Step 6 — wiring the tools and the tab

`EngineerToolsOptions` gains `knowledge?: { log: EventLog; evidence: Evidence; autoappVersion: string }`;
every existing test that builds tools without it still passes. At each site:

| Tool | Event | Evidence |
|---|---|---|
| `source.edit`, `source.change` | `edit` with paths, hunks, `matchedBy`, bytes | `appendEdit(appId, diffSummary)` |
| `candidate.build` | `build` with `ok`, `releaseId`, `stagesRun`, problems, `ms` | on failure `open` one case per distinct signature; on success `resolveBuild` |
| `candidate.check` | `check` | failed results `open` a check case with the example content; passed results `resolveCheck` |
| `release.activate` | `activate` | — |
| `candidate.preview` | `log` info when the child starts, `stderr` through `log.child` | — |

The request text for `open` is the person's message for the run: `createLauncherTab`
keeps the last `summary` per run from `onRunEnd`… which arrives too late. Instead
record it from `onContext`: the system prompt does not carry the message, so add the
last user message to `DeliveredContext` as `message: string` (core change E, one more
field). `tab.ts` keeps `Map<runId, { message, contextId }>` for live runs and clears
entries in `onRunEnd`.

`tab.ts`: open nothing itself; it receives `knowledge`, `log` and `evidence` from
`main.ts` (tests build them over a temp dir). It passes `onContext` (records the
context, keeps the message) and wraps `onRunEnd` to write the `run` and `usage` events
and `store.finishRun` as before. `LauncherTab` gains `knowledge: Knowledge` so a test
can read it.

`package.json`: `"./knowledge": "./src/knowledge/index.ts"`.

## Step 7 — docs

- `docs/autoapp/learning.md`, new: what is recorded, where, with what identity; what
  is immutable; what a restart restores; retention; what is **not** yet done (serving,
  lessons, replay) with a pointer to the later prompts.
- `docs/autoapp/design.md`: one paragraph after "The candidate-and-activation loop" —
  the launcher writes down every build, check and edit with the run that made it, and
  the candidate survives a restart.
- `docs/autoapp/security.md`: `previewStart` is a write; the knowledge database holds
  sanitised text and allow-listed fields, never a launch URL, never a secret; what
  `sanitise` catches and what it cannot.
- `docs/autoapp/backlog.md`: the "restarted child unreachable" row gains a note that
  `previewStart` covers the preview half; add a row "run timeout / no-progress limit"
  with the precondition "12d's measurement shows the stall persists with guidance".

## Verification

```bash
bun run typecheck
bun test tests/autoapp-knowledge.test.ts
bun test tests/autoapp-engineer.test.ts tests/autoapp-gate.test.ts tests/ai-chat.test.ts
bun test tests
bun run check
```

`tests/autoapp-knowledge.test.ts`, with store-only cases in
`mkdtempSync(join(tmpdir(), 'autoapp-'))` and workspace cases under
`tests/.autoapp-run/knowledge-*` (say why in the header, as `autoapp-engineer.test.ts`
does), tools built through `engineerTools` with `knowledge` and called with a
hand-built envelope, every child stopped and every root removed in `afterEach`:

1. FTS5 exists; `openKnowledge` creates every table; reopening is a no-op; `close()`
   leaves no `-wal` file.
2. `signature` maps two messages differing only in path, line number, quoted
   identifier and a hex id to the same hash, and a different stage to a different one.
3. `tokens`/`ftsQuery`: a compiler message with a path and a line number yields an
   `OR`-joined quoted query with no `src`, `ts` or number tokens; an empty request → `null`.
4. Sanitiser: `apiKey=abc…`, `Bearer …`, a 40-character hex token and the home
   directory are gone from an event message; a `build` event with an extra field
   stores only the allow-listed ones; a write after `close()` increments
   `stats().dropped`, throws nothing, and writes nothing.
5. Origin: `source.edit` with envelope `requestId 'r1:c1'` → an `edit` event with
   `run_id='r1'`, `call_id='c1'`, `source_rev` equal to `git rev-parse HEAD`.
6. Episode: a workspace whose contract drops an `effect`; `candidate.build` opens a
   case with `stage`, `request_blob`, `source_rev_before`, `stagesRun`; two edits
   append to `edits`; a passing build resolves it with `source_rev_after ≠ before` and
   `release_after`; a second open for the same signature while open is a no-op; an
   `UPDATE problem` on the resolved row through the store throws.
7. Stages: a failing `spec` build reports `stagesRun=['spec']`; a case with
   `stage='views'` is not resolved by a build that stopped at `contract`, and is
   resolved by the next build that ran `views`.
8. Check case identity: the same failing `detail` with an edited `expect` opens a
   second case; a passing build resolves neither; a passing check on the new hash
   resolves only the new one, and `example_blob` holds the example's JSON.
9. Delivered context (launcher tab over the harness with the fake adapter, scripted
   one edit): a `contexts` row exists for the run; its `system_blob` equals the system
   prompt in `adapter.calls[0]` byte for byte; `included` is `[]` (nothing serves yet);
   the `run` event has `steps=1` and the `usage` event the fake's constant numbers.
10. Resume: build and check through the tools, drop the `CandidateStates`, create a
    new one over the same layout: same `releaseId`, `problems`, `stagesRun`;
    `checksVerified=false`; `previewLost=true`; a further commit in the workspace →
    `editsSinceBuild=true`; `launcher.previewStart` over the harness spawns a child and
    `candidateStatus.previewRunning` becomes true; `previewStart` on channel `ai`
    through a guarded wrapper would ask — assert the route's `effect` is `write` in the
    contract.
11. Child stderr: the supervisor given `log.child` writes `stderr` events with
    `source='child:<appId>'` and `run_id NULL`.
12. Grep: no bare `execute` under `src/knowledge/`; `tests/autoapp-boundary.test.ts`
    already scans the package for `instanceof`.

## Acceptance criteria

- Every event, case and context row carries the run id, call id and source revision
  it had when written, or `NULL` where there was none. Nothing is attributed after
  the fact.
- A failure and its repair are an immutable case with the request, the instructions
  and documents as delivered, the example content, and both source revisions.
- Closing the launcher after a build and a check and starting it again shows the
  same candidate, says which checks are verified and which are stale, and offers to
  start the preview again.
- `sanitise` removes the listed patterns; the allow-lists drop everything else.
- `tests/ai-chat.test.ts` and every existing test pass unchanged.
- `bun run check` is green; every command above exits 0.

## Report

`prompts/autoapp/reports/12a-knowledge-foundations.md`. Include: the exact core diffs
(file and line ranges); where `buildCandidate` returns early and what `stagesRun` says
at each; how `previewId` is derived; the size of `knowledge.sqlite` after the test
suite; any allow-list field you added beyond the table and why.

## Commit

```
Write down what the engineer did, with the identity it had at the time

Every tool call, build, check and edit becomes an event in knowledge.sqlite
with its run id, call id and source revision; a failure and its repair become
an immutable case with the request and the context as delivered; the
candidate survives a restart and the preview can be started again. Nothing
serves knowledge yet and nothing calls a model.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
