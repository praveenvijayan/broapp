# 13a — The intent store, the plan format and the Backlog panel

## What was built

- `src/intent/` (`broapp-autoapp/intent`, new `package.json` export): `types.ts` (statuses, `TASK_MOVES`, `LABELS`, records, `TaskInput`), `plan.ts` (`validateTask`, `validateGraph`, `renderPlan`, slug helpers), `tier.ts` (`tierOf`), `store.ts` (`openIntents`), `models.ts` (`readTierModels`, `writeTierModels`, `modelFor`).
- `intents.sqlite` beside `knowledge.sqlite`: one migration with `intents`, `tasks`, `task_events`. It uses the pragmas knowledge uses. `CHECK` constraints on both status columns keep `blocked` out of the database. Triggers make `task_events` append-only.
- Eight routes: `launcher.intentsList|intentGet|intentPlan|intentModelsGet` (read) and `launcher.intentTaskModel|intentTaskRemove|intentWithdraw|intentModelsSet` (write). Without a store every one answers `unavailable` with "This launcher keeps no backlog."
- `ui/IntentPanel.tsx`: a **Backlog** rail button (`ListChecks`, confirmed in `lucide-react.d.ts`), an overlay, Escape; styles are `launcher__intent-*` on top of the `launcher__k-*` chips.
- Docs: `docs/autoapp/intents.md` (new, also on the site); links from the Autoapp README and from design.md's closing list; the design.md paragraph; three backlog.md rows.
- `tests/autoapp-intent.test.ts`: 25 tests for the prompt's cases 1–11.

## What knowledge and intent each needed

| Place | Knowledge (12a–12k) | Intent (13a) |
|---|---|---|
| `createLauncherTab` | `knowledge: { store, log, evidence }`. Builds serve, distiller, `reviewFlags`, `onContext`, `onRunEnd`, and the tools' `knowledge` option. Passes `log` and `knowledge` on to the app | `intents?: IntentStore`, passed on to `createLauncherApp`. No hook yet (13b adds the engineer's) |
| `main.ts` | `openKnowledge` when `longRunning`; `createEventLog` becomes `Recording`, which feeds the supervisor, recover, control and keepalive. Closes the distiller, then knowledge, at shutdown and in `finally` | `openIntents` when `longRunning`, carried on `Recording`. `close()` at shutdown and in `finally`, before knowledge |
| Contract | 6 reads, 2 writes (plus `eventsList`), `STAGE_NAMES` copied | 4 reads, 4 writes, `INTENT_STATUS_NAMES`/`TASK_STATUS_NAMES` copied. A test holds both copies equal |
| Rail | `BookOpen`, `KnowledgePanel`, Escape except in a form | `ListChecks`, `IntentPanel`, Escape except in a select |
| Store and migrations | `knowledge.sqlite`, 2 migrations | `intents.sqlite`, 1 migration, its own `user_version`; plus `intent-models.json` |
| Engineer | tools, context provider, run hooks | none (and a test says no tool names it) |

Both needed the same four touches: an optional store in `createLauncherTab`, an opener and a closer in `main.ts`, a block of contract routes with a status list copied for the page, and a rail button with an overlay. Only knowledge reaches the AI layer so far. The comparison is fairer after 13b gives intent its engineer hook.

## Deviations, and why

1. **`tasks.app_id` column**, not in the table list. "Slug UNIQUE per app" needs the application on the row, because a unique index can only name its own table's columns.
2. **Priority is `high`, `normal`, `low`.** The prompt says "one of three" and names only `high`; `normal` matches `risk`.
3. **The host numbers criteria `c1…`**, and `TaskInput.criteria` is `{ text, failure }`. A criterion may carry `passed` for 13c to set; `renderPlan` draws `[x]` from it.
4. **`TaskInput.words` is optional.** When it is absent, the words come from the title (first six). `validateTask(input, siblings, slug?)` takes the task's own slug so "a task may not block itself" can be checked.
5. **Withdraw goes through `moveTask`.** The move table has no `failed→removed` or `interrupted→removed`, so a withdrawn intent's failed or interrupted task moves to `in-queue` and then to `removed`, with two events and both notes. Withdraw is refused while a task is `in-progress`, or while a live task in another intent depends on one of its tasks.
6. **Writes are refused off channel `user`** (`rejected`). No engineer tool names them. This makes "channel `user`" a rule the route enforces, not only a description. No test drives another channel, because the tab exposes no `invoke`.
7. **The task model select's first option** reads "Settings model" when the tier maps to nothing, and "`<tier>` tier: `<id>`" when it maps to a model. With a tier model set, "Settings model" would be untrue.
8. **The site gained `autoapp-intents.html`** and the landing page's Read next gained a row. Precedent is 12h. So `tests/site.test.ts`'s reading-order assertion changed from seven pages to eight. That is the one existing test changed.
9. `IntentStore.dataDir` is where `intent-models.json` is read and written, so the app needs no second option. `IntentPanel` takes a `snapshot` prop so a test can draw rows without a connection, as `KnowledgePanel` takes `error`.
10. The commit trailer names Claude Opus 5, per this session's attribution rule, not Fable 5.1.

## Decisions I made

- The model list's failure sentence is under each select, as the table says. There is one sentence per row.
- `runOrder` is Kahn's algorithm over blockers inside the intent. A blocker in another intent does not affect order; it makes the task `blocked`, and the status says so. A cycle (which cannot be stored) would go last rather than vanish.
- Section 2b: this panel adds no renderer kind and no vendored component, so the gallery, the harness, `/impeccable` and `design-detect` do not apply (as in 12k). What does apply: every control is a native button, select or `details`; there are focus-visible rings from `--launcher-accent`; every select has an `aria-label`; `aria-expanded` is set on rows; there is a sentence for loading, empty, error and no-application states; disabled selects look disabled; colours come only from the `--launcher-*` pairs.

## Page size

`launcher-page.html` goes from 1,328,583 bytes (HEAD, built by stashing) to 1,346,174: **+17,591 bytes (+1.3%)**.

## The manual run

Compiled launcher, `open --no-open --no-restore` over a scratch root. One intent with three tasks was seeded through `openIntents`, and the page was driven in the in-app browser. Seen: the intent row with "1 proposed · 1 in-queue · 1 blocked"; the request, and the analysis without its empty Conflicts block; tasks in run order `0001-add-tags` (deep, from the migration label), `0002-filter-by-tag` (high, "blocked by 0001-add-tags"), `0003-empty-sentence`; the plan in a `<pre>`, byte for byte the format. Remove on 0001, confirmed, answered "0001-add-tags cannot be removed: 0002-filter-by-tag depends on it." One fix came from this run: a slug was cut with an ellipsis on a crowded row, and it no longer shrinks.

**Seen, not caused here:** after Ctrl+C, `intents.sqlite-wal` stayed, and so did `knowledge.sqlite-wal` and `runs.sqlite-wal`. The close-and-checkpoint on shutdown does not appear to run on SIGINT for any store.

## Commands run

```
bun run typecheck                                        exit 0
bun test tests/autoapp-intent.test.ts                    25 pass, 0 fail
bun test tests/site.test.ts                              10 pass, 0 fail
bun test tests                                           832 pass, 0 fail (50 files)
bun run --cwd packages/broapp-autoapp build:page         launcher-page.html 1314.6 KiB
bun run --cwd packages/broapp-autoapp build:launcher     dist/broapp-autoapp 77.1 MB
bun run scripts/autoapp-smoke.ts                         autoapp smoke: every step passed
bun install && bun run check                             exit 0; 832 pass, 0 fail
git diff --stat tests/ai-chat.test.ts                    (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| Backlog opens from the rail; intents, analysis, tasks in run order with slug, tier and reasons, model, status | pass (test 11; manual run) |
| Change a task's model, remove a task nothing depends on, withdraw, set the three tier models; each refused with a sentence when the table says so | pass (test 10; manual refusal) |
| A plan renders in exactly the appendix's format | pass (test 3, byte for byte) |
| A task's tier comes from the host's rule, with readable reasons | pass (test 4; the store assigns it) |
| `tests/ai-chat.test.ts` unchanged; `bun run check` green | pass |

## Open questions

- Should `moveTask` also stamp `started_at`/`ended_at` and count `attempts`? It changes status and history only; 13c decides.
- The SIGINT observation above affects every store the launcher keeps.
