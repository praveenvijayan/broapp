# 06 — React: hooks, the settings panel, the chat panel

## Goal

`broapp/ai/react` gives an application three hooks and two components, so
turning on AI in the interface is one provider prop, one `<AiSettings/>`
and one `<AiChat/>`. Everything goes over the one existing connection.

## Read first

- `prompts/ai-layer/00-common-rules.md` and reports 01–05.
- `packages/broapp/src/react/hooks.tsx` — the whole file. `useOperation` and `useStream` are the building blocks; `BroappProvider` is what you extend.
- `packages/broapp/src/client/client.ts` — `subscribe` callbacks.
- `packages/broapp/src/ai/shared/*`.
- `examples/notes/src/ui/*.tsx` and `styles.css` — component and class conventions (`card`, `card__title`, `button`, `button--primary`, `input`, `input--select`, `form__label`, `form__row`, `form__hint`, `message`, `message--error`, `message--ok`, `segmented`).
- `docs/streaming.md` — why unmount must cancel.

## Step 1 — `BroappProvider` learns `extensions`

In `packages/broapp/src/react/hooks.tsx` add an optional prop:

```ts
/** Extra contracts to speak over the same connection, e.g. Broapp's `aiContract`. */
readonly extensions?: readonly AnyContract[];
```

Inside the provider, build `const merged = extensions.reduce(mergeContracts, contract)`
once (in a `useRef` or `useMemo` with `[]` deps — the contract is a
module-level constant and must not change) and pass `merged` to
`createClient`. Expose `merged` in the context value as `contract`.
Existing behaviour without `extensions` is unchanged. `useOperation` and
`useStream` need no change: their runtime lookup goes through the client,
which now knows the merged routes.

Test: extend `tests/build.test.ts` or add a small non-DOM test that
`mergeContracts` is what the provider calls — a React render test needs a
DOM, which this repository does not set up. Do not add a DOM test
dependency. Rely on typecheck plus prompt 07's manual run.

## Step 2 — `packages/broapp/src/ai/react/`

Files: `index.tsx` (exports), `provider.tsx`, `use-ai-settings.ts`,
`use-ai-models.ts`, `use-ai-chat.ts`, `AiSettings.tsx`, `AiChat.tsx`,
`ai.css`.

Add `"./ai/react": "./src/ai/react/index.tsx"` and `"./ai/react/ai.css": "./src/ai/react/ai.css"`
to the package exports.

### `provider.tsx`

```tsx
export function AiProvider({ children }: { children: React.ReactNode }): React.ReactElement;
```

Reads the Broapp context. If the merged contract has no `ai.settings.get`
route, throw
`Error('AiProvider needs the AI contract: <BroappProvider contract={contract} extensions={[aiContract]}>')`.
Holds one piece of shared state: the last `AiSettings` fetched, plus a
`refresh()` that calls `ai.settings.get`. Fetches once when the connection
becomes `ready`. Everything below reads settings from here so the panel
and the chat agree on `configured`.

### `use-ai-settings.ts`

```ts
export interface AiSettingsHook {
  readonly settings: AiSettings | null;
  readonly providers: ProviderInfo[];
  readonly pending: boolean;
  readonly error: BroappError | null;
  update(patch: UpdatePatch): Promise<void>;     // UpdatePatch = OperationInput<AiContract,'ai.settings.update'>
  test(): Promise<{ ok: boolean; message: string; latencyMs: number } | null>;
  refresh(): Promise<void>;
}
export function useAiSettings(): AiSettingsHook;
```

Built on `useOperation` for the four routes. `providers` is fetched once
with settings.

### `use-ai-models.ts`

```ts
export function useAiModels(): { models: BroappModel[]; pending: boolean; error: BroappError | null; refresh(): Promise<void> };
```

Refetches whenever `settings.provider`, `settings.baseUrl` or
`settings.hasKey` changes. Does nothing while `settings.provider` is null.

### `use-ai-chat.ts`

```ts
export type ChatMessage =
  | { readonly id: string; readonly role: 'user'; readonly content: string }
  | { readonly id: string; readonly role: 'assistant'; readonly content: string; readonly toolCalls: ToolCallState[]; readonly pending: boolean };

export interface ToolCallState {
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly status: 'running' | 'awaiting-confirmation' | 'done' | 'denied';
  readonly output?: unknown;
}

export interface AiChatHook {
  readonly messages: ChatMessage[];
  readonly status: 'idle' | 'streaming' | 'awaiting-confirmation' | 'error';
  readonly error: string | null;
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  send(text: string): Promise<void>;
  cancel(): void;
  confirm(callId: string, approve: boolean): Promise<void>;
  clear(): void;
}

export function useAiChat(options?: { refs?: readonly string[] }): AiChatHook;
```

Behaviour:
- `send` appends a user message and an empty pending assistant message,
  generates a `runId` with `crypto.randomUUID().replace(/-/g, '')` (fits the contract pattern),
  and subscribes to `ai.chat` with `history` = every prior completed turn
  (cap at the contract's 100, oldest dropped) and `refs` from options.
- Event handling: `text` appends to the pending assistant content;
  `tool-call` adds a `running` tool state; `confirm` flips that call to
  `awaiting-confirmation` and the hook status likewise; `tool-result`
  sets `done` or `denied` with output; `usage` stores counts; `done` marks
  the assistant message not pending and status `idle`; `error` sets error
  and status `error`.
- Use the client's `subscribe` directly rather than `useStream`, because
  `useStream` keeps only the last event and this hook needs every one.
  Copy `useStream`'s unmount-cancels pattern exactly.
- `confirm` calls `ai.chat.confirm` and, on `accepted: false`, sets the
  error `'That request has expired.'`.
- `cancel` cancels the subscription and marks the pending assistant
  message as not pending with its content so far.
- `send` while streaming is ignored (return without doing anything).

### `AiSettings.tsx`

One card, class `ai-settings`. Contents, top to bottom:

1. Title "AI".
2. Provider `<select>` from `providers`, with a first option "Not set up".
3. When a provider is chosen:
   - Server URL input, shown when `needs.baseUrl !== 'none'`, placeholder = `defaultBaseUrl`, required marker when `'required'`.
   - API key input `type="password"` shown when `needs.apiKey`. Below it, when `hasKey`: "A key ending in ‹keyHint› is saved." and a "Remove key" button. The input is **write-only**: it starts empty, is never populated from the host, and is cleared after a successful update. `autocomplete="off"`.
   - "Remember key on this computer" checkbox bound to `remember`, with the hint: "Stored in this application's data folder, readable by your user account. Turn off to keep it only until the app closes."
   - Model `<select>` from `useAiModels()`, with a "Refresh" button and a loading state.
   - A data notice, always visible once a provider is chosen. When `local` is true: "Runs on this computer. Nothing is sent over the internet." Otherwise: "Messages, the documents you are viewing, and search results are sent to ‹label› to generate answers." Use `role="status"`.
   - "Test connection" button showing the result inline with `message--ok` / `message--error`.
4. Every control has a `<label>`. Errors use `role="alert"`. Buttons are disabled while `pending`.

Saving is immediate per control (on change / on blur for text inputs), using `update`.

### `AiChat.tsx`

```tsx
export function AiChat(props: { refs?: readonly string[]; placeholder?: string; emptyText?: string }): React.ReactElement;
```

A card, class `ai-chat`. If `settings.configured` is false, render only the
line "AI is not set up. Open Settings to choose a provider." Otherwise: a
scrolling message list (user / assistant bubbles; assistant text rendered
as plain text in a `<pre class="ai-chat__text">` with `white-space: pre-wrap`
— **no** markdown library, no `dangerouslySetInnerHTML`), tool calls
rendered as a compact row "Used ‹tool›" with a details toggle showing
input and output as JSON, a confirmation row with "Allow" / "Decline"
buttons when a call is `awaiting-confirmation`, the usage line after each
turn, a textarea plus "Send" and "Stop" buttons. Enter sends, Shift+Enter
newlines. Keep focus management simple: after `done`, focus the textarea.

### `ai.css`

Classes for both components, using the same custom properties
`examples/notes/src/ui/styles.css` uses (open it and reuse the variable
names). Respect `prefers-reduced-motion`. Nothing loads from off-origin.
No `@import`, no `url()`.

## Step 3 — exports and the engine-boundary test

`index.tsx` exports `AiProvider`, `useAiSettings`, `useAiModels`,
`useAiChat`, `AiSettings`, `AiChat`, and the types. Re-export `aiContract`
from `broapp/ai` for convenience.

`tests/ai-engine-boundary.test.ts` from prompt 03 now finds the react
directory; it must still pass (no `ai` / `@ai-sdk` imports here).

Add to `tests/build.test.ts`: a browser bundle importing `broapp/ai/react`
succeeds and the produced page passes the off-origin check.

## Verify

```bash
bun run check
```

Typecheck is the main gate here. The visual check happens in prompt 07.

## Report

`prompts/ai-layer/reports/06-react.md`.

Commit:

```
Add the AI React layer: provider extensions, hooks, settings and chat panels
```
