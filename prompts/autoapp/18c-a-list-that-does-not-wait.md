# 18c — A model list that does not wait for its slowest provider

## Goal

18b made `ai.modelsList` ask every turned-on provider at once, and one that
fails now costs its own group. One that is *slow* still costs everybody:
the route is `await Promise.all(enabled.map(listOf))` (`create-ai.ts`, line
~378), each `listOf` runs under `PROVIDER_TIMEOUT_MS` — twenty seconds, the
same budget a connection test gets — and an operation answers once. A refused
connection fails in milliseconds (18b measured 65 ms). A provider that accepts
the connection and then says nothing — Ollama loading a large model, a hosted
gateway having a bad minute, an address that swallows packets — holds the
conversation picker, the task and tier selects and the Settings model select
on `Reading the models…` for the full twenty seconds, and then shows the list
the other providers had ready in a fraction of one.

It is also asked more often than it needs to be. The picker, the Backlog
panel and Settings each mount `useAiModels`, so opening the launcher asks every
provider three times for a list that changes a few times a year.

And one thing 18b left fragile: `tierProblem` in `IntentPanel.tsx` (line ~193)
tells "this provider could not be read" from "this provider's list was cut at
its share" by `!entry.message.includes('only the first')`. A sentence is not a
discriminant.

After this prompt a list is never older than a person expects and never slower
than five seconds: a provider that answered recently is not asked again; one
that does not answer in time gives the list it gave last, marked as such; and
the reason a provider appears under the list is a field.

## Read first

- `prompts/autoapp/00-common-rules.md`, the *Core changes allowed* row. Reports
  18a and 18b, whole — 18b's "Open questions" is where this comes from.
- `packages/broapp/src/ai/host/create-ai.ts`: `ai.modelsList`, `listOf`,
  `Listed`/`Unlisted`, `fairShares`, `MAX_LISTED_MODELS`, `PROVIDER_TIMEOUT_MS`
  and its two other users (`tryConnection`), `CreateAiOptions` and how
  `confirmTimeoutMs` is an option with a default — the two new durations follow
  it. `ai.settingsUpdate` and what it is given, for the invalidation below.
- `packages/broapp/src/ai/host/registry.ts`: `resolve`, `configOf`, `update`.
  Read only.
- `packages/broapp/src/ai/shared/contract.ts` (`unavailableProvider`, line ~44;
  `ai.modelsList`), `types.ts` (`UnavailableProvider`), `types.check.ts`.
- `packages/broapp/src/ai/react/use-ai-models.ts`: what `refresh` calls, what
  makes the effect refetch, the generation counter. `AiSettings.tsx` line ~347
  and the Refresh button beside the model select.
- `packages/broapp-ai-elements/src/ui/BroappModelPicker.tsx` line ~163: how an
  `unavailable` line is drawn.
- `packages/broapp-autoapp/src/launcher/ui/IntentPanel.tsx`: `tierProblem`,
  `usePlaces`. `intent/executor.ts` `notOffered`: it asks a provider for its
  list itself, under its own twenty seconds, before a task — read it, and leave
  it (see *Not in scope*).
- `tests/ai-host.test.ts`: 18b's list tests, the delayed fake provider used for
  the "asked at the same time" test, and how a test there controls time.

## Fixed decisions

| Decision | Value |
|---|---|
| Two durations, not one | Listing gets its own deadline, `modelListTimeoutMs`, default `5_000`. `PROVIDER_TIMEOUT_MS` stays twenty seconds for `ai.connectionTest` and `ai.providerTest`: a person who pressed Test is waiting for that one answer and a cold Ollama deserves the time. A second option, `modelListFreshMs`, default `30_000`. Both on `CreateAiOptions`, as `confirmTimeoutMs` is. |
| What is kept | In memory, per provider id, for the life of the process: the last list that provider gave, when (`listedAt`, epoch ms), and the address and key-presence it was read under. Never on disk: a list from last week is not worth a file, and a settings directory that holds only what the person typed stays that way. Never the key. |
| Fresh | A provider whose kept list is younger than `modelListFreshMs` and was read under the address and key-presence it has now is not asked: its kept list is its answer. This is what makes three panels mounting at once one request per provider. Requests already in flight for a provider are shared, not repeated. |
| Late or failed | A provider asked and not answered by the deadline, or answered with an `AdapterError`, gives its kept list if it has one read under the same address and key-presence, whatever its age, and an `unavailable` entry with `reason: 'stale'`, `listedAt`, and the message `<label> did not answer. These are the models it listed earlier.` — or, for an `AdapterError`, that error's own sentence followed by the same second sentence. With nothing kept: today's entry, `reason: 'failed'`. A late answer that arrives after the deadline is not thrown away: it replaces what is kept, so the next call is right. It must not raise an unhandled rejection when it fails late. |
| When the route throws | Only when there is nothing to show at all: no provider read and none with a kept list. One provider, down, with a kept list: the list, and the stale line. One provider, down, nothing kept: today's error, in today's words — 18b's single-provider promise holds for a first run. |
| What drops a kept list | `ai.settingsUpdate` that changes that provider's address, sets or clears its key, or turns it off. A provider that is off is never listed, from memory either: the 18a guard covers what is remembered about a provider as well as what is sent to it. Changing `remember`, the model, or another provider drops nothing. |
| `ai.modelsRefresh` | A new operation, input `void`, output as `ai.modelsList`. It ignores *fresh*: every enabled provider is asked, under the same deadline, with the same late-or-failed rule. `ai.modelsList`'s input stays `void`. `useAiModels.refresh()` calls the new route; the effect calls the old one. So mounting is cheap and the Refresh button means it. |
| The reason is a field | `unavailableProvider` gains two optional fields: `reason: s.enum(['failed', 'stale', 'truncated'])` and `listedAt: s.number()`. Every entry the host writes carries `reason`; `listedAt` only with `'stale'`. Optional, so a 0.4.7 host's answer still parses in a newer page. `fairShares`' line is `'truncated'`. `tierProblem` reads `reason` and the `includes('only the first')` goes; an entry with no `reason` is treated as `'failed'`. Contract, interface and `types.check.ts` together. |
| Stale is not down | A tier or task naming a provider whose list is `'stale'` gets no "cannot be reached" warning from `tierProblem` — the models are there to choose and the run will say what it finds. It gets the quieter words below. Only `'failed'` warns. |
| The words on screen | Wherever an `unavailable` line is drawn — the picker, Settings, the tier block — a `'stale'` entry reads as the host's message plus when: `… listed earlier, at <HH:MM>.` for today, `… on <date>` otherwise, formatted in the browser with `Intl.DateTimeFormat` and no new dependency. The group's heading in the picker and the `<optgroup>` label gain ` — listed earlier` after where it runs. Same muted style as today's line; no new colour, no icon alone. One shared function beside `describeModel` in `model-ref.ts` words it, so the three places cannot disagree. |
| Pending | `useAiModels` keeps the models it has while a refetch is pending instead of clearing to empty first, if it clears today — read and say. `Reading the models…` is for a list that has nothing to show. |
| Tests control time | The two durations are options and the clock the cache reads is injectable the way this file's other tests already do it; if nothing there injects a clock, add `now?: () => number` to `CreateAiOptions`, default `Date.now`, and say so. No test sleeps five seconds. |
| Not in scope | Streaming each provider's group as it arrives: a row in `docs/autoapp/backlog.md`, with what 18c leaves of the problem (a first-ever list still waits up to five seconds for a provider that stalls) and what a stream route would cost. The executor's `notOffered` sharing the kept list: a second row — a stale list must never refuse a task, so it may use a *fresh* one and nothing else; say what it would save per task. Ollama `:cloud` models reading `on this computer`, and `isLoopbackUrl` and IPv4-mapped addresses: both stay where report 18b left them. Persisting the list. A per-provider deadline in Settings. |

## Files in `packages/broapp` this prompt may change

`src/ai/host/create-ai.ts`, and one new file `src/ai/host/model-lists.ts` for
what is kept if that reads better than a closure — say which;
`src/ai/shared/contract.ts`, `types.ts`, `types.check.ts`, `model-ref.ts`,
`index.ts`; `src/ai/react/use-ai-models.ts`, `AiSettings.tsx`, `ai.css` only if
a class is needed. In `packages/broapp-ai-elements`:
`src/ui/BroappModelPicker.tsx`. `registry.ts`, `settings.ts`, `run.ts` and
`threads.ts` are not touched.

## Verification

```bash
bun run typecheck
bun test tests/ai-host.test.ts tests/ai-contract.test.ts tests/ai-providers.test.ts
bun test tests/ai-elements-view.test.tsx tests/autoapp-overview.test.ts tests/autoapp-views.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside 18b's:

1. Two providers, one answering at once and one never: the route answers at the
   list deadline, not the test deadline, with the first's models and the second
   `reason: 'failed'`. The same again after the second has once answered: its
   kept models, `reason: 'stale'`, `listedAt` the time it answered.
2. Fresh: two calls inside the window make one request per provider; a call
   after it makes a second. Three calls started together make one.
3. `ai.modelsRefresh` inside the window asks every provider.
4. A late answer: the provider answers after the deadline; the call that timed
   out got `'stale'` or `'failed'`; the next call, with no new request, has the
   late list and no entry. A late *failure* raises nothing unhandled.
5. Dropping: after `ai.settingsUpdate` changes a provider's address, a failing
   call gives `'failed'`, not the list of the old address. The same for a key
   set, a key cleared, and turning it off and on again. Changing the model
   drops nothing.
6. A provider turned off is absent from the answer although a list is kept for
   it, and its `fetch` count is unchanged.
7. One provider, kept list, now down: the route answers with the list and a
   `'stale'` line. One provider, nothing kept, down: it throws today's error.
8. `fairShares`' entry carries `reason: 'truncated'`; `tierProblem` warns for
   `'failed'`, not for `'stale'` or `'truncated'`, and treats a missing `reason`
   as `'failed'`. No source file under `packages/` holds `includes('only the
   first')`.
9. The stale words: today's time, another day's date, from one function; the
   picker's heading and the `<optgroup>` label both carry `listed earlier`.
10. `useAiModels`: a refetch that is pending still returns the previous models.

By hand, on a copy of the root, both schemes. A provider that accepts and never
answers is `nc -l 9999` with a custom server's address set to
`http://127.0.0.1:9999/v1`:

- With Ollama in use and that server turned on, open the launcher and time from
  the page appearing to the picker holding Ollama's models. Record it, and the
  line under the list.
- Open Settings and the Backlog panel. From the launcher's log or a counter in
  the fake, record how many list requests Ollama received for the three mounts.
- With Ollama listed once, quit it or point it at a closed port, press Refresh,
  and record the heading, the line and its time, in both schemes — one
  screenshot each in `reports/18c/`.
- Set the light tier to one of the stale group's models and record that the
  tier block shows no "cannot be reached" warning, and what it shows instead.

## Acceptance criteria

- No list waits longer than the list deadline, whatever any provider does.
- Opening the launcher asks each provider for its list once, not once per panel.
- A provider that is briefly unreachable keeps its models on screen, marked as
  listed earlier and when; a person can still choose one.
- Nothing remembered about a provider outlives its address, its key or its
  being turned on.
- The Refresh button always asks.
- The reason a provider is under the list is read from a field everywhere.
- A 0.4.7 application sees `ai.modelsList` answer in the same shape, sooner.
- `bun run check` green; `registry.ts` and `settings.ts` untouched.

## Report

`prompts/autoapp/reports/18c-a-list-that-does-not-wait.md`: where what is kept
lives and why; how a test controls the clock, and whether `now` was added; the
by-hand timings and the request count; whether `useAiModels` cleared its list
while pending and what it does now; and the two backlog rows, with the number
`notOffered` would save.

## Commit

```
Stop the model list waiting for its slowest provider

The list asked every turned-on provider at once and answered when the
last one did, under the twenty seconds a connection test gets, so one
provider that accepted a connection and said nothing held every picker
for all of it. Listing now has five seconds of its own. A provider that
answered in the last half minute is not asked again, so three panels
mounting is one request; one that does not answer in time gives the list
it gave last, marked as listed earlier and when; and what is remembered
is dropped with the address, the key or the switch it was read under.
Refresh always asks. Why a provider is under the list is now a field,
not a phrase in its message.
```

End the commit with the co-author trailer your session's rules give you.
