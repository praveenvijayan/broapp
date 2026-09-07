# 03 — The AI Elements panel

## Goal

`broapp-ai-elements/ui` exports `BroappChat`, a drop-in replacement for
`AiChat` with the same props, built from vendored Vercel AI Elements and
shadcn primitives: a conversation that sticks to the bottom, messages with
hardened markdown, tool cards, an approval card with the ten-minute
countdown, and a prompt input that accepts pasted screenshots and picked
images. Styling ships as one generated, committed stylesheet. Nothing
adopts it until prompt 04.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01 and 02.
- `packages/broapp/src/ai/react/AiChat.tsx` and `ai.css` — the behaviour
  and the custom properties to honour: `--bg`, `--surface`, `--text`,
  `--text-muted`, `--border`, `--accent`, `--accent-contrast`, `--radius`,
  `--warning`, `--warning-bg`, `--pending`, each with a literal fallback.
- `examples/notes/src/ui/styles.css` — the light and dark values behind
  those properties (`prefers-color-scheme: dark` at line ~49).
- `packages/broapp/src/shared/countdown.ts` — `countdown`, `isUrgent`,
  `URGENT_MS`.
- `packages/broapp/src/cli/build-page.ts` lines 150–210 — how CSS from the
  bundle is inlined and hashed. Your stylesheet goes through this.
- `tests/build.test.ts` — the off-origin check (`cdn.css` case).
- `prompts/autoapp/reports/08c-usability.md` — the "surface" pattern used
  to test title changes without a DOM; the same idea applies here.
- After vendoring: every file the CLI wrote, completely, before editing
  any of it. `node_modules/streamdown/README.md` and
  `node_modules/streamdown/dist/index.d.ts`.

## Step 1 — vendor

Inside `packages/broapp-ai-elements/`:

1. Write `components.json` by hand (do not run `shadcn init`, which wants
   to edit a framework config that does not exist):
   style `new-york`, `rsc: false`, `tsx: true`, `tailwind.css` →
   `src/ui/tailwind.css`, `tailwind.baseColor` `neutral`,
   `tailwind.cssVariables: true`, aliases `components` → `src/ui/components`,
   `ui` → `src/ui/components/ui`, `lib` → `src/ui/lib`, `utils` →
   `src/ui/lib/utils`. Add a temporary `paths` entry for `@/*` in the
   package `tsconfig.json` so the CLI's alias resolution works; remove it
   in step 2.
2. `bunx ai-elements@latest add conversation message prompt-input response tool loader`
   (if the CLI's `list` shows an `attachments` or `attachment` component
   that `prompt-input` needs, add it too). Record the exact `ai-elements`
   version the CLI reported.
3. Pin every dependency the CLI added to the exact installed version.
   Expected: `lucide-react`, `nanoid`, `class-variance-authority`, `clsx`,
   `tailwind-merge`, `radix-ui` (or individual `@radix-ui/*`),
   `streamdown`, `use-stick-to-bottom`, `shiki`? — if `shiki` or any
   `@streamdown/*` plugin arrived, remove it and the import that wanted
   it (step 3). Add `tailwindcss@4.3.3` and `@tailwindcss/cli@4.3.3` to
   `devDependencies`.
4. Audit each added dependency for network use: `grep -rn "fetch(\|import(\|new URL(\|https://" node_modules/<dep>/dist | head`.
   Anything that fetches at runtime is removed or replaced. Write what
   you found, per dependency, in the report.

## Step 2 — make it shippable source

- Rewrite every `@/…` import to a relative path. Remove the `paths`
  entry. Add `tests/ai-elements-source.test.ts`: walks
  `packages/broapp-ai-elements/src`, fails on `from '@/`, on
  `dangerouslySetInnerHTML`, on `addToolApprovalResponse`, on
  `sendAutomaticallyWhen`, and on any vendored file missing the
  provenance header from common rules §2.
- Add the provenance header to each vendored file. Wrap every edit in
  `// LOCAL:` … `// END LOCAL`.
- `response.tsx`: force `allowedLinkPrefixes={[]}` and
  `allowedImagePrefixes={[]}`, drop any plugin props, drop `shiki`/code
  highlighting if it needs a dynamic import (a plain `<pre><code>` is
  fine). Check the streamdown `.d.ts` for the prop names; if the vendored
  component spreads user props over these, put ours **after** the spread so
  they cannot be overridden.
- `prompt-input.tsx`: no edits expected. Confirm paste of a clipboard file
  reaches `attachments.add`, and that `onSubmit` receives data URLs. If
  the component offers `PromptInputActionAddScreenshot`, do not render it
  (backlog item).
- Delete vendored components the six above do not import.

## Step 3 — `src/ui/BroappChat.tsx` and `BroappChatView.tsx`

Split presentation from wiring so the view can be rendered to a string
in a test.

```tsx
export interface BroappChatProps {
  readonly refs?: readonly string[];
  readonly placeholder?: string;
  readonly emptyText?: string;
  readonly onToolResult?: BroappChatOptions['onToolResult'];
  readonly onAwaiting?: BroappChatOptions['onAwaiting'];
  /** Render assistant text as markdown. Default true. */
  readonly markdown?: boolean;
}
export function BroappChat(props: BroappChatProps): React.ReactElement;

export interface BroappChatViewProps {
  readonly messages: readonly BroappUIMessage[];
  readonly status: ChatStatus;              // from 'ai'
  readonly error: string | null;
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  readonly now: number;                     // for the countdown; the wiring ticks it
  readonly markdown: boolean;
  readonly placeholder: string;
  readonly emptyText: string;
  onSend(message: { text: string; files: FileUIPart[] }): void;
  onStop(): void;
  onConfirm(callId: string, approve: boolean): void;
}
export function BroappChatView(props: BroappChatViewProps): React.ReactElement;
```

`BroappChat`:

- Reads `useAiContext()` for the three settings states (regression guard
  5). Renders the same sentences `AiChat` does for the first two.
- `useBroappChat({ refs, onToolResult, onAwaiting })`; a one-second tick
  while any tool part is `approval-requested` (copy `useTick` from
  `AiChat.tsx`).
- `onSend` → `sendMessage({ text, files })`. `onStop` → `stop()`.
  `onConfirm` → `confirm()`, catching the rejection into the view's
  `error`. After a turn ends, focus the textarea.

`BroappChatView`, top to bottom, all under one `div.broapp-chat`:

1. `Conversation` / `ConversationContent` with `ConversationEmptyState`
   showing `emptyText`.
2. For each message, `Message` + `MessageContent`. Assistant text parts:
   `<Response>` when `markdown`, else a `<pre className="broapp-chat__text">`
   with `white-space: pre-wrap`. User text parts always plain. User `file`
   parts: an `<img>` from the data URL (allowed by `img-src data:`), max
   height 160 px, `alt` = filename.
3. Tool parts (`isToolUIPart` from `ai`): `Tool` / `ToolHeader` /
   `ToolContent` / `ToolInput` / `ToolOutput`. The header reads
   "Used ‹tool›" or "Declined ‹tool›" as today (state `output-denied`).
4. When a tool part is `approval-requested`: your own `ToolApproval`
   component under the tool card — `role="group"`,
   `aria-label="Allow ‹tool›?"`, the text "Allow this?", "expires in m:ss"
   from `countdown(descriptor.expiresAt, now)` when present, amber via a
   `broapp-chat__confirm--urgent` class when `isUrgent`, and two buttons
   "Allow" / "Decline" calling `onConfirm`. The descriptor is
   `part.approval?.descriptor` typed as `BroappApprovalDescriptor`; guard
   the shape, do not cast blindly.
5. `Loader` while `status` is `submitted` or `streaming` and no text has
   arrived yet.
6. The usage line "‹n› tokens in, ‹m› out" after the last assistant
   message when `usage` is set.
7. `error` in a `role="alert"` line.
8. `PromptInput` with `accept={IMAGE_LIMITS.accept}`, `multiple`,
   `maxFiles={IMAGE_LIMITS.maxFiles}`, `maxFileSize={10 * 1024 * 1024}`
   (pre-downscale), `onError` mapping the codes to sentences
   (`max_files` → "Up to four images per message.", `max_file_size` →
   "That image is too large.", `accept` → "Only PNG, JPEG, GIF and WebP
   images."), `PromptInputTextarea` with `placeholder`, an attachments
   header, an add-attachment action, and `PromptInputSubmit` bound to
   `status` so it becomes Stop while streaming. Enter sends; Shift+Enter
   newlines (the component does this; confirm).

`src/ui/index.tsx` exports `BroappChat`, `BroappChatView`, `ToolApproval`,
and re-exports the vendored primitives an application may compose:
`Conversation*`, `Message*`, `PromptInput*`, `Response`, `Tool*`, `Loader`.
Add `"./ui": "./src/ui/index.tsx"` to `package.json` exports.

## Step 4 — the stylesheet

`src/ui/tailwind.css`:

```css
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@source "./";
@source "../../node_modules/streamdown/dist";   /* or whatever its README says */

@layer base {
  .broapp-chat {
    --background: var(--bg, #ffffff);
    --foreground: var(--text, #1a1a1a);
    --card: var(--surface, #ffffff);
    --muted-foreground: var(--text-muted, #666666);
    --border: var(--border, #dddddd);
    --primary: var(--accent, #2563eb);
    --primary-foreground: var(--accent-contrast, #ffffff);
    --radius: var(--radius, 8px);
    /* every other shadcn token the vendored components read, mapped or given a literal */
    color: var(--foreground);
    background: var(--background);
  }
  @media (prefers-color-scheme: dark) {
    .broapp-chat { /* dark literals for every fallback above, matching examples/notes/src/ui/styles.css */ }
  }
  @media (prefers-reduced-motion: reduce) {
    .broapp-chat * { animation: none !important; transition: none !important; }
  }
}
```

No `preflight.css`. Find every `--token` the vendored components use
(`grep -oh "\-\-[a-z-]*" src/ui/components -r | sort -u`) and define each
one inside `.broapp-chat`. If streamdown needs `@source` or its own CSS,
follow its README, but inline it: no `@import` of a package stylesheet
that carries `url()`; if it does, copy the rules you need and strip them.

`scripts/build-css.ts` in the package: runs
`bunx @tailwindcss/cli -i src/ui/tailwind.css -o styles.css --minify`
(via `Bun.spawn`, cwd the package), then prepends a one-line comment
`/* generated by bun run build:css — do not edit */`. `package.json`
script `build:css`. Add `"./styles.css": "./styles.css"` to exports.

`tests/ai-elements-css.test.ts`: runs the same build into a temp file and
asserts it is byte-identical to the committed `styles.css` (message:
"run bun run build:css in packages/broapp-ai-elements"); asserts the
committed file contains no `url(`, `@import`, `http:`, `https:`; asserts
it contains `.broapp-chat` and `prefers-color-scheme`.

## Step 5 — tests

`tests/ai-elements-view.test.ts` with `renderToString` from
`react-dom/server`. Fixtures are hand-built `BroappUIMessage`s. Cases:

1. **Markdown is inert where it must be.** Assistant text
   `` "**bold** [link](https://evil.example) ![img](https://evil.example/x.png) <script>alert(1)</script> `code` " ``.
   With `markdown: true`: output contains `<strong>bold</strong>`, contains
   no `<a `, no `<img`, no `<script>`, and contains the literal text
   `&lt;script&gt;` (escaped) or the words `alert(1)` as text only. With
   `markdown: false`: a `<pre` containing the raw string escaped.
2. **Approval card.** A tool part in `approval-requested` with
   `descriptor.expiresAt = now + 9*60_000 + 35_000` renders "Allow this?",
   "expires in 9:35", both buttons, and no urgent class; with
   `expiresAt = now + 30_000` the urgent class is present.
3. **Denied.** `output-denied` renders "Declined notes.create".
4. **Empty state** renders `emptyText`; **usage** renders "1424 tokens in,
   108 out"; **error** renders inside `role="alert"`.
5. **User image part** renders an `<img` whose `src` starts with
   `data:image/png` and `alt` is the filename.

If streamdown cannot render under `renderToString` (it throws on a missing
browser API), do not stub the DOM. Report it, and render case 1 through
the same `Response` component in a way that still exercises the link and
image allow-lists — for example by calling streamdown's underlying
renderer directly if it exports one. If no such path exists, say so in
the report; prompt 04's manual run then carries the link/image check.

`tests/build.test.ts`: a browser bundle importing `BroappChat` from
`broapp-ai-elements/ui` and `broapp-ai-elements/styles.css` builds; the
page has no off-origin reference and none of the forbidden symbols from
prompt 01. Record its size in KiB in the report next to prompt 01's
number.

## Verify

```bash
cd packages/broapp-ai-elements && bun run build:css && cd ../..
bun run typecheck
bun test tests/ai-elements-source.test.ts tests/ai-elements-css.test.ts tests/ai-elements-view.test.ts tests/build.test.ts
bun run check
```

## Report

`prompts/ai-elements/reports/03-elements-ui.md`. Include: the
`ai-elements` version vendored and the component list; every dependency
added with its version and the network audit result; every `LOCAL` edit
and why; whether streamdown rendered under `renderToString`; the
stylesheet size and the bundle size.

Commit:

```
Add the AI Elements chat panel with hardened markdown, image attachments and the approval card
```
