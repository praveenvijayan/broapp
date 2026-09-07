# 04 — Adoption, documentation, release

## Goal

The notes example and the Autoapp launcher use `BroappChat`. The docs,
the skill, the site, the packing script and both dry runs know about the
new package. A person has pasted a screenshot into the launcher's
Engineer panel and watched a vision model answer about it.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–03.
- `examples/notes/src/ui/{App,main}.tsx`, `examples/notes/package.json`.
- `packages/broapp-autoapp/src/launcher/ui/{App,main}.tsx` — the only two
  launcher files you may edit. Read `packages/broapp-autoapp/react/index.tsx`'s
  `titleWithPending` / `announcePending` to see what `onAwaiting` feeds.
- `scripts/pack-local.ts` (`PUBLISHED`, `PREPARE`), `scripts/release-dry-run.ts`,
  `scripts/autoapp-dry-run.ts`, `scripts/smoke-binary.ts`.
- `docs/ai.md`, `docs/architecture.md`, `docs/security.md`,
  `docs/packaging.md`, `README.md`, `skills/broapp/references/ai-layer.md`,
  `skills/broapp/SKILL.md` hard rule 11, `scripts/build-site.ts` page list,
  `tests/skill.test.ts`.
- `prompts/ai-layer/reports/07-notes-docs.md` step 3 — the shape of a
  manual-run write-up, and the provider rule: never read a key from the
  environment or from another application's data directory.

## Step 1 — the notes example

`examples/notes/package.json`: add `"broapp-ai-elements": "workspace:*"`.
`main.tsx`: import `broapp-ai-elements/styles.css` next to `ai.css`
(`AiSettings` still needs `ai.css`). `App.tsx`: replace `AiChat` with
`BroappChat` from `broapp-ai-elements/ui`; props unchanged. Nothing else
in the example changes.

`cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build`
exit 0. Record the binary size before and after in the report.

## Step 2 — the launcher

`packages/broapp-autoapp/package.json`: add `"broapp-ai-elements": "^0.2.1"`
to `dependencies` and `workspace:*` to `devDependencies`, the way `broapp`
is listed there. `launcher/ui/main.tsx`: import the stylesheet.
`launcher/ui/App.tsx`: `AiChat` → `BroappChat`, props unchanged including
`onAwaiting`. No other launcher file.

`bun run --cwd packages/broapp-autoapp build:page && bun run --cwd packages/broapp-autoapp build:launcher`
exit 0. The page is still one document with inline CSS and a hashed CSP
(open `dist/launcher-page.html`, confirm one `<style>` and one
`Content-Security-Policy` meta).

## Step 3 — packing and release

- `scripts/pack-local.ts`: `PUBLISHED` gains `broapp-ai-elements`;
  `PREPARE` gains `'broapp-ai-elements': ['bun', 'run', 'build:css']` so a
  pack never ships a stale stylesheet even though it is committed.
- `scripts/release-dry-run.ts`: the generated project installs the new
  tarball only if the notes example is what it builds; follow what the
  script does for `broapp-ai-anthropic`.
- `bun run dryrun` and `bun run dryrun:autoapp` exit 0.
- `bun run smoke` (or the exact smoke command the README gives for the
  notes binary) passes against the freshly built notes binary.
- CI: if a workflow enumerates packages, add the new one.

## Step 4 — documentation

`docs/ai.md`:

- A new section "The chat panel" after "Turning it on": the two options.
  `broapp/ai/react`'s `AiChat` — no dependencies, plain text, no images.
  `broapp-ai-elements`'s `BroappChat` — AI SDK `useChat` over the same
  bridge, Vercel AI Elements, markdown with links and images disabled,
  pasted and picked images, stop, tool cards, the approval card. Two code
  blocks: the import and the stylesheet line. One paragraph on what
  markdown rendering means for safety and why links and images are off.
- "What leaves the machine": images (prompt 02 wrote the sentence; make
  sure it is there).
- "Limitations": update per prompt 02; add "No code highlighting, math or
  diagrams in markdown" with the reason (bundle size and CSP).
- "Testing your application's AI": one paragraph on
  `createBroappChatTransport` being testable without a DOM, with the
  `readUIMessageStream` pattern from `tests/ai-elements-transport.test.ts`.

`README.md`: the package in "What is in here". `docs/architecture.md`:
the browser side of the fourth layer now names both panels.
`docs/security.md`: under "What this does not protect against", a
paragraph on markdown (rendered to elements, never raw HTML; links and
images disabled) and one on images (sent to the provider with the
message; the same "does this leave my computer" answer applies).
`docs/packaging.md`: the binary-size delta from step 1.
`skills/broapp/references/ai-layer.md`: the panel choice, the imports,
and a rule: never enable links or images in `Response`, never use
`addToolApprovalResponse`. `tests/skill.test.ts` still passes.
`scripts/build-site.ts`: no new page unless you split `docs/ai.md`; if
you do, register it under Guides. `bun run site` exit 0.

## Step 5 — the manual run

Build the notes binary and the launcher (steps 1–2) and run the compiled
binaries, not `broapp dev` (report 07 found `dev` broken on this machine;
check whether it still is and note it, but do not fix it here).

Provider rule: use local Ollama if it is running. For the image rows you
need a vision model; run `ollama list` and pick one whose name says
vision (`qwen2.5vl`, `llava`, `gemma3`, `llama3.2-vision`). If none is
installed, do not pull one and do not use a hosted provider with a key you
found somewhere: record the rows as "not attempted: no local vision
model" and stop. Nothing may leave the machine in this run.

Fill in every row:

| # | Step | Expected | Outcome |
|---|---|---|---|
| 1 | Open the notes app, no provider set | "AI is not set up. Open Settings to choose a provider." in the new panel | |
| 2 | Choose Ollama and a text model, ask "How many notes do I have?" | A `notes.list` tool card, an answer, a usage line | |
| 3 | Ask it to create a note | Approval card with "Allow this?", countdown from 2:00 (notes uses the default gate window), Allow → the note appears, "Used notes.create" | |
| 4 | Ask it to create another, Decline | "Declined notes.create", the model says so, no note | |
| 5 | Ask for a long answer, press Stop mid-way | Text freezes and stays; the input re-enables | |
| 6 | Ask a question whose answer has `**bold**` and a bulleted list | Rendered bold and a list, not literal asterisks | |
| 7 | Ask it to "reply with a markdown link to https://example.com and an image" | The link text appears but is not clickable; no image loads | |
| 8 | Switch to a vision model, paste a screenshot with Cmd-V into the input | A thumbnail appears above the textarea before sending | |
| 9 | Send "What is in this image?" | A sensible description; the host log shows no error | |
| 10 | Ask a follow-up about the same image | The model says it cannot see it, or answers from its earlier text (placeholder rule) — record which | |
| 11 | Paste a 4000×3000 screenshot | It sends (downscaled); no "too large" | |
| 12 | Try to attach a `.txt` file | "Only PNG, JPEG, GIF and WebP images." | |
| 13 | Switch back to a text-only model, paste an image, send | "The chosen model cannot read images. Pick one that can in Settings." | |
| 14 | Launcher: open the Engineer panel, ask for a change to notes, wait for the confirm | The card counts down from about 10:00; the tab title reads `(1) …` | |
| 15 | Launcher: paste a screenshot of the notes UI and ask for the change it shows | The engineer reads the image and proposes a change (vision model only) | |
| 16 | Dark mode (System Settings → Appearance → Dark), reload both apps | Panel legible: text, borders, cards, the approval card's amber | |
| 17 | Reduce Motion on | No typing animation, no scroll animation | |

Screenshots are not required in the report; a one-line outcome per row is.
A row that fails is a bug: fix it in this prompt if the fix is inside
`packages/broapp-ai-elements`, otherwise record it under "Open questions"
with the file you believe is responsible.

## Verify

```bash
bun install
bun run check
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build && cd ../..
bun run --cwd packages/broapp-autoapp build:page
bun run --cwd packages/broapp-autoapp build:launcher
bun run site
bun run dryrun
bun run dryrun:autoapp
```

All exit 0.

## Report

`prompts/ai-elements/reports/04-adoption.md`. Include: the binary size
table; the manual-run table with every row filled and the provider and
model names used; the exact commands and their final status lines; every
bug found and where it was fixed.

Commit:

```
Adopt the AI Elements panel in the notes example and the launcher, and document it
```
