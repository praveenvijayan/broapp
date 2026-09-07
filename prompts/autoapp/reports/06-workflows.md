# 06 — The run store and saved workflows

## What was built

- **Core (both changes named in the prompt).** `ExecutionRecord.output`, filled
  by `guard` on success only. `createAi({ onRunEnd })`, called once per chat
  turn with `succeeded`, `failed` or `cancelled` — including the `error` and
  `abort` branches, and including a turn that threw.
- `src/host/run-store.ts` — the recorder, redaction, `markUnknownOnStart`, runs,
  steps and workflows, in `runs.sqlite` inside the application's data directory.
- `src/workflows/` — `types.ts`, `validate.ts`, `draft.ts`, `run.ts`.
- `src/host/autoapp.ts` — `createAutoappHost` (was `createViewsHost`), the ten
  new routes, one `PendingApprovals` for the `workflow` and `mcp` channels, and
  `attachedOnly` around it.
- `src/views/overrides.ts` — `Addition`, inserted after its anchor.
  `src/views/merge-contract.ts` — `withAutoappRoutes`.
- `src/react/` — `ApprovalsStrip`, `RunsPage`, `WorkflowsPage`, wired into
  `AutoappView` at `#/autoapp/runs` and `#/autoapp/workflows`.
- `tests/autoapp-runs.test.ts` (9) and `tests/autoapp-workflows.test.ts` (24).

## Deviations, and why

1. **A one-step run is closed by the recorder.** The prompt has `finishRun` as
   the only way a run ends, but only the AI layer and the workflow runner call
   it — so every `user` and `mcp` run sat at `running` for ever, which is not
   "in progress" but "nobody ever said". Channels in `GROUPED_CHANNELS`
   (`ai`, `workflow`) are still closed by their driver; everything else is
   closed by its single step. Found by the manual run.
2. **`autoapp.runsList` gained a `channels` filter**, and `RunsPage` asks for
   the agent channels by default with a checkbox for the person's own. Every
   gate decision is still recorded — the acceptance criterion — but a page
   called "what agents did" whose first twelve rows are the approvals strip's
   own polling is a page nobody reads. Also found by the manual run.
3. **`autoapp.workflowsList` returns each workflow's `params`.** Without them
   the workflows page cannot build the form to run one, so the first manual run
   failed with a parameter nobody had supplied.
4. **A binding failure reports its own message.** `$param.title was not
   supplied` was being reduced to "The step failed." — but the message is about
   the workflow's own configuration and contains nothing from the host.
5. **`workflowPromote` validates before it writes.** It applies the addition,
   checks for a conflict, and checks the result against
   `withAutoappRoutes(contract)`. Promoting onto a missing anchor is now
   refused rather than becoming a conflict line to work out later.
6. **`createAutoappHost` takes `contract`, `app` and `isAttached`.** The prompt's
   signature has `approvals`; the host owns the table instead and exposes it, so
   there is exactly one and the child cannot accidentally pass a second.
7. **The manual check used a `user` run rather than an AI one** — see below.
8. The commit trailer names Claude Opus 5, per this session's attribution
   instruction.

## One thing worth stating plainly

**A workflow cannot approve itself.** Workflow steps are validated against the
*application's* contract, which does not contain the `autoapp` group, and they
are invoked through the application's own `HostApp`, which does not serve those
routes. So a step naming `autoapp.approvalsAnswer` is refused at save time and
would have nowhere to go at run time. That is structural rather than a rule, and
`src/views/merge-contract.ts` says so where somebody might be tempted to merge
the tables for convenience. A test asserts it.

## The manual check

**Deviation:** the prompt asks for an AI-driven run. No model provider is
reachable in this environment — Notes compiles in Anthropic, Ollama and two
OpenAI-compatible adapters, all of which need a key or a local server — so a
`user`-channel run stood in as the thing to draft from. Everything after the
draft is the path the prompt describes, and the workflow's own steps run on
channel `workflow`, which is the channel that matters for the approvals.

| Step | What happened |
|---|---|
| Create a note through the interface | recorded as a one-step `user` run, `notes.create · succeeded` |
| `#/autoapp/runs` | agent list empty; "Include my own actions" shows the click |
| Open it, "Save as workflow" | drafted one step, offering `title` and `body` as literals |
| Pick `title`, name it "Add a note", save | saved, version 1 |
| `#/autoapp/workflows` → Run | the strip asked: `workflow:5eea1655… wants to run notes.create (write)` with `{"title":"From the workflow","body":""}` |
| Approve | `Run succeeded. notes-create · succeeded` |
| Promote after `new-note`, reload | `new-note`, `wf-5eea1655…`, `notes-table`; the form is titled "Add a note"; no conflicts |
| Use the promoted form | `window.confirm` asked "Run Add a note?", then the strip asked again for the step, with the new title |
| Approve | three notes in the table: "Promoted and used", "From the workflow", "Weekly review" |

The second run asked again for a write it had already been approved for once —
which is the property the whole design turns on.

## Commands run

```
bun run typecheck                            exit 0
bun test tests/autoapp-runs.test.ts          9 pass, 0 fail
bun test tests/autoapp-workflows.test.ts     24 pass, 0 fail
cd examples/notes && bunx tsc --noEmit       exit 0
cd examples/notes && bun test tests          23 pass, 0 fail
cd examples/notes && bun run build           bin release/notes 69.8 MiB
bun run check                                exit 0 - 382 pass, 0 fail (26 files)
```

## Acceptance criteria

- **Every gate decision in a child appears in `runs.sqlite`** — pass. The child
  builds the store before the gate and passes `store.recorder()`; a test asserts
  `allowed`, `confirmed`, `denied` and `refused` all produce a row.
- **A run interrupted by a process death shows `unknown` and cannot be saved as
  a workflow** — pass. `markUnknownOnStart` runs before the first request is
  admitted; `draftFromRun` refuses with `conflict` and the exact sentence.
- **A saved workflow asks again for every write on every run** — pass, in a test
  that runs the same workflow twice and would hang if an old approval could be
  reused, and again in the manual run.
- **Promotion changes the interface without a new release** — pass. The
  promoted form appeared after a reload with the release id unchanged; the
  addition lives in the person's own `overrides.json`.

## Open questions

- **The tab does not notice a promotion until it reloads.** `viewsGet` is
  fetched once when `AutoappView` mounts. Refetching after a promotion is a
  small change and belongs with whatever prompt 07 does to the launcher tab.
- Every `user` call is a run of its own, so `runs.sqlite` grows with ordinary
  use. Retention belongs with prompt 10's `prune`.
- `workflowRun` returns only when the run ends, so a workflow waiting on a
  person holds an operation open for as long as they take. That is what the
  prompt specifies, and the operation's signal cancels it, but a long workflow
  would be better as a stream.
