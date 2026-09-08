# Broapp AI Elements — build prompts

Four build prompts, run in order, one per agent session, written for a
Sonnet-class agent. Each prompt fixes every naming and layout decision up
front, lists the files to read first, names the tests, and gives the
commands whose output decides whether the step is done. Every prompt ends
by writing a short report to `prompts/ai-elements/reports/NN-<name>.md`;
the next prompt starts by reading the reports so far.

What this series does: replaces the hand-rolled chat plumbing in
`broapp/ai/react` with the Vercel AI SDK's `useChat` over a Brobridge
transport, and the hand-rolled panel with Vercel AI Elements, so
attachments, pasted screenshots, markdown, stop, and tool cards come from
standard packages. The host does not change shape. `broapp/ai/react`
stays as the no-dependency option.

| # | File | Produces | Gate |
|---|------|----------|------|
| 00 | `00-common-rules.md` | Rules, fixed decisions, the regression guard, verified third-party facts. Read first, every time. | — |
| 01 | `01-transport.md` | `packages/broapp-ai-elements`: `createBroappChatTransport`, `useBroappChat`. Chunk mapping for text, tools, confirmations, usage, cancel. | Transport tests over a real bridge, folded by `readUIMessageStream`, green. Browser bundle passes the off-origin check. |
| 02 | `02-attachments.md` | `files` on `ai.chat`; host file parts and the vision refusal; browser downscaling; history placeholder. | `tests/ai-chat.test.ts` unchanged and green; new cases green; two 1.9 MB files round-trip. |
| 03 | `03-elements-ui.md` | Vendored AI Elements + shadcn primitives, `BroappChat`, the approval card with countdown, hardened markdown, the built stylesheet. | `renderToString` proves markdown links/images/HTML are inert; built CSS has no `url(`/`@import`; bundle passes off-origin. |
| 04 | `04-adoption-docs-release.md` | Notes example and launcher on `BroappChat`; docs, skill, site, packing, dry runs; manual run with a pasted screenshot. | Full `bun run check`, notes build + smoke, launcher build, both dry runs; the manual-run table filled in. |
| 04b | `04b-vision-capability.md` | Fix-up from report 04: the compatible adapter learns vision from Ollama's `/api/show` or a known OpenAI id; custom servers are assumed able. | Provider tests green; rows 8–11 and 13 re-run with a vision model. |
| 04c | `04c-attachment-race.md` | Fix-up from report 04b: a send waits for pending `FileReader` reads; the chip shows immediately; submit disabled while pending. | Helper tests green; manual rows A–D pass. |
| 04d | `04d-drawer-and-scheme.md` | Panel follows the page's `color-scheme` via `light-dark()`; scoped form-control reset; `BroappChatDrawer` + `BroappChatToggle`; launcher moves Engineer into the drawer. | View/CSS tests green; manual rows 1–10 pass with macOS in dark mode. |
| 06 | `06-threads.md` | Threads in SQLite under the data dir: seven `ai.threads*` routes, per-thread `modelId` sent on `ai.chat`, `useBroappChat({ threadId, modelId })`, `useAiThreads()`. Images stored as placeholders. | Harness tests green incl. restart; `tests/ai-chat.test.ts` unchanged. |
| 07 | `07-workspace-layout.md` | Launcher as a full-width chat workspace: rail + history + chat + applications, model picker per thread, chat menu, settings drawer that overlays, light/system/dark switch. | View/CSS tests green; manual rows 1–17; nothing shifts when anything opens. |
| 07b | `07b-scheme-convention-and-thread-order.md` | Fix-up from report 07: Bun rewrites `light-dark()` into an OS query, so the scheme keys on `<html data-scheme>` with an OS fallback, proven on the built page; thread list ordered by a monotonic `seq`. | Built-page test has no `buncss-`; `ai-threads` passes six runs in a row. |
| 05 | `05-backlog.md` | Not a build prompt. What comes next and why it waited. | — |

## How to run one prompt

Start a fresh session on a Sonnet-class model, in the repository root, on
branch `autoapp`, and give it exactly this, replacing `NN`:

```
Read prompts/ai-elements/00-common-rules.md, then prompts/ai-layer/00-common-rules.md,
then every file in prompts/ai-elements/reports/ in order, then prompts/ai-elements/NN-*.md.
Do what NN says. Do not do anything from a later prompt. Do not ask questions;
decide, record the decision in the report, continue.
```

One prompt per session. Do not start NN+1 until the review below passes.

## Review before the next prompt (for the person overseeing)

Read the report and check, in this order:

1. The final `bun run check` line says exit 0, and `bun test tests` shows
   more tests than before, none skipped. Run it yourself; do not trust the
   report alone.
2. `git show --stat HEAD` touches only the files the prompt allows.
   Anything under `packages/broapp/src/ai/react/`, `host/gate.ts`,
   `host/{registry,secrets,settings}.ts`, `create-broapp/`, or
   `broapp-autoapp/src/launcher/` (other than the two UI files in 04) is a
   stop.
3. Every deviation in the report names a `.d.ts` line or a repository
   file as its reason. "It seemed cleaner" is not a reason; revert it.
4. `grep -rn "addToolApprovalResponse\|sendAutomaticallyWhen\|dangerouslySetInnerHTML" packages/broapp-ai-elements/src`
   is empty (after 01) — except inside a vendored file where it is
   unreachable, and the report says which.
5. `grep -rn "from '@/" packages/broapp-ai-elements/src` is empty (after 03).
6. `packages/broapp-ai-elements/package.json` has no `^` or `~`.
7. After 03: open the `renderToString` test and confirm it asserts on a
   markdown link, a markdown image and a `<script>` string, and that none
   rendered as an element.
8. After 04: the manual-run table has an outcome per row, the provider
   used is named, and no key was read from the environment or another
   application's data directory.

If a check fails, do not patch it by hand in the same session as the next
prompt. Write a one-paragraph fix-up prompt naming the report line and the
file, run it as its own session, and review again.
