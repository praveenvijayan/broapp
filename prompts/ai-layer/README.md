# Broapp AI layer — build prompts

Seven prompts, run in order, one per agent session. Each prompt is
self-contained but assumes the previous ones landed. Every prompt ends by
writing a short report to `prompts/ai-layer/reports/NN-<name>.md`; the next
prompt starts by reading the reports so far.

| # | File | Produces | Gate |
|---|------|----------|------|
| 00 | `00-common-rules.md` | Rules every prompt must follow. Read first, every time. | — |
| 01 | `01-spike-compile.md` | Proof that `ai` + two adapters compile with `bun build --compile`; binary size delta; proof the Vercel gateway is never contacted. | Stop if the spike fails. Report the failure. Do not continue to 02. |
| 02 | `02-shared-schema-and-contract.md` | `toJsonSchema` on the `s` validator; `mergeContracts`; `broapp/ai` shared contract, types and events; `HostApp.invoke`. | `bun run check` green. |
| 03 | `03-host-settings-secrets-adapters.md` | `broapp/ai/host`: settings store, secret stores, adapter interface, registry, `createAi` with settings/providers/models/test routes, fake adapter. | Real-bridge tests green. |
| 04 | `04-chat-run-loop.md` | `ai.chat` stream, context assembly, tools from contract, permissions, `ai.chat.confirm`. | Real-bridge tests with the fake adapter green, including cancel and confirm. |
| 05 | `05-provider-packages.md` | `broapp-ai-anthropic`, `broapp-ai-compatible` workspace packages. | Tests with mocked `fetch` green. No network in tests. |
| 06 | `06-react.md` | `broapp/ai/react`: `useAiSettings`, `useAiModels`, `useAiChat`, `<AiSettings/>`, `<AiChat/>`, `ai.css`. | Typecheck green; manual run in the notes example. |
| 07 | `07-notes-example-docs-release.md` | Notes example wired up; `docs/ai.md`; README, skill, site; CI; release dry run. | Full `bun run check`, notes build + smoke, dry run. |
| 08 | `08-phase-2-backlog.md` | Not a build prompt. What comes next and why it was deferred. | — |

## How to run one prompt

Give the agent this exact instruction, replacing `NN`:

```
Read prompts/ai-layer/00-common-rules.md, then every file in
prompts/ai-layer/reports/ in order, then prompts/ai-layer/NN-*.md.
Do what NN says. Do not do anything from a later prompt.
```

## Why it is split

The agent doing the work has limited room for open-ended reasoning. Each
prompt therefore fixes every naming and layout decision up front, lists the
files to read before writing, states the exact interfaces, names the tests,
and gives the commands whose output decides whether the step is done. Where
a third-party API must be confirmed, the prompt says which `.d.ts` to open
rather than asking the agent to recall it.
