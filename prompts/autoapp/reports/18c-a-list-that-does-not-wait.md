# 18c — A model list that does not wait for its slowest provider

## What was built

- **`src/ai/host/model-lists.ts`, new** (a file, not a closure: `create-ai.ts` is already 600 lines, and what is kept has its own rules — fresh, shared in-flight, late, generation). `createModelLists({ deadlineMs, freshMs, requestTimeoutMs, now })` → `list(adapter, config, { fresh })` and `drop(id)`. Per provider, in memory only: the last list, `listedAt`, and the address and key presence it was read under. Never the key, never on disk.
  - A kept list younger than `freshMs`, read under the same address and key presence, is the answer with `fresh`. A request already in flight for that provider (same generation, same reach) is shared.
  - The route waits `deadlineMs`. The request itself runs on under `PROVIDER_TIMEOUT_MS` (20 s); a late answer is stored, and a late failure is caught there, so nothing is unhandled.
  - Late, or an `AdapterError`: the kept list under the same reach, whatever its age, as `stale` with `<label> did not answer. These are the models it listed earlier.` (or the error's sentence plus the second). Nothing kept: `failed`.
  - `drop` deletes the list, forgets the in-flight request and bumps a generation, so an answer already on its way under the old address cannot land.
- **`create-ai.ts`**: `modelListTimeoutMs` (5 000), `modelListFreshMs` (30 000) and `now` on `CreateAiOptions`, beside `confirmTimeoutMs`. `PROVIDER_TIMEOUT_MS` stays 20 s for both tests. `listModels({ fresh })` behind `ai.modelsList` (fresh) and the new `ai.modelsRefresh` (not fresh). It throws only when no provider has anything to show. `ai.settingsUpdate` reads settings before and after, and drops per `listsToDrop`: address changed, key presence changed, a key sent at all for that target (set or cleared), or turned off. `remember`, a model, or the provider in use drop nothing. Off providers are filtered before anything is read, from memory too.
- **Contract**: `unavailableProvider` gains optional `reason` (`failed`/`stale`/`truncated`) and `listedAt`; `ai.modelsRefresh` shares `modelsListOutput`. `types.ts` (`UnavailableProvider`, `UnavailableReason`), `types.check.ts` (refresh output equals list output). Every host entry now carries `reason`; `listedAt` only with `stale`.
- **`model-ref.ts`**: `unavailableReason` (missing = `failed`), `LISTED_EARLIER`, `unavailableLine(entry, { now, locale, timeZone })`, the one function the picker, Settings and the tier block word a line with: `…listed earlier, at 21:12.` today, `…, on 19 Sept 2026.` another day, `Intl.DateTimeFormat`, no dependency.
- **Browser**: `useAiModels` — the effect calls `ai.modelsList`, `refresh()` calls `ai.modelsRefresh`; state is now `modelsReducer`. `AiSettings` draws a stale line as a muted hint (`role="status"`), keeps the model select usable while a refetch is pending if it has models. `BroappModelPicker`: `groupHeading(provider, providers, stale)` (exported) adds ` — listed earlier`; lines through `unavailableLine`. `IntentPanel`: `tierProblem` reads `reason` (only `failed` warns), new `tierNote` draws the stale line quietly above the tier rows, and the `<optgroup>` label gains ` — listed earlier`. `includes('only the first')` is gone; a test scans `packages/*/src` for it.
- **Docs**: `docs/ai.md` route table (both routes); two `backlog.md` rows (below).

## How a test controls the clock

Nothing in `tests/ai-host.test.ts` injected a clock, so **`now?: () => number` was added** to `CreateAiOptions` (default `Date.now`). Tests pass `modelListTimeoutMs: 120` and a `{ now }` object they move by hand across the 30 s window; a `controlled()` adapter answers, hangs or fails on command and records each request's address. No test sleeps longer than the 120 ms deadline.

## `useAiModels` while pending

It did **not** clear on a refetch: it set `pending` and kept `models`; only a failure emptied them. That is kept, and now stated as `modelsReducer` (`reading` keeps the list, `failed` clears). What did hide a shown list was Settings: its model select was `disabled` and read `Loading…` whenever `pending`, list or not. Now only when it has nothing to show. The picker already said `Reading the models…` only for an empty list.

## By hand

Copy of the real root under the scratchpad: `reading-list`'s releases, `current`, `grants.json`; `intents`, `knowledge`, `journal` by `VACUUM INTO` read-only; `intent-models.json`; a `settings.json` of my own (Ollama in use, `openai-compatible` on at `http://127.0.0.1:9999/v1`), **no key**. Compiled launcher from this tree, `open --no-open --no-restore`. The person's own launcher kept serving the real root, untouched. Nothing left the machine.

- **Silent server.** `nc -l 9999` closed each connection at once (its stdin was at EOF: curl exit 52), so a Python listener that accepts and holds every connection stood in (curl exit 28 after 3 s).
- **Time to a usable list, first open** (nothing kept for the silent server): 5.2 s from navigation to Ollama's models choosable in Settings' select (`railToModelsMs 5009`, measured in-page with a `MutationObserver`). That is the deadline, as designed: a first-ever list still waits for it. The picker's line: **"OpenAI-compatible server did not answer."**
- **Requests for three mounts** (page with its hidden picker, Settings, Backlog, inside 30 s): Ollama's own log went 65 → **66**, the silent server accepted **1**. My first attempt opened Backlog 33 s after load and cost a second request each: past the window, correctly.
- **Stale.** Ollama cannot be quit here (18a's attempt: "User canceled"), and pointing it at a closed port changes its address, which drops its list by design. So the custom server was pointed at a relay on `127.0.0.1:9998` that forwards to Ollama, listed once through it, then the relay was told to hold every request. After the fresh window: heading **"OpenAI-compatible server — on this computer — listed earlier"**, line **"OpenAI-compatible server did not answer. These are the models it listed earlier, at 21:12."**, visible 5.36 s after the picker opened, models choosable. `18c/picker-dark.png`, `18c/picker-light.png` (Playwright, 1000×700).
- **Tier.** Light set to `openai-compatible:qwen3.8:27b-mlx` from the Backlog select (the file then held it qualified). No "cannot be reached"; above the rows the same muted line, and the optgroup label ends `— listed earlier`. `18c/tier-dark.png`, `18c/tier-light.png`.

## Backlog rows

- **A list that streams each provider's group as it arrives.** What 18c leaves: a first-ever list waits up to five seconds for a provider that stalls. The cost: a stream route beside the operation (a 0.4 page calls the operation), a hook merging groups in build order, and sharing it across three panels.
- **`notOffered` sharing the kept list.** It runs before **every builder turn** (up to `TASK_MAX_TURNS`, 4, per task), under its own 20 s. It may only use a **fresh** list (a stale one must never refuse a task). So it would save at most one list request per turn, and only when a panel read that provider in the last 30 s. Turns are minutes apart, so in practice that is the first turn after Run. Per saved request: one round trip, about 15–20 ms against local Ollama by its log, and up to 20 s before a turn starts when the provider stalls.

## Deviations, and decisions I made

1. **A deadline with nothing kept says `<label> did not answer.`** Today's words for a stall came from the adapter after twenty seconds. At five the adapter has said nothing, so the host words it. One provider that is *down* (an `AdapterError`) and has nothing kept still throws its own sentence, as before (test 7).
2. **`unavailable` is in the build's order per provider** (failed, stale, truncated lines where that provider's group sits), not all failures first. A single entry reads the same.
3. **`ai.modelsRefresh` shares a request already in flight** rather than sending a second one; that request is itself a fresh ask.
4. **Test 10 is on `modelsReducer`.** The repository has no DOM renderer (12j); the hook's state became a pure reducer so the pending rule has a test.
5. **By-hand stand-ins**: a Python listener for `nc`, and a relay in place of quitting Ollama (above). Screenshots by Playwright, the root's pinned devDependency; the script was temporary and removed.
6. **Existing assertions changed shape, not strength**: three 18b `unavailable` `toEqual`s gained `reason`; `ai-contract` lists `ai.modelsRefresh`.
7. **Seen, not changed**: `renderToString` of `TierModelsBlock` logs React's "unique key" warning for `ModelSelect`. It printed three times before this change as well (checked by stashing).
8. The commit includes the 18c prompt file and its `README.md` row, as 12a included its prompt. The trailer names Claude Opus 5, per this session's rule.

## Commands

```
bun run typecheck                                                        exit 0
bun test tests/ai-host.test.ts tests/ai-contract.test.ts tests/ai-providers.test.ts   85 pass, 0 fail
bun test tests/ai-elements-view.test.tsx tests/autoapp-overview.test.ts tests/autoapp-views.test.ts tests/autoapp-intent.test.ts   151 pass, 0 fail
mutations: fresh check off → tests 2, 4 fail; settingsUpdate drops off → test 5 fails; both restored
bun install && bun run check                                             exit 0, 1119 pass, 0 fail (55 files)
bun run --cwd packages/broapp-autoapp build:launcher                     dist/broapp-autoapp 78.2 MB
bun run scripts/autoapp-smoke.ts                                         every step passed
git diff --stat packages/broapp/src/ai/host/registry.ts settings.ts run.ts threads.ts   (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| No list waits longer than the list deadline | pass (test 1; by hand 5.0 s against a provider that never answers) |
| Opening the launcher asks each provider once, not once per panel | pass (test 2; by hand 1 request each for three mounts) |
| A briefly unreachable provider keeps its models, marked listed earlier and when, choosable | pass (tests 1, 7, 9; by hand, both schemes) |
| Nothing remembered outlives its address, key or switch | pass (tests 5, 6) |
| Refresh always asks | pass (test 3) |
| The reason is a field everywhere | pass (test 8; the source scan) |
| A 0.4.7 application sees the same shape, sooner | pass (fields optional; existing tests unchanged in meaning) |
| `check` green; `registry.ts`, `settings.ts` untouched | pass |
