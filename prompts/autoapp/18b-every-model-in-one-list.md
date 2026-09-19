# 18b — Every model in one list, and where each one runs

## Goal

18a made a model reference reach any provider that is turned on, and kept
every provider's address, model and key. None of it can be used without editing
a file: `ai.modelsList` asks the active provider only, `AiSettings` draws one
provider's form, `ai.connectionTest` tries one, and the three places a person
chooses a model — the conversation's picker, a task's model and the three
tiers — offer the active provider's models and write a bare id.

18a also retired a rule with a reason. `Thread`'s comment said the provider is
never part of a conversation because changing it changes which key is used and
*whether anything leaves the computer*. A person can now put one conversation
on a model on their desk and the next on a hosted one. The rule is gone; the
reason is not. So wherever a model is chosen or named, it says whether it runs
on this computer.

After this prompt Settings lists every provider in the build, each with its own
address, key, test and on/off; one list holds the models of every provider that
is on, grouped by provider and marked local or not; every picker offers that
list and writes a qualified reference; and one provider being unreachable costs
its own group, not the list.

## Read first

- `prompts/autoapp/00-common-rules.md`, the rows on core changes and on what
  the launcher's UI may import. Report 18a, whole — the shapes of
  `AiSettings.providers` and the `settingsUpdate` inputs are as *built*, and
  where they differ from prompt 18a the report wins. Reports 13c (tiers),
  17b (the launcher's variables, both schemes), and
  `prompts/ai-elements` report 04b for how the model picker was built.
- `packages/broapp/src/ai/host/create-ai.ts`: `ai.modelsList`,
  `ai.connectionTest`, `ai.providersList`, `requireConfig`,
  `PROVIDER_TIMEOUT_MS`; `registry.ts` as 18a left it (`configOf`, `configFor`).
- `packages/broapp/src/ai/shared/contract.ts`, `types.ts`, `types.check.ts`,
  `model-ref.ts`.
- `packages/broapp/src/ai/react/AiSettings.tsx`, `use-ai-settings.ts`,
  `use-ai-models.ts` (what makes it refetch, and the generation counter),
  `provider.tsx`, `ai.css`.
- `packages/broapp-ai-elements/src/ui/BroappModelPicker.tsx` and
  `use-broapp-chat.ts`: how the pinned model is found in the list, the
  "follows Settings" row, the `Mark`, and what is shown for a model the
  provider no longer offers.
- `packages/broapp-autoapp/src/launcher/ui/IntentPanel.tsx`: `ModelSelect`,
  `modelName`, `TierModelsBlock`, the task row's override;
  `launcher/app.ts` line ~603 and the `launcher.intentModels*` routes.
- `tests/ai-host.test.ts`, `tests/ai-elements-view.test.tsx`,
  `tests/autoapp-views.test.ts`, `tests/ai-elements-css.test.ts`: how a view is
  tested here, and what the CSS test forbids.
- `docs/ai.md`, `docs/security.md`, `docs/troubleshooting.md`: every sentence
  that says *the* provider.

## Fixed decisions

| Decision | Value |
|---|---|
| `ai.modelsList` | Input unchanged. Asks every **enabled** provider at once, each under its own `PROVIDER_TIMEOUT_MS`, through `configOf`. Output: `models`, every provider's list, in the build's provider order and each provider's own order within; plus one new field `unavailable: Array<{ provider: string; message: string }>` (max 50), the providers that could not be read, with the `AdapterError`'s own sentence. A provider whose `needs` are not met — no key where one is required, no address — is not asked and is listed in `unavailable` with the sentence `resolve` would give. The route throws, with today's error, only when no enabled provider could be read; an application with one provider sees exactly what it saw. `BroappModel` is unchanged: `provider` is already on it, and `modelId` stays the provider's own id. The 1000 bound is on the whole; when the lists together exceed it, each provider keeps a fair share and `unavailable` gains `<label>: only the first <n> models are shown.` |
| `ai.providerTest` | A new operation, input `{ provider: string (max 64) }`, output as `ai.connectionTest`. It tests that provider's stored address and key whether or not it is enabled — a person tests before they turn something on. `ai.connectionTest` is unchanged and still tests the active one. Both share one function. |
| `useAiModels` | Same return type plus `unavailable`. Refetches when the set of enabled providers changes, or any enabled provider's address or whether it has a key — read from `settings.providers`. Still not on a change of model. The generation counter stays. |
| `useAiSettings` | `update` already takes the contract's input, so `target` and `enabled` arrive by type. `test(provider?)` calls `ai.providerTest` when given one. Nothing else. |
| The reference a picker writes | Always `formatModelRef(model.provider, model.modelId)`, for the active provider too. A bare id means "the active provider" and silently changes meaning when the person changes provider; a picker never writes one again. Bare ids already stored keep working (18a) and are *shown* as the active provider's model. The Settings model itself stays bare: it lives inside its provider's entry. |
| Matching a stored reference to the list | One shared function beside `model-ref.ts`: `findModel(ref, models, activeProvider)` — parse, then match `provider` and `modelId`; unqualified matches the active provider. Used by the conversation picker, `modelName` and the tier block, so the three cannot disagree. A reference that matches nothing is shown as its own text with `not offered` after it, as today. A reference whose provider is off is shown with `<label> is off`. |
| Local or not | `ProviderInfo.local` from `ai.providersList` is the only source. Wherever a model is offered or named — each group heading in a picker, the conversation's header, a tier row, a task row's model — the words are `on this computer` or `sent to <label>`. Words, not colour alone, and not an icon alone. In a `<select>`, the `<optgroup>` label carries them: `Ollama (local) — on this computer`. |
| The conversation picker | Groups by provider in the build's order; the group heading carries the words above. The "follows Settings" row stays first and names the Settings model and where it runs. `unavailable` is drawn under the list, one line each, in the muted text style already there. Search matches provider label too (it already matches `model.provider`). |
| When a conversation moves off the computer | Choosing a model that is not local, in a conversation whose current model is local, shows one line under the picker until the next message is sent: `From the next message, this conversation is sent to <label>.` No dialog, no confirmation: the person chose it, and the line is there so the choice is not silent. The other direction shows `From the next message, this conversation stays on this computer.` The messages already sent are not mentioned as recalled; nothing can recall them. |
| `AiSettings` | One panel, in this order. **In use**: the provider select that exists today, meaning "the provider a conversation and a task run on when nothing says otherwise", its model select, and its disclosure sentence. **Providers**: one `<details>` per adapter in the build, the active one open. Each holds what today's form holds for one provider — address when `needs.baseUrl` is not `none`, key when `needs.apiKey` is not `none`, the key hint and Remove, Test — plus a checkbox `Offer this provider's models`, checked and disabled for the provider in use with the words `In use`. Each summary line reads `<label> — on this computer` or `<label> — sent to <address's host>`, then `on`, `off` or what is missing (`needs a key`). **Remember key on this computer** moves below the list and says it applies to every key. Every control writes with `target`. No new dependency, no new colour: `ai.css` only, with the variables it has. |
| The disclosure sentence | Under *In use*, today's sentence. Under it, when any other provider is on and not local: `Tasks and conversations that choose a model from <labels> are sent there instead.` When every enabled provider is local, the local sentence covers all and says so. |
| The launcher's pickers | `ModelSelect` groups with `<optgroup>` by the same order and words, writes qualified references, and keeps its empty choice and what `modelName` says it runs on. `TierModelsBlock` shows, beside each tier, where it runs. The task row shows the same beside a task's model. When the tiers between them name a provider that is off or unreachable, the block says which tier and why, above the rows — a run that will fail at its first light task should say so before it starts. |
| The Overview | 17b's *Running now* names the model a task is on. It gains the same words, from the same function. Nothing else on that screen changes. |
| `examples/` and `templates/` | Any that draw `AiSettings` or the picker get the new panel by import. Check each builds; change none. |
| Docs | `docs/ai.md`: more than one provider, the reference convention, `unavailable`, `ai.providerTest`, that nothing falls back. `docs/security.md`: what *enabled* guards, that a reference can move a conversation off the computer and where the person is told, and that keys are per provider under one `remember`. `docs/troubleshooting.md`: "a provider's models are missing from the list". The `broapp` skill under `skills/` if it describes the settings panel or `ai.modelsList` — read and say. |
| Not in scope | Reordering or hiding individual models. Favourites. A per-provider `remember`. Prices per provider in the prices editor beyond what 18a's lookup already gives. Choosing a provider automatically. Two connections of one adapter. A release: that is its own procedure, after both reports are read. |

## Files in `packages/broapp` this prompt may change

`src/ai/host/create-ai.ts`, `src/ai/shared/contract.ts`, `src/ai/shared/types.ts`,
`src/ai/shared/types.check.ts`, `src/ai/shared/model-ref.ts` (for `findModel`)
and `src/ai/shared/index.ts`; `src/ai/react/AiSettings.tsx`,
`src/ai/react/use-ai-models.ts`, `src/ai/react/use-ai-settings.ts`,
`src/ai/react/ai.css`, and `src/ai/react/AiChat.tsx` only if it names the model
or the provider on screen — read and say. In `packages/broapp-ai-elements`:
`src/ui/BroappModelPicker.tsx` and what it needs from `use-broapp-chat.ts`.
`registry.ts`, `settings.ts`, `run.ts` and `threads.ts` are not touched; if one
seems to need it, stop and say why in the report instead.

## Verification

```bash
bun run typecheck
bun test tests/ai-host.test.ts tests/ai-contract.test.ts tests/ai-providers.test.ts
bun test tests/ai-elements-view.test.tsx tests/ai-elements-css.test.ts tests/ai-elements-transport.test.ts
bun test tests/autoapp-views.test.ts tests/autoapp-overview.test.ts tests/autoapp-intent-tools.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run check
```

New tests, beside the ones they extend:

1. `ai.modelsList`, two fake providers on: both lists, in build order. One of
   them failing: the other's models, and the failed one in `unavailable` with
   its sentence. Both failing: the route throws as it does today. One on and
   one off: the off one's `fetch` is never called. A required key missing: not
   asked, and listed with `resolve`'s sentence.
2. The two providers are asked at the same time: with each delayed by the same
   interval, the route answers in about one interval, not two.
3. `ai.providerTest` on a provider that is off tests it and leaves it off;
   on an unknown id is `invalidInput`; `ai.connectionTest` is unchanged.
4. `findModel`: a qualified reference; a bare one against the active provider;
   a bare one after the active provider changed (matches the new active
   provider or nothing — never the old one by accident); a provider that is off.
5. `AiSettings`: one `<details>` per adapter; typing a key in a provider that is
   not in use sends `target` and leaves `provider` alone; the in-use provider's
   checkbox is disabled; each summary holds `on this computer` or `sent to`;
   the second disclosure sentence appears only when a second, non-local
   provider is on.
6. The conversation picker: two groups with their headings; choosing a model
   calls `onChange` with a qualified reference; a stored bare reference shows
   as the active provider's model; going from a local model to a hosted one
   draws the one line, and sending a message removes it.
7. `ModelSelect` and `TierModelsBlock`: `<optgroup>` labels carry the words; the
   value written is qualified; a tier naming a provider that is off draws the
   warning above the rows, naming the tier.
8. No test or source file under `src/ai/react` or `broapp-ai-elements/src`
   imports from `ai/host` — the existing boundary test, still green.

By hand, in both colour schemes, on a copy of the root with Ollama running and
the hosted provider you use:

- Settings: turn Ollama on from the panel, test it, and record the summary
  lines of every provider. Quit Ollama, press Refresh, and record what the
  model list shows and how long it took.
- The conversation picker: both groups; pin a conversation to an Ollama model,
  send a message, then pin it to the hosted one and record the line shown.
- Tiers: light on an Ollama model, deep on the hosted one, standard empty. Run
  a backlog with at least one task of each tier. Record, from the Overview and
  from the usage rows, where each ran, and the spend footer — a local model has
  no price and must show none, not zero dollars.
- Turn Ollama off in Settings with the light tier still naming it, and record
  the warning in the tier block.

Screenshots of Settings and the picker, light and dark, in the report's folder.

## Acceptance criteria

- A person with Ollama and a hosted provider sets both up, and puts light work
  on one and deep work on the other, without leaving the launcher or editing a
  file.
- No place where a model is chosen or named leaves out where it runs.
- One unreachable provider never empties the list or blocks Settings.
- No picker writes a bare id; every bare id already stored still works and is
  shown for what it is.
- A provider that is off is never contacted by the list, only by its own Test
  button.
- An application with one provider sees the panel, the list and the routes
  behave as they did, apart from the panel's layout.
- `bun run check` green.

## Report

`prompts/autoapp/reports/18b-every-model-in-one-list.md`: the routes as built;
every place a model is named on screen and the words it now carries — a table,
with the file and line; what `AiChat.tsx` and the `broapp` skill needed, if
anything; the by-hand run with the screenshots, the list's timing with Ollama
closed, and where each tier's task ran; and anything 18a's report said that
turned out not to hold.

## Commit

```
List every provider's models together, and say where each one runs

A model reference could reach any provider that was turned on, and no
screen could write one. Settings now holds every provider in the build,
each with its own address, key, test and switch; the model list is every
enabled provider's, read at once, and a provider that cannot be reached
costs its own group and says why. The pickers write qualified
references, and wherever a model is chosen or named it says whether it
runs on this computer or is sent to a named provider — the reason the
old one-provider rule existed, kept now that the rule is gone.
```

End the commit with the co-author trailer your session's rules give you.
