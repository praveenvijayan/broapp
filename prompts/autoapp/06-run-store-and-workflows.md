# 06 — The run store and saved workflows

## Goal

What agents do is recorded; a successful run can be saved as a workflow;
a workflow runs again through the gate with fresh approvals; and a workflow
can be promoted to a button or form in the interface without generating
host code. After this prompt: every gate decision in a child is recorded in
`runs.sqlite`; runs and steps are queryable from the tab; approvals from
the `workflow` and `mcp` channels are answered from the tab; a workflow can
be drafted from a run, parameterised, validated, run and promoted.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- `packages/broapp/src/host/gate.ts` (`Recorder`, `ExecutionRecord`, `PendingApprovals`), `approvals.ts`.
- `packages/broapp/src/ai/host/run.ts` after prompt 01 — how the AI channel builds its envelope and approver; the workflow channel copies the shape.
- `packages/broapp-autoapp/src/host/views.ts`, `src/views/overrides.ts`, `src/react/*`.
- `packages/broapp-autoapp/src/child/run-child.ts`.
- `node_modules/bun-types/sqlite.d.ts`.

## Step 1 — the store

`packages/broapp-autoapp/src/host/run-store.ts`, opened by the child on
`<dataDir>/runs.sqlite`, WAL mode, schema versioned with the same
migrations-array pattern as `examples/notes/src/host/db.ts`:

```sql
CREATE TABLE runs (
  id           TEXT PRIMARY KEY,          -- the envelope's requestId prefix: for AI, the runId; for workflow, a new uuid; for mcp, the client's call id
  app_id       TEXT NOT NULL,
  release_id   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  caller       TEXT NOT NULL,
  mode         TEXT NOT NULL,
  status       TEXT NOT NULL,             -- running | succeeded | failed | cancelled | unknown
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  summary      TEXT                       -- one line the UI shows; for AI runs the user's message, truncated to 200 chars
);
CREATE TABLE steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id),
  request_id     TEXT NOT NULL UNIQUE,
  route          TEXT NOT NULL,
  effect         TEXT NOT NULL,
  input_json     TEXT NOT NULL,           -- redacted, see below
  arguments_hash TEXT NOT NULL,
  decision       TEXT NOT NULL,
  outcome        TEXT,                    -- succeeded | failed | cancelled | unknown
  output_json    TEXT,                    -- redacted; null when not succeeded
  error          TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
CREATE INDEX steps_run ON steps(run_id, started_at);
CREATE TABLE workflows (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  definition   TEXT NOT NULL,             -- WorkflowDefinition JSON
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  from_run_id  TEXT
);
```

Redaction: `input_json` and `output_json` are the canonical JSON of the
value with every string longer than 2 000 characters replaced by
`"<truncated N chars>"` and every key whose lowercase name contains
`secret`, `token`, `password`, `apikey` or `api_key` replaced by
`"<redacted>"`, at every depth. This is a courtesy, not a guarantee; the
comment says so.

`createRunStore(dataDir, logger): RunStore` with:

- `recorder(): Recorder` — the gate recorder. `record()` inserts the step,
  creating the run row if missing (`status: 'running'`), keyed by
  `requestId` before its last `:` for `ai` and by the whole id otherwise;
  it never throws (the gate already guards, but the store logs and swallows
  too). `output_json` is written only when the record carries an outcome
  of `succeeded`; the gate does not pass outputs today — add an optional
  `output?: unknown` to `ExecutionRecord` in `gate.ts` and have `guard`
  fill it on success. Name that core change in the report.
- `finishRun(runId, status, summary?)`.
- `markUnknownOnStart()`: at store open, every `runs.status = 'running'` and
  every step with `decision IN ('allowed','confirmed') AND outcome IS NULL`
  becomes `unknown`. This is the "process died mid-step" rule; it runs
  before the first request is admitted.
- `listRuns({ limit, before })`, `getRun(id): { run, steps }`.
- `saveWorkflow`, `getWorkflow`, `listWorkflows`, `deleteWorkflow`.

Wire it into `run-child.ts`: create the store before the gate, pass
`recorder()`, call `markUnknownOnStart()`. The AI runner's run id becomes
visible: `createAi` gains an optional `onRunEnd?(runId, status, summary)`
callback which the child uses to call `finishRun`; `run.ts` calls it at the
end of every chat stream with `succeeded`, `failed` or `cancelled`. Name
that core change in the report.

## Step 2 — workflows

`packages/broapp-autoapp/src/workflows/types.ts`:

```ts
export interface WorkflowParam {
  readonly name: string;                       // [a-z][a-zA-Z0-9]*
  readonly type: 'text' | 'number' | 'boolean';
  readonly label: string;
  readonly required?: boolean;
}

export interface WorkflowStep {
  readonly id: string;                         // [a-z][a-z0-9-]*, unique
  readonly route: string;
  /**
   * Literal input where a string of the form `$param.<name>` is replaced by
   * a parameter and `$step.<stepId>.<path>` by a prior step's output. No
   * other substitution exists.
   */
  readonly input: unknown;
  /** Optional: the step is skipped when the referenced prior output at `path` deep-equals `value`. */
  readonly skipWhen?: { readonly step: string; readonly path: string; readonly equals: unknown };
}

export interface WorkflowDefinition {
  readonly version: 1;
  readonly params: readonly WorkflowParam[];
  readonly steps: readonly WorkflowStep[];
  /** 'stop' is the only policy in v1. */
  readonly onFailure: 'stop';
}
```

`validate.ts`: `parseWorkflow(raw)` with the `s` schemas and rules: unique
step ids; every `$step` reference names an earlier step; every `$param`
names a declared parameter; every route exists in the running contract
(pass the `ContractExport` in); `skipWhen.step` is earlier.

`draft.ts`: `draftFromRun(run, steps, contract): WorkflowDefinition` — one
step per recorded step with `decision IN ('allowed','confirmed')` and
`outcome = 'succeeded'`, inputs as recorded literals, no params. A run
containing an `unknown` step is refused with `conflict` and the message
"this run has a step with an unknown outcome and cannot be saved as a
workflow". `parameterise(definition, picks: { stepId, inputPath, paramName, type, label }[])`
replaces the literal at `inputPath` with `$param.<name>` and adds the
parameter; the same literal elsewhere is not touched (explicit picks only).

`run.ts`: `runWorkflow({ app, contract, definition, params, approver, runId, signal, logger })`:
for each step in order, resolve references, `skipWhen`, then
`app.invoke(route, input, { requestId: \`${runId}:${step.id}\`, channel: 'workflow', caller: \`workflow:${workflowId}\`, signal, approver })`.
The first failure stops the run. Returns
`{ status, steps: { id, status, output? | error? }[] }`. Recorded approvals
from a previous run are never consulted; every `write` or `external` step
asks again, because approval is per request by design.

## Step 3 — approvals from the tab

Routes added to `autoappContract` (prompt 04's file):

| Route | effect | input | output |
|---|---|---|---|
| `autoapp.approvalsList` | read | void | `{ pending: ApprovalQuestion[] }` |
| `autoapp.approvalsAnswer` | write | `{ requestId, approved, releaseId, argumentsHash }` | `{ result: 'accepted' \| 'unknown' \| 'mismatch' }` |
| `autoapp.runsList` | read | `{ limit?, before? }` | `{ runs: RunSummary[] }` |
| `autoapp.runGet` | read | `{ id }` | `{ run, steps }` |
| `autoapp.workflowDraft` | read | `{ runId }` | `{ definition }` |
| `autoapp.workflowSave` | write | `{ id?, name, definition }` | `{ id, version }` |
| `autoapp.workflowsList` | read | void | `{ workflows: { id, name, version, updatedAt }[] }` |
| `autoapp.workflowDelete` | write | `{ id }` | `{ removed }` |
| `autoapp.workflowRun` | write | `{ id, params }` | `{ runId, status, steps }` |
| `autoapp.workflowPromote` | write | `{ id, page, afterComponentId, label }` | `{ ok: true }` |

`autoapp.approvalsAnswer` is a `write` from the user's own click; the gate
allows it for channel `user`. It must carry `releaseId` and
`argumentsHash` so the binding check in `PendingApprovals.answer` is
exercised; the UI copies them from `approvalsList`.

`createViewsHost` is renamed `createAutoappHost({ dataDir, views, store, contract, app, approvals, logger })`
and its file moves from `src/host/views.ts` to `src/host/autoapp.ts`;
and now owns one `PendingApprovals` for the `workflow` and `mcp` channels.
The child creates it and passes the same instance to `runWorkflow` and
(prompt 08) to `invoke` from MCP. When `running.attached` is false, the
approver denies at once with the reason "no browser tab is attached to
answer"; that check is a wrapper `attachedOnly(approvals, isAttached)`
around the pending table, so the table itself stays simple.

`autoapp.workflowRun` is itself a `write` operation from the user; inside
it, every step is a fresh `workflow`-channel request that asks again. The
UI shows the pending questions in an approvals strip; answering continues
the run. `autoapp.workflowRun` returns only when the run ends, so it may
take as long as the person takes; the operation's own `signal` is the
run's signal, and closing the tab cancels it.

## Step 4 — promotion

`workflowPromote` writes an **addition** override. Extend `Overrides` from
prompt 04:

```ts
export interface Addition {
  readonly id: string;                       // 'wf-<workflowId>'
  readonly page: string;
  readonly afterComponentId: string;
  readonly component: Component;             // kind 'button' or 'form' only, action operation must be 'autoapp.workflowRun'
}
export interface Overrides { readonly version: 1; readonly items: readonly Override[]; readonly additions?: readonly Addition[] }
```

`applyOverrides` inserts additions after the named component, reporting a
conflict when the page or the anchor is gone. `workflowPromote` builds a
`form` when the workflow has parameters (one field per parameter) and a
`button` otherwise, with `action.input = { id: '<workflowId>', params: { <name>: '$field.<name>' } }`
and `confirmText` "Run <name>?". The renderer treats `autoapp.workflowRun`
like any other `write` operation.

`checkViewsAgainstContract` must accept `autoapp.*` routes when the
`autoappContract` export is merged in; pass the merged export.

## Step 5 — renderer additions

`packages/broapp-autoapp/src/react/`:

- `ApprovalsStrip.tsx`: polls `autoapp.approvalsList` every 2 s while any
  run is active, shows route, effect, input (as formatted JSON), Approve
  and Decline. Included at the top of `AutoappView`.
- `RunsPage.tsx`: a built-in page `#/autoapp/runs` listing runs, a run's
  steps, and a "Save as workflow" button that calls `workflowDraft`, shows
  the draft's steps with each literal input, lets the person pick literals
  to turn into parameters (name, label, type), and calls `workflowSave`.
- `WorkflowsPage.tsx`: `#/autoapp/workflows` listing workflows, Run (a
  form from params), Promote (choose page and anchor from the current
  views), Delete.

Plain CSS in `view.css`. No new dependencies.

## Step 6 — tests

`tests/autoapp-runs.test.ts` and `tests/autoapp-workflows.test.ts`:

1. Recorder writes one step per gate decision, including `denied` and `refused`; `finishRun` sets status; `getRun` returns them in order.
2. Redaction: long strings truncated, secret-like keys replaced, nesting handled; original value untouched.
3. `markUnknownOnStart`: a `running` run and an outcome-less allowed step become `unknown`.
4. `draftFromRun` produces one step per succeeded step and refuses a run with an `unknown` step with `conflict`.
5. `parameterise` replaces only the picked literal.
6. `parseWorkflow` rejects: forward `$step` reference, unknown param, unknown route, duplicate step id.
7. `runWorkflow` over the harness with the prompt 05 fixture application: a read step runs without asking; a write step asks through the approver; declining stops the run with `failed` and later steps `skipped`; approving continues; `$step` references resolve; `skipWhen` skips.
8. `attachedOnly`: with `isAttached()` false, a write step is denied without the table being consulted.
9. `approvalsAnswer` with a wrong `argumentsHash` yields `mismatch` and the step is denied.
10. `workflowPromote` adds a button or a form; `viewsGet` shows it after its anchor; removing the anchor in a new views spec yields a conflict, not a crash.
11. Browser-bundle boundary still holds for `broapp-autoapp/react`.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-runs.test.ts tests/autoapp-workflows.test.ts
bun test tests
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run check
```

By hand in Notes: ask the AI to create two notes; open `#/autoapp/runs`;
save the run as a workflow with the title as a parameter; run it from
`#/autoapp/workflows` and approve the creation; promote it to the `notes`
page after `new-note`; reload; use the new form. Record it.

## Acceptance criteria

- Every gate decision in a child appears in `runs.sqlite`.
- A run interrupted by a process death shows `unknown` and cannot be saved as a workflow.
- A saved workflow asks again for every write on every run.
- Promotion changes the interface without a new release.

## Report

`prompts/autoapp/reports/06-workflows.md`.

## Commit

```
Record runs and add saved workflows

Every gate decision is recorded in the application's runs.sqlite; a run
that dies mid-step is marked unknown and cannot be replayed. A succeeded
run can be drafted into a workflow, parameterised, and run again through
the gate with fresh approvals answered from the tab. Promoting a workflow
adds a button or form to the interface through an override.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
