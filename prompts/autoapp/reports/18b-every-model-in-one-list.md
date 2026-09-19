# 18b — Every model in one list, and where each one runs

## Routes, as built

- **`ai.modelsList`**
  - Output: `{ models, unavailable: Array<{ provider, message }> (max 50) }`.
  - A launcher with no provider in use still throws today's "AI is not set up yet".
  - Otherwise every enabled provider is asked at once, each under `PROVIDER_TIMEOUT_MS`.
  - A provider whose key or address is missing is not asked. Its sentence comes from
    `registry.resolve(formatModelRef(id, '-'))`, so the rule stays in one place.
  - An `AdapterError` becomes that provider's `unavailable` line.
  - The route throws only when no provider could be read, with the first failure in build
    order. With one provider, that is exactly today's error.
  - Over 1000 models together: `fairShares` shows a short list whole and splits the rest
    equally. A provider that was cut gains `<label>: only the first <n> models are shown.`
- **`ai.providerTest { provider }`**
  - Tests that provider with its own address (`configFor`) and its own key, whether it is on
    or off. Testing leaves it off.
  - An unknown id is `invalid_input`. A missing key or address throws `resolve`'s sentence
    (`unmet` in `create-ai.ts`; a test holds the two sets of sentences equal).
  - `ai.connectionTest` is unchanged. Both routes go through `tryConnection`.
- **`findModel(ref, models, activeProvider, providerIds?)`** in `model-ref.ts`, plus
  `whereItRuns` and `describeModel` (name, where, and `not offered` or `<label> is off`).
  - `providerIds` is optional: without it, a reference to a provider that is off, and so
    absent from the list, could not be told from a bare id.
- **Hooks.**
  - `useAiModels` adds `unavailable`. It refetches when the enabled set, an enabled
    provider's address, or whether it has a key changes. Choosing a model does not refetch.
  - `useAiSettings.test(provider?)` calls `ai.providerTest` when given an id.
  - `useAiSettings` now re-reads `ai.providersList` when any address changes (see "18a
    reread").

## Every place a model is chosen or named, and its words

| Where | File:line | Words |
|---|---|---|
| Settings, each provider's summary | `broapp/src/ai/react/AiSettings.tsx:189` | `<label> — on this computer` or `— sent to <host>` or `— no address yet`, then `in use` / `on` / `off` / `needs a key` / `needs an address` |
| Settings, "In use" notice | `AiSettings.tsx:442`, `:348` | today's sentence, plus `Tasks and conversations that choose a model from <labels> are sent there instead.`, or `Every provider turned on runs on this computer…` |
| Settings model select | `AiSettings.tsx:420` | the in-use provider's models only (the Settings model stays bare); where it runs is in the notice under it |
| Picker group headings | `broapp-ai-elements/src/ui/BroappModelPicker.tsx:139` | `<label> — on this computer` / `— sent to <label>` |
| Picker "follows Settings" row | `BroappModelPicker.tsx:133` | `<model> · on this computer` |
| Picker trigger (conversation header) | `BroappModelPicker.tsx:237` | `<name> · <where>[ · not offered / <label> is off]` |
| Picker line after a move | `BroappModelPicker.tsx:287` | `From the next message, this conversation is sent to <label>.` / `…stays on this computer.` |
| Picker unavailable lines | `BroappModelPicker.tsx:164` | each provider's sentence |
| Conversation list | `BroappThreadList.tsx:195`, fed by `launcher/ui/App.tsx:658` | `<model> · <where>` |
| Task and tier selects | `launcher/ui/IntentPanel.tsx:251`, `:249` | `<optgroup label="<label> — <where>">`; a value outside the list shows `modelName` |
| Empty choice (task and tier) | `IntentPanel.tsx:320`, `:501` | `Settings: <model> · <where>` / `<tier> tier: <model> · <where>` |
| Beside each tier and task | `IntentPanel.tsx:314`, `:486` | `on this computer` / `sent to <label>` |
| Tier warnings, above the rows | `IntentPanel.tsx:304` | `The <tier> tier names <label>, which is off in Settings.` / `…which cannot be reached: <message>` |
| Overview, Running now | `launcher/ui/OverviewScreen.tsx:536` | `· <model> · <where>` |

`AiChat.tsx` names no model or provider on screen; it needed nothing. The `broapp` skill
(`references/ai-layer.md`) only described the data notice. Its "never hide" bullet now also
covers the words beside every model.

## By hand (copy of the real root, reading-list only, no key)

- Stand-in provider. There is no hosted key in the copy: 18a's session was refused a copy of
  `secrets.json`, and sending source to a paid provider was not asked for. The "hosted"
  provider is `customServer()` at `http://[::ffff:127.0.0.1]:11434/v1`.
  - That is Ollama, reached by an IPv4-mapped address.
  - `isLoopbackUrl` does not recognise that address, so it reads as `sent to [::ffff:7f00:1]:11434`.
  - Nothing left the machine.
- Screenshots: `18b/settings-{light,dark}.png` and `18b/picker-{light,dark}.png`.
- **Settings, as first drawn:**
  - `Anthropic — sent to api.anthropic.com · needs a key`
  - `Ollama (local) — on this computer · in use`
  - `OpenAI — sent to api.openai.com · needs a key`
  - `OpenRouter — sent to openrouter.ai · needs a key`
  - `OpenAI-compatible server — no address yet · needs an address`
- **Ollama's Test:** "Connected to Ollama (local). (41 ms)".
- **After typing the stand-in's address and turning it and OpenRouter on:** its line read
  `… — sent to [::ffff:7f00:1]:11434 · on`. The notice gained "Tasks and conversations that
  choose a model from OpenRouter and OpenAI-compatible server are sent there instead."
- **Picker:**
  - Two groups, `Ollama (local) — on this computer` and `OpenAI-compatible server — sent to
    OpenAI-compatible server`.
  - OpenRouter's missing key is one line under the list.
  - Pinned to `qwen3.8:27b-mlx`: label `qwen3.8:27b-mlx · on this computer`, no line (local
    to local). A message was answered "hello" in 20 s.
  - Then pinned to the stand-in's `gemma4:31b-mlx`: **"From the next message, this
    conversation is sent to OpenAI-compatible server."**
- **List with a provider down.** Ollama was not quit, because 18a's attempt returned "User
  canceled". The stand-in's address was moved to `127.0.0.1:9`.
  - Refresh took **65 ms**.
  - The list kept Ollama's six rows, with "Could not reach OpenAI-compatible server. Check
    your connection and the server URL." under it.
- **Tiers, set from the Backlog panel's selects** (the file was never touched):
  `{ light: "ollama:qwen3.8:27b-mlx", standard: null, deep: "openai-compatible:qwen3.8:27b-mlx" }`.
  One intent per tier, each run from the panel:

| task (tier) | ran on, from the usage rows | outcome |
|---|---|---|
| 0005 light | `qwen3.8:27b-mlx` ×2 (bare: Ollama is in use) | failed after 2 attempts |
| 0006 standard | `gemma4:31b-mlx` ×2 (the Settings model) | failed after 2 attempts |
| 0007 deep | `openai-compatible:qwen3.8:27b-mlx` | stopped on a question to the person |

  - The Overview's Running-now line during the deep task:
    `Reading list · Task 1 of 1 · qwen3.8:27b-mlx · sent to OpenAI-compatible server`.
  - The binary then also appended `· not offered`, which was wrong: that call passed no list.
    It was fixed and rebuilt before the screenshots.
  - Spend footer: `Tokens today ≥880k`, and no dollar figure anywhere. Unpriced, so nothing
    shown, not `$0`.
- **Turning off the provider a tier names.** The deep tier's provider was turned off (Ollama
  is in use and cannot be; see deviation 3). The tier block said: **"The deep tier names
  OpenAI-compatible server, which is off in Settings."** Beside the rows: `on this computer`
  ×2, `sent to OpenAI-compatible server`.

## 18a reread: what did not hold

- The claim that `ai.providersList` answers each provider's `local` correctly held on the
  host. But the browser read the list once, so after an address change its words went stale.
  `useAiSettings` now re-reads it when any address changes; seen by hand, `sent to [::ffff…]`
  became `on this computer`.
- This prompt's own premise that 17b's Running now names the model did not hold: the route
  carried `modelId` and the screen never drew it. It is drawn now, with its words.

## Deviations, and decisions I made

1. **The by-hand run had no hosted provider, and Ollama was not quit.** Stand-ins are
   described above.
2. **The "In use" section keeps today's Test connection** beside each provider's own Test.
3. **"Turn Ollama off with the light tier naming it" was not possible here.** Ollama is in
   use, and the one in use cannot be turned off (18a). The deep tier's provider was turned off
   instead.
4. **New props.** `BroappModelPicker.sent` (the message count; the line clears when it grows)
   and `BroappThreadList.describeModel`. Both are optional, so existing callers are unchanged.
5. **Existing tests changed shape, not strength:**
   - `ai-host` and `ai-providers` expect `unavailable: []`.
   - `ai-contract` lists `ai.providerTest`.
   - The providers end-to-end test now expects Ollama's models too: it was in use a moment
     earlier, so it stays on. Its "key went nowhere else" check now asserts that every
     request carrying the key went to Anthropic, and every other request to Ollama's loopback.
   - The picker test gives `activeProvider`, because a bare id means the provider in use.
6. **Tests 5 and 6 are Chromium tests** in `autoapp-overview.test.ts`, over the real launcher
   page, skipped without Chromium as the 17b ones are. Their pure halves (headings, a bare
   reference, `moveLine`) are in `ai-elements-view`.
7. Section 2b: no new component, so the design pass was not rerun. `theme-check` and
   `design-detect` are green. The commit trailer names Claude Opus 5.

## Open questions

- **One slow provider delays the list.** It no longer empties the list, but the route answers
  when the slowest provider does, up to 20 s. Streaming the groups would fix that.
- **Ollama's `:cloud` models read "on this computer".** `glm-5.2:cloud` is listed under Ollama
  and runs remotely. Locality comes from the address, as the docs say; the model id is not
  consulted.
- The picker's trigger is capped at 18rem, so `· sent to <label>` can be cut; the full text is
  in its `title`.
- `isLoopbackUrl` treats `[::ffff:127.0.0.1]` as remote. That errs toward saying "sent".

## Commands

```
bun run typecheck                                                        exit 0
bun test tests/ai-{host,contract,providers}.test.ts                      78 pass, 0 fail
bun test tests/ai-elements-{view,css,transport}.test.ts*                 71 pass, 0 fail
bun test tests/autoapp-{views,overview,intent-tools}.test.ts             94 pass, 0 fail (Chromium ran)
bun test tests                                                           1107 pass, 0 fail (55 files)
bun run --cwd packages/broapp-autoapp build:launcher                     dist/broapp-autoapp 78.2 MB
bun run scripts/autoapp-smoke.ts                                         every step passed
bun run theme-check / design-detect                                      every rule passed / no primary findings
cd examples/notes && bunx tsc --noEmit && bun run build                  exit 0, 72.8 MiB
bun install && bun run check                                             exit 0, 1107 pass
git diff --stat registry.ts settings.ts run.ts threads.ts ai-chat ai-engine-boundary   (nothing)
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| Both set up, light on one and deep on another, without leaving the launcher or editing a file | pass (by hand: address, switch and tiers all from the panels) |
| No place a model is chosen or named leaves out where it runs | pass (table above) |
| One unreachable provider never empties the list or blocks Settings | pass (tests 1; by hand, 65 ms) |
| No picker writes a bare id; stored bare ids still work and show for what they are | pass (tests 4, 6, 7) |
| A provider that is off is contacted only by its own Test | pass (tests 1, 3) |
| One provider: routes and list behave as before, apart from the layout | pass (existing single-provider tests unchanged in meaning) |
| `bun run check` green | pass |
