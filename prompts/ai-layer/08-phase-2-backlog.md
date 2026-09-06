# 08 — Phase 2 backlog (not a build prompt)

Deferred on purpose so phase 1 ships small. Each item lists why it waited
and what it needs. Turn any of these into a prompt in the style of 02–07
when its time comes.

## Threads persistence

Phase 1 keeps the conversation in the browser tab and resends it. Fine for
a session, lost on reload. Phase 2: `ai.threads.list/get/create/delete`
over `<dataDir>/ai/threads.sqlite` with `bun:sqlite`, a migration table
like the notes example, `useAiChat({ threadId })`. Transcripts must never
store the key or any `AdapterConfig`. Needs: a decision on retention and a
"Clear all conversations" control in `<AiSettings/>`.

## OS keychain secret store

`KeychainSecretStore` for macOS via `Bun.spawn(['security', 'add-generic-password', ...])`
and `find-generic-password -w`, Linux via `secret-tool` when present,
Windows via PowerShell `CredentialManager` only if a no-module route
exists. Fall back to the file store when the tool is missing, and say
which store is active in `<AiSettings/>`. Waited because every one of
these needs a real machine test and none can run in CI.

## Anthropic-specific quality

Prompt caching on the system prompt and tool definitions, `effort`, and
`thinking: { type: 'adaptive' }` through the AI SDK's `providerOptions`.
Waited because the spike only proved compile-ability, and the compatible
adapter has no equivalent. Design: an optional `providerOptions(modelId)`
on `ProviderAdapter`, merged into `streamText`.

## Structured output and generate (non-chat) API

`ai.generate` operation for applications that want one-shot extraction or
classification with a JSON schema, no conversation. Same context assembly,
`output_config`-style schema via the AI SDK's structured output. Waited
because chat exercises everything the loop needs and generate is a subset.

## Images and files as context

`ContextDocument` gains an optional binary part (`{ mediaType, data }`)
for screenshots, PDFs and photos; the AI SDK carries them as file parts.
Waited for the capabilities matrix to matter (`vision: false` on most
compatible servers).

## Markdown rendering in `<AiChat/>`

Deliberately plain text in phase 1: no renderer dependency, no HTML
injection surface. Phase 2 can add a small, allow-listed renderer as an
opt-in prop. Never `dangerouslySetInnerHTML` with model output.

## Generator flag

`bun create broapp my-app --ai` adds the four touches to the template.
Waited because the template's promise is a network-free first run and the
provider packages add install weight; the flag must default off.

## MCP server export

Expose an application's AI tools as an MCP server over stdio so Claude
Desktop or Claude Code can drive the app. Reuses `fromContract` and the
permission model. Waited because it is a different trust boundary (a
process on the machine, not the authenticated tab) and needs its own
threat-model paragraph.
