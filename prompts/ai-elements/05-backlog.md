# 05 — Backlog (not a build prompt)

Deferred on purpose so 01–04 ship small. Turn any of these into a prompt
in the style of 01–04 when its time comes.

## Images in history turns

Today an image is sent only with the turn it arrives on; later turns see
`[image: name]`. A follow-up question about a screenshot two turns back
fails. The fix is `history` turns carrying `files`, capped in total across
the request, with the browser dropping the oldest images first. Waited
because the payload is quadratic in conversation length and the contract
needs a total bound, not just a per-turn one.

## Screenshot capture from the panel

AI Elements ships `PromptInputActionAddScreenshot` over `getDisplayMedia`.
It works on the loopback origin but asks for a system permission the app
has not explained to the user. Waited for a sentence in the panel and a
line in `docs/security.md`.

## Streamdown plugins

Code highlighting, math and Mermaid are separate packages. Each pulls a
large bundle (Shiki languages, KaTeX fonts, Mermaid) and at least one wants
`url()` fonts or lazy imports, which the CSP forbids. Waited for a
measured size and an offline-only configuration per plugin.

## Regenerate and edit-in-place

The transport already honours `regenerate-message`. The panel does not
expose it, and editing an earlier user message needs the SDK's
`setMessages` plus a truncate. Waited for a decision on whether a
regenerated answer replaces or appends in the launcher's transcript.

## `reconnectToStream` and threads

Returns `null` today. A reload loses the turn in flight and the
conversation. Pairs with the threads item in
`prompts/ai-layer/08-phase-2-backlog.md`: once transcripts persist, a
run id can be looked up and its remaining events replayed.

## PDFs and text files

The contract allows images only. Anthropic reads PDFs as file parts; most
compatible servers do not. Waited for the capabilities matrix to say
`documents: boolean` per model.

## `AiSettings` on the same components

The settings card is still `broapp/ai/react`'s. Rebuilding it on shadcn
primitives would make the two panels match. Waited because the settings
card works and its key-handling rules are subtle; touching it needs the
manual run from `prompts/ai-layer/reports/07-notes-docs.md` step 3 again.

## Retiring `broapp/ai/react`'s `AiChat`

Kept as the no-Tailwind option. If no application uses it after two
releases, deprecate it and point at `broapp-ai-elements`. Waited for
evidence either way.

## Utility-class collisions

The built stylesheet has no prefix and no preflight. If an application's
own CSS defines `.flex`, `.hidden` or another Tailwind name, the panel
will fight it. The fix is Tailwind's `prefix()` plus a rewrite of the
vendored components' class names. Waited for a collision to actually
happen.

## Generator flag

`bun create broapp my-app --ai` from the phase-2 backlog should now add
`broapp-ai-elements` and its stylesheet rather than `broapp/ai/react`.
Still off by default; still waiting on the install-weight decision.
