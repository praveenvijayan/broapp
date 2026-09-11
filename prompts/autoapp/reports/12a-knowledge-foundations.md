# 12a — Knowledge foundations

## What was built

- **Core** (all optional in type): `run(input, signal, envelope?)`; `search` gets `runId`; `onRunEnd(…, detail?)` with `{ usage?, steps, ms }`; `onContext(runId, { system, documents, message, model })`. Hooks run through `safely()`: one that throws is logged and the turn goes on. Line ranges: `tool.ts` 50–51, 71, 92–98; `create-ai.ts` 32–57, 103–112, 252; `index.ts` 10–16; `run.ts` 31, 57–87, 211–214, 458–475, 489, 522–537 (`onContext`), 543, 559–575 (step count, usage), 603–604.
- `candidate.ts`: `BUILD_STAGES`, and `stagesRun` on both result branches.
- `src/knowledge/`: `store.ts` (schema, triggers, retention, `signature`, `tokens`, `ftsQuery`), `log.ts` (`createEventLog`, `sanitise`, allow-lists), `ids.ts` (`origin`, `sourceRevision`), `evidence.ts` (`createEvidence`, `exampleHash`, `recordContext`), `version.ts`, `index.ts`. Exported as `broapp-autoapp/knowledge`.
- **Resume**: `engineer/state.ts` stores the candidate in `candidate.json` (new `AppLayout.candidate`); `engineer/preview.ts` holds `startPreview`, used by `candidate.preview` and by the new `launcher.previewStart` (`write`); `ChildHandle.spawnedAt`; `CandidatePanel` shows the three sentences and a **Start preview** button.
- **Wiring**: tools write events and cases; `tab.ts` records contexts and `run`/`usage` events; `main.ts` opens knowledge before the supervisor for `open`/`serve`; the supervisor sends child stderr through `log.child`.
- Docs: `learning.md` (new, and added to the site in `scripts/build-site.ts`, since `design.md` now links to it), plus edits to `design.md`, `security.md` and `backlog.md` (two rows). Tests: `tests/autoapp-knowledge.test.ts`, 13 cases.

## Where `buildCandidate` returns, and what `stagesRun` says

| Return | `stagesRun` |
|---|---|
| `autoapp.json` unreadable, or its `appId` is wrong (:211, :214) | `['spec']` |
| shared layer does not bundle (:239) | `['contract']` |
| any problem from contract, views, page or host (:320) | `['contract','views','page','host']` |
| page/host bytes unreadable, `parseSpec`, or a failed write (:330, :363, :377) | all five |
| success, built or already built (:374, :391) | all five |

## Deviations, and why

1. **The shared-bundle failure reports `['contract']`, not the prompt's `['spec','contract']`.** `spec` has two halves: the manifest read at the start, and the assembly (`parseSpec`, identity, write) at the end. If a build that stopped at the contract listed `spec`, a case from the assembly (for example a refused capability) would be resolved by a build that never ran that check. So `spec` counts as run only when the manifest read failed, or when the assembly ran.
2. **A failing build also resolves the cases of stages that ran and found nothing.** The table says "on success". But `stagesRun` only matters if failing builds resolve too. A stage that ran into a problem of its own resolves nothing, because an old failure that became a new one is not a repair.
3. **`DeliveredContext` gains `model`**, as well as `message`. The case's `model_*` columns must be captured when the turn happens, not read later from settings.
4. **Immutability is enforced by SQLite triggers** (opening columns written once, edits append-only while open, resolution written once, blobs never updated). `diagnosis` may be written once, even after resolution, because 12c writes it to resolved cases.
5. **`signature` shortens any other absolute path to its last segment** (after the `/source/` cut). Bundler messages name `autoapp-build-XXXXXX`, a random directory. Both path rules only match where a path can start, so a relative `src/shared/…` is left alone.
6. **Allow-lists mark each field `keep` or `text`.** Identifiers are stored as they are: `sanitise` would turn a 32-hex release id into `<redacted>`. `redact()` runs only inside text fields. Test 9 caught it erasing `inputTokens`, because the key contains "token". The `authorization` rule also takes a `Bearer`/`Basic` scheme word; otherwise the token after it survived.
7. **Data over 4,000 characters is stored as `{"truncated": "…"}`**, so it stays valid JSON. No allow-list field was added beyond the table.
8. **`contexts` blobs are verbatim**, not sanitised. Test 9 requires the system prompt byte for byte, and this is the record of what the model was sent. `security.md` says so.
9. **`EngineerKnowledge.turn(runId)`** was added to the tools' knowledge option. The tools see only the envelope; the person's message lives in the tab's map.
10. **Existing tests stay unchanged:** the tab's `knowledge: { store, log, evidence }` is one optional bundle, `LauncherTab.knowledge` is `Knowledge | null`, and `createCandidateStates(layout?)` works in memory without a layout.
11. `StoredCandidate` also keeps `changed` and `capabilityDiff` ("CandidateState minus the preview handle"). `log.child(appId, pid?)` takes the pid.
12. **`serve <appId>` opens knowledge too**, so `keepServing`, `recover` and `startControl` get the log as the prompt lists. One-shot commands open nothing.
13. `close()` switches to `journal_mode = DELETE` after the checkpoint. The macOS system SQLite otherwise leaves an empty `-wal` (test 1).
14. The `launcher.activate` route also writes an `activate` event and clears `previewWasRunning`. `STAGE_NAMES` is duplicated in `contract.ts` because that contract is bundled into the page; a test holds it equal to `BUILD_STAGES`.
15. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Decisions I made

- **`previewId`** is `` `${releaseId}:${spawnedAt}` `` (`previewIdOf`). A pid can be reused after a restart; a spawn time plus the release cannot.
- An `edit` event's `source_rev` is the revision **after** the commit, the one the edit produced. A build's is the revision **before** the build, which is what it built (`builtFromRev`).
- `candidate.json` is written only when `apps/<appId>/` exists, so a tool asked about an unknown id does not create an application directory.
- `editsSinceBuild` is always false for a workspace without its own git repository (`no-git` on both sides).

## Commands run

```
bun run typecheck                                  exit 0
bun test tests/ai-chat.test.ts tests/autoapp-gate.test.ts    49 pass, 0 fail
bun test tests/autoapp-{engineer,create,offline,activation,supervisor,mcp,boundary}.test.ts   112 pass, 0 fail
bun test tests/autoapp-knowledge.test.ts           13 pass, 0 fail
cd examples/notes && bunx tsc --noEmit             exit 0
bun run site                                       21 files in site/dist, learning.md among them
bun install && bun run check                       exit 0; 611 pass, 0 fail (39 files)
bun run --cwd packages/broapp-autoapp build:launcher   dist/broapp-autoapp 75.3 MB, exit 0
```

**`knowledge.sqlite` size after the suite:** 94,208 bytes for a store holding only the schema (23 pages); 106,496 bytes after the launcher-tab turn, the largest one the suite leaves.

## Acceptance criteria

- **Every event, case and context row carries run, call and source revision at write time, or NULL** — pass (tests 5, 6, 9, 11). The edit in test 9 carries `run-ctxtest1`/`call-0` from the real run loop.
- **A failure and its repair are an immutable case with the request, the context, the example and both revisions** — pass (tests 6, 8). The trigger refuses `UPDATE problem`, and also `resolved_at` and `edits`.
- **After a restart: the same candidate, which checks hold, an offer to start the preview** — pass (test 10), including `launcher.previewStart` over a real bridge.
- **`sanitise` removes the listed patterns; the allow-lists drop the rest** — pass (test 4).
- **`tests/ai-chat.test.ts` and every existing test pass unchanged** — pass; `git diff` touches no existing test.
- **`bun run check` green** — pass: exit 0, 611 pass, 0 fail.

## Open questions

- `tests/autoapp-knowledge.test.ts` is not in CI's per-platform Autoapp list (`ci.yml:101`). On Windows the preview-copy removal in test 10 depends on children having stopped first, which the test does.
- `prompts/autoapp/README.md` was already modified before this prompt started. It is not part of this commit, and neither are the 12b–12d prompt files; the 12a prompt is, as prompt 11's was.
