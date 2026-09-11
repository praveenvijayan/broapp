# 12c — Distillation: provisional lessons, diagnosis, review

## What was built

- **Core D**: `Ai.model(override?)` in `create-ai.ts` (`registry.resolve` → `adapter.model`); the `adapter.ts` comment names it. Nothing else in core.
- **Step 0**: `LAUNCHER_MAX_STEPS = 40` passed by `createLauncherTab` (`maxSteps` option); the two-word/route rule for turn lessons in `serve.ts` (hints keep one word); seed 7; `indexWorkspace` follows no symlink, skips link files, reads through `within` (now exported); `searchWorkspace` refuses >200 characters and nested quantifiers, tests 1,000 characters a line; `Serve.ended(runId)` and a one-hour sweep on every `search`.
- `knowledge/distil.ts` (`DIAGNOSES`, `DIAGNOSIS`, `DISTILLER_SYSTEM`, `createDistiller`, `distillerPrompt`, `pendingCases`), `freshness.ts` (`reviewFlags`, `instructionsHash`), `cli.ts` (`runKnowledgeCommand`, `showLesson`). `knowledge <list|show|confirm|retire|export>` in `main.ts`; `knowledge.show` tool (`read`).
- `tab.ts`: `reviewFlags` after seeding; a distiller over `ai.model()`; `onRunEnd` → `serve.ended`, `scoreRunEnd`, then `enqueue(pendingCases)`. `main.ts` closes the distiller before knowledge.
- Docs: `learning.md` (Distillation section), `security.md`, `backlog.md` (two rows, the step-cap note). Tests: 17 new in `autoapp-knowledge.test.ts`, 1 in `ai-host.test.ts`.

## Deviations, and why

1. **The answer's JSON shape is also in the user prompt.** The demo showed Ollama's OpenAI-compatible endpoint drops `responseFormat` ("only supported with structuredOutputs"), so the model never saw the schema: 0 of 3 valid. The system text is unchanged, word for word.
2. **`ask()` drains `partialObjectStream` before `await result.object`.** `object` never settles until the stream is read; every distiller test hung without it.
3. **Eviction is `Serve.ended(runId)`, called by the tab beside `scoreRunEnd`**, which is a free function with no access to the map. `Serve.inFlight()` is for the test.
4. **`LauncherTab.distiller`, not `knowledge.idle()`**: `tab.knowledge` must stay the store, or 12a's `toBe(where.knowledge)` changes.
5. **A confirmed lesson is never superseded by the distiller.** A provisional one becomes `superseded` as specified; a confirmed one keeps its status and gets `review='needs_review:superseded'`. Otherwise an unconfirmed lesson overrules a person, against "no status changes without a person".
6. **Seeds are inserted when their summary is missing**, not only into an empty table, or seed 7 never reaches an existing database. A retired seed stays in the table and is not re-added.
7. **`episodes.diagnosis` is canonical JSON `{diagnosis, reasoning}`**: one write-once column, and `show` needs the reasoning. `lessons.diagnosis` is the bare enum the serve filter reads.
8. **Guardrails check summary, detail and trigger**: `knowledge.show` returns `detail` to the model. `knowledge.show` also refuses a `method_unclear` lesson.
9. `search` allow-list gains `miss` and `lessonId`. A lesson's `applies.stage` defaults to the case's stage when the model gives none, so the hint filter applies to it.
10. **Freshness**: "served under a different hash" is the lesson's hash against the running one (servings record none); counts are of servings since `reviewed_at`; the upgrade flag is for never-reviewed lessons, since a version string cannot say whether a review came before an upgrade.
11. **`enqueue(pendingCases())`, every pending resolved case**, not only the run's: a failed question is retried at a later turn's end.
12. **One existing test changed**: the 12b budget-cut test matched seed 4 via "list" alone; now its message is `add a back button to the page and rename its component` and it asserts on seed 4 (component/rename). Same assertions.
13. The commit trailer names Claude Opus 5, per this session's attribution rule.

## The distiller's prompts

System, verbatim (`DISTILLER_SYSTEM`, 877 characters): the prompt's paragraph exactly, from "You are reviewing one failure…" to "…Do not include paths from this machine."

User, assembled from blobs in this order: `# What the person asked for` · `# The instructions the engineer was given` (the `contexts` blob) · `# The documents the engineer was given` (`## <ref>`, "(cut short by the budget)" when truncated) · `# The failure` (`Stage:`, `Problem:`) · `# The acceptance example that failed` (check cases) · `# The edits that followed` (log, then `- [paths] matched by [...]` per edit event) · `# Revisions` (`Before:`/`After:` with releases) · `# What was logged while the case was open` (≤ 20 events) · either `# A lesson that already exists for this failure` ("This lesson existed when the failure happened and was / was not among the documents delivered." / "did not exist yet", "If the cause is the same, set sameCauseAs to its id.") or "None exists. Set sameCauseAs to null." · `# Your answer` (the six names, "lesson is null unless…", the JSON Schema).

## One real distillation

The 12b rerun built nothing, so it left no case. The demo (`tests/.autoapp-run/demo-12c.ts`, gitignored) reconstructs the nearest one: Notes imported and built, the 07/08c request served and recorded as the tab's `onContext` does (`digest:notes`, `evidence:notes`, `lesson:7` — the new workflow seed), then the tools driven with scripted edits: `notes.archive` added without `effect` (the rerun's second edit was in `contract.ts`), `candidate.build` failed at `contract` with hints 2 and 6, `effect: 'write'` added, the build passed and resolved case 1. The distiller then ran against local Ollama `qwen3.8:27b-mlx`; nothing left the machine, no key was entered.

| Run | Input (system + user) | Result | Time |
|---|---|---|---|
| before deviation 1 | 877 + 7,183 = 8,060 | attempt 1 and 2: `diagnosis` not one of the six; attempt 3: "No object generated: could not parse the response" → `failed` | 22.4 s, 9.2 s, 19.5 s |
| after | 877 + 8,908 = 9,785 | **valid first time**: `method_not_followed`, no lesson, state `done` | 21.6 s |

Largest user sections: the instructions 3,673, the documents 2,297, the answer shape 1,457, the events 551. The answer's reasoning, verbatim: *"The requirement that every route must declare an effect (read, write, or external) was stated explicitly in the workspace section of the instructions ('Every route needs an effect (`read`, `write` or `external`) and a `summary`') and reiterated in the evidence constraints ('every route needs effect and summary'). The engineer added the notes.archive route to contract.ts but omitted the effect field. The repair was a one-line addition of `effect: 'write'`. This is a straightforward omission of a clearly stated constraint, not a missing fact or unclear instruction."* Correct, and correctly no lesson.

`knowledge list` afterwards (summaries cut here; review column `-` on all):

```
   1  confirmed  global  views     0/0/0/0  The renderer has no navigation-only action. …
   2  confirmed  global  contract  1/0/0/0  The build exports the contract and refuses, at the contract stage, …
   3  confirmed  global  host      0/0/0/0  A release inlines everything its host imports except bun:sqlite …
   4  confirmed  global  spec      0/0/0/0  A migration checksum in autoapp.json is validated as 64 hex …
   5  confirmed  global  views     0/0/0/0  A component id in views.ts is the key a person's customisations …
   6  confirmed  global  -         1/0/0/0  An operation that writes a file, such as notes.backup, is a write, …
   7  confirmed  global  views     0/0/0/1  Saved workflows and their promotion to a view action live in …
```

Seed 6 (MCP) was hinted for the contract failure through the one word "effect" and has no stage, so the repair credited it `resolved` beside seed 2. Association noise; 12d should count it.

## Commands run

```
bun run typecheck                                            exit 0
bun test tests/ai-host.test.ts                               12 pass, 0 fail
bun test tests/autoapp-knowledge.test.ts tests/autoapp-engineer.test.ts   82 pass, 0 fail
bun run tests/.autoapp-run/demo-12c.ts                       exit 0 (twice; table above)
bun install && bun run check                                 exit 0; 641 pass, 0 fail (39 files)
```

## Acceptance criteria

- **A resolved case is diagnosed exactly once, with one of six causes, from the blobs only; a lesson only for the two causes** — pass (tests 1–5; `distil.ts` reads no file).
- **Every lesson carries provenance, applicability, the method version, and starts provisional** — pass (test 1, `show`).
- **No status changes without a person; review flags say why** — pass (freshness tests; deviation 5 for the one place the prompt would have).
- **`bun run check` green; every command exits 0** — pass.

## Open questions

- `tests/autoapp-knowledge.test.ts` is still not in CI's per-platform list; the CLI and symlink cases would want Windows.
- Distillation was measured on one reconstructed case. Whether the six-way diagnosis is stable across cases and models is 12d's question.
- `knowledge_not_retrieved` depends on the model naming a lesson id; with no prior lesson shown it usually cannot.
