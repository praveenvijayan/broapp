# Broapp Autoapp — build prompts

Autoapp is the pivot: a Broapp application that its owner can reshape while
using it, with an engineer built into the experience. It lives on the
`autoapp` branch and in a new package, `packages/broapp-autoapp`. The core
`packages/broapp` is touched only for the execution gate and the `effect`
field on the contract. Nothing lands on `main` until every stage below has
cleared.

The prompts below, run in order, one per agent session. Each prompt is
self-contained but assumes the previous ones landed. Every prompt ends by
writing a short report to `prompts/autoapp/reports/NN-<name>.md`; the next
prompt starts by reading the reports so far.

| # | File | Produces | Gate |
|---|------|----------|------|
| 00 | `00-common-rules.md` | Rules and fixed decisions every prompt must follow. Read first, every time. | — |
| 01 | `01-execution-gate.md` | `effect` on the contract; release identity; one execution gate every entry point uses; adversarial tests. | `bun run check` green. `tests/ai-chat.test.ts` unmodified and green. |
| 02 | `02-spike-supervision.md` | Proof that a compiled launcher can supervise a compiled child over IPC and that the child can load a versioned app artifact with no Bun installed. | Stop if the spike fails. Report the failure. Do not continue to 03. |
| 03 | `03-app-spec-and-manifest.md` | The versioned application specification: manifest, contract export, view/workflow/migration references, capabilities. Spec store on disk. | Tests green. |
| 04 | `04-view-spec-and-renderer.md` | The declarative view specification and the pinned React renderer. Notes runs on it. Overrides by stable id. | Notes runs on the renderer. Tests green. |
| 05 | `05-candidate-and-activation.md` | Candidate releases, SQLite snapshots, drain, migrate-a-copy, health check, durable switch, activation journal, restart recovery. Failure tests. | Activation tests green, including interruption. |
| 06 | `06-run-store-and-workflows.md` | Supervisor-owned run store; runs, steps, unknown outcomes; save-as-workflow; promote a workflow to a view action. | Tests green. |
| 07 | `07-engineer-service.md` | The AI engineer: tools that read the spec, propose a change, build a candidate, preview it, and request activation. All through the gate. The Notes demo. | The full loop runs by hand. |
| 08 | `08-mcp-adapter.md` | An MCP server over the same gate, approvals answered from the Broapp tab, denied when no tab is attached. | Tests green. Manual check with an MCP client. |
| 08b | `08b-fixups.md` | Release identity covers the whole specification; hunk edits for the engineer; no `instanceof` across the release boundary; the demo rerun with a capable model. | Tests green. Demo log with one row per step. |
| 08c | `08c-engineer-usability.md` | Indentation-tolerant hunks, `apps.list`, a ten-minute confirm window for the engineer with a countdown. | Tests green. Demo step 3 rerun. |
| 09 | `09-packaging-matrix.md` | Linux and Windows coverage for the supervision chain; fixed packaged dependencies; the three offline tiers documented as tested. | CI green on every OS. |
| 10 | `10-phase-2-backlog.md` | Not a build prompt. What was deliberately deferred and why. | — |
| 11 | `11-new-application.md` | A starter workspace embedded in the launcher binary; `launcher.appCreate`, a `create` command and an `apps.create` tool sharing one implementation with `import`; a **New application** button in the tab. | Tests green. Smoke test's create step passes. |
| 12a | `12a-knowledge-foundations.md` | `knowledge.sqlite`: every build, check, edit and activation as a sanitised event with the run id, call id and source revision it had at the time; failures and repairs as immutable cases with the context as delivered; the candidate durable across a restart; `launcher.previewStart`. Five optional core hooks. | Tests green. `tests/ai-chat.test.ts` unchanged. |
| 12b | `12b-knowledge-path.md` | Orientation and task-evidence documents on every turn; `source.search`; curated facts as build-failure hints; `verification` on every edit result; servings with delivered-or-not and stage-aware outcomes. No model calls. | Tests green. 08c request rerun: tool calls before the first edit and whether a build was reached. |
| 12c | `12c-knowledge-distillation.md` | One structured question to the model per resolved case; six diagnoses; provisional lessons with provenance; supersession and review flags; `knowledge list/show/confirm/retire/export`; `Ai.model()`. | Tests green. One real distillation logged. |
| 12d | `12d-knowledge-replay.md` | Replay a case with and without its lesson from a manifest into fresh checkouts with a frozen corpus; `knowledge confirm` shows the table; `knowledge evaluate` runs four conditions on three tasks. | Tests green. Evaluation table beside the 08c numbers. |
| 12e | `12e-site-and-docs.md` | The site's header menu built from page groups so Autoapp is a tab; a landing page in `docs/autoapp/README.md` with the architecture diagram; titles without the prefix; the banner version from the manifest; nested relative links to `diagrams/` resolving. | Tests green. `bun run site` builds; the tab and the diagram visible. |

## How to run one prompt

Give the agent this exact instruction, replacing `NN`:

```
You are on the `autoapp` branch of /Users/pv/works/broapp. Confirm with
`git branch --show-current` before anything else; if it prints anything
other than `autoapp`, stop and say so.
Read prompts/autoapp/00-common-rules.md, then every file in
prompts/autoapp/reports/ in order, then prompts/autoapp/NN-*.md.
Do what NN says. Do not do anything from a later prompt.
```

## Why it is split

The agent doing the work has limited room for open-ended reasoning. Each
prompt therefore fixes every naming and layout decision up front, lists the
files to read before writing, states the exact interfaces, names the tests,
and gives the commands whose output decides whether the step is done. Where
a third-party API must be confirmed, the prompt says which `.d.ts` to open
rather than asking the agent to recall it.

## Where this came from

Three design reviews, recorded in `docs/autoapp/design.md` (written by prompt
01 from the decisions table in `00-common-rules.md`). The short version: the
contract stays the boundary; generated code runs in a child process and is
called trusted, not sandboxed, in v1; the browser never runs generated
JavaScript, it runs a pinned renderer over a declarative view specification;
every mutation from any agent passes one gate; a change becomes a candidate
release that is previewed on a data copy and then activated with a recovery
path; MCP is an adapter over the same gate, not a second door.
