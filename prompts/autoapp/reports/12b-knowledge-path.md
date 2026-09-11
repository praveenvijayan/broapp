# 12b — The knowledge path

## What was built

- `knowledge/path.ts`: `orientation` (eight lines, ≤ 2,000 chars), `indexWorkspace` (five patterns, `Bun.Glob`), `taskEvidence` (grouped, bounded per kind, `declared`/`pattern`/`unknown`, ≤ 4,000 chars).
- `knowledge/serve.ts`: `createServe` — `search`/`resolve` as the launcher's context providers, `delivered` (servings + `search` event), `hints`. `knowledge/session.ts`: `openSession`, `<root>/launcher/session.json` via `writeAtomic`. `knowledge/scoring.ts`: `scoreBuild`, `scoreCheck`, `scoreRunEnd`, `problemSignature`. `knowledge/seed.ts`: six curated seeds, one `corpus_versions` row each.
- Tools: `source.search` (over `searchWorkspace` in `workspace.ts`, so `within`/`READABLE` stay private); `verification` on every edit result, `warning` from the third; `hints` on a failed build; `scoreBuild`/`scoreCheck`; every appId tool calls `session.select`. `CandidateStates` gains `noteEdit`/`resetEdits`.
- `tab.ts` passes the serving as `context`, calls `serve.delivered` then `recordContext`, and `scoreRunEnd`. `launcher.appSelect` (`write`); `App.tsx` calls it on a row click.
- Step 0: the sanitiser's hex rule is 40+; test 4 has the 32-character case.
- Instructions: the three sentences, 70 lines. Docs: `learning.md`, `security.md`, `backlog.md`.
- Tests: 12 new cases in `tests/autoapp-knowledge.test.ts` (the prompt's 11 plus a budget case).

## Deviations, and why

1. **`delivered` returns what the `contexts` row records** rather than updating it. The tab must call it before `recordContext`, and that row does not exist until then. Both are written from the same delivered documents, so they agree.
2. **`createServe` takes `apps: () => AppRow[]`.** The orientation needs `listApps`, which needs the supervisor and journal. **`Serve` declares `search`/`resolve` as required**, not optional.
3. **Hints are also filtered by stage.** A lesson whose `applies.stage` differs from the problem's is not offered. Without this, the MCP seed ("effect") hinted every contract failure.
4. **Six seeds, not seven.** The hunk-size seed is step 3 of the instructions, and the prompt's own rule excludes it.
5. **One lessons document, `lessons:<appId>`**, one bullet per lesson. A lesson is `included = 1` only when its whole line arrived. The budget test shows both cases in one turn: seed 1 whole (`1`, then `none`), seed 4 cut mid-line (`0`, never scored).
6. **The hints sentence is in step 4 (Build), not step 3.** Step 3 is editing, and 11b restored its 08c wording word for word. To stay at 70 lines, the dependency bullet lost its second sentence (the fact is now seed 3), and two paragraphs were rewrapped to 84 columns.
7. **The existing 12a tab test changed one assertion:** `included` was `[]` ("nothing serves yet"). It now checks that the first two refs are `digest:items`, `evidence:items`. This is the behaviour 12b adds.
8. `scoreBuild` takes an optional `log` for the `blocked` event. In `scoreCheck`, a failure with a different signature is `inconclusive`. The warning spells small numbers ("three edits are unverified…").
9. **The orientation says `Last build: none`** when nothing was built. When the candidate *is* the current release, it says `Next: nothing to verify`. **Evidence reads the candidate's spec first**, then the current one: a route added in the candidate is the one being worked on.
10. The commit trailer names Claude Opus 5, per this session's attribution rule.

## Sizes (08c request, fresh builds)

| | orientation | evidence | symbols indexed |
|---|---|---|---|
| starter | 173 | 679 | 29 |
| Notes | 173 | 1,777 | 52 |

**What the Notes index misses, and why.** It misses non-exported functions: `noteId`, `render` (`ai.ts`), `toNote`, `currentVersion`, and `db.ts`'s private `migrate`, which is where a tags column's SQL goes. It misses `export interface Note`/`Store` and `export type StoreState`/`AppContract`, and module constants such as `SNIPPET_CHARS` and `HELP`. All seven `app.operation` routes are found (`operations.ts`). None of the misses is a false claim; the engineer reaches them with `source.read` or `source.search`. `notes` as a token matches every route (it is the route group), so Notes' evidence lists all seven.

## The rerun of the 08c request

Same setup as 08c: local Ollama, `qwen3.8:27b-mlx`, nothing left the machine, no key entered. Fresh root (`tests/.autoapp-run/demo-12b`), Notes imported, the 07/08c request sent once, verbatim, with nothing selected. It named `notes`, and the turn got `digest:notes`, `evidence:notes` and `lessons:notes` (seeds 1, 6, 4).

| # | Think (last read → landed) | Bytes | Hunks | Result | `matchedBy` |
|---|---|---|---|---|---|
| 1 | ≤ 4m30s | 1,111 | 2 | **succeeded** (`autoapp.json`: migration, acceptance) | `['indent','indent']` |
| 2 | ≤ 2m11s | 1,590 | 3 | **succeeded** (`contract.ts`: tags, archived, `archiveMany`) | `['exact','indent','indent']` |

Both think times include up to a few minutes before I saw the card.

- **Calls before the first `source.edit`: 13** (08c: 15). They were `spec.read`, `source.list`, 6 × `source.read`, `source.search`, 4 × `source.read`. **No `apps.list`**: the orientation named the application, where 08c's first call was `apps.list`. The model used `source.search` once, unprompted. First edit landed 6m34s after sending, including approval.
- **`candidate.build` was not reached.** The turn ended `succeeded` at 9m02s, right after edit 2, with no closing text. It made 16 calls in **exactly 8 model steps**, and the AI layer's `DEFAULT_MAX_STEPS` is 8; the launcher does not override it. So the stop was the step cap, not the model choosing to plan. 08c's turn (18 calls, ended right after an edit) fits the same cap; recorded in the backlog row for 12d. Edit 2's `verification` said `editsSinceBuild: 2, next: candidate.build`; the warning needs three. Tokens: 104,128 in, 8,058 out.
- It stated a plan it could verify and flagged the workflow half as unverifiable ("no multi-row selection primitive and no saved-workflow primitive"). The first half is true. Saved workflows do exist (prompt 06), but in the runtime, not in the workspace, so nothing served says so. That is a candidate fact for 12c.
- Servings: all three lessons `included = 1`, closed `none` at run end. No case was opened, because nothing was built.

## Commands run

```
bun run typecheck                                   exit 0
bun test tests/autoapp-knowledge.test.ts            25 pass, 0 fail
bun test tests/autoapp-{knowledge,engineer,gate}.test.ts tests/ai-chat.test.ts   114 pass, 0 fail
bun test tests                                      623 pass, 0 fail (39 files)
bun install && bun run check                        exit 0
bun run --cwd packages/broapp-autoapp build:launcher   dist/broapp-autoapp 75.5 MB
```

## Acceptance criteria

- **A turn's system prompt carries the orientation and task evidence for the application the message is about, and the engineer is told to read them first** — pass (tests 4, 5, 11; and live: the rerun's `contexts` row names `digest:notes`, `evidence:notes`, `lessons:notes`).
- **Every evidence entry is a `file:line` marked `declared` or `pattern`, or an honest `unknown` with `source.search`** — pass (tests 2, 3).
- **A build failure returns matching curated facts as hints, each recorded as a serving** — pass (test 6).
- **Every serving records whether it reached the model; every later build or check closes it with one of six outcomes by the stage-aware rules; nothing promotes** — pass (tests 5, budget, 7). No code path changes a lesson's `status`.
- **`bun run check` green; every command exits 0** — pass.

## Open questions

- Matching is FTS `OR` over the request's words, so weak matches are served. In the rerun, "list" matched the migration seed ("The list is history"). A shared route group ("notes") matches every route. 12d's measurement should say whether this costs anything.
- `resolve` is not told its run, so a ref is tied to the turn that most recently searched for it. Two concurrent turns on one application could swap evidence between their `search` and `resolve` calls. That window is one microtask.
- `tests/autoapp-knowledge.test.ts` is still not in CI's per-platform Autoapp list (12a's open question).
