# The AI layer

Optional and off by default. Add it only when the user asks for an assistant,
a chat panel, or "AI" in their application. An application that does not call
`createAi` carries none of it.

Full document: `docs/ai.md` upstream.

## Turning it on

Four touches.

**1. `src/host/ai.ts`.**

```ts
import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai } from 'broapp-ai-compatible';
import { createAi, fromContract } from 'broapp/ai/host';

export function createNotesAi(app: HostApp<typeof contract>, state: StoreState, dataDir: string): Ai {
  return createAi({
    dataDir,
    providers: [anthropic(), ollama(), openai(), customServer()],
    app: { name: 'Notes', purpose: 'Keeps the user\'s notes on this computer.', terminology: ['note'] },
    context: {
      // Refs are yours to shape; `note:<id>` is a convention, not a rule.
      search: (query, signal) => Promise.resolve(/* ContextRef[] */),
      resolve: (refs, signal) => Promise.resolve(/* ContextDocument[] */),
    },
    tools: fromContract(contract, app, {
      read: ['notes.list'],
      confirm: ['notes.create', 'notes.update', 'notes.remove'],
    }),
  });
}
```

**2. Mount it beside the application.**

```ts
register: (bridge) => { app.mount(bridge); ai.mount(bridge); },
isBusy: () => app.activeStreams > 0 || ai.activeStreams > 0,
onShutdown: () => { ai.abortAll('shutting down'); app.abortAll('shutting down'); },
```

**3. The browser entry point.**

```tsx
import { aiContract, AiProvider } from 'broapp/ai/react';
import 'broapp/ai/react/ai.css';

<BroappProvider contract={contract} extensions={[aiContract]}>
  <AiProvider><App /></AiProvider>
</BroappProvider>
```

**4. The panels.** `<AiSettings />` wherever settings live, and
`<AiChat refs={…} onToolResult={…} />` in the interface. Use `onToolResult`
to refetch whatever a confirmed tool just changed.

Add `broapp-ai-anthropic` and `broapp-ai-compatible` to the project's
dependencies. Routes live in the reserved group `ai`; an application contract
that declares `ai.*` is refused at startup.

## The permission rule

`fromContract(contract, app, { read, confirm })` is the whole tool surface.

- `read` — runs as soon as the model asks. Use it only for operations that
  change nothing.
- `confirm` — the browser shows what is about to happen and the user answers.
  **Every operation that writes, deletes, spends, sends, or is otherwise hard
  to undo goes here.** There is no third option and no "remember my answer".
- Anything not listed is not a tool. That is the default, and it is the right
  one: do not list an operation because it might be useful.

An operation needs a `summary` in the contract before it can be a tool — the
description is what the model has to go on. A route with a foreign validator
(no `toJsonSchema`) cannot be derived; write the tool by hand instead.

A declined tool returns an ordinary result to the model, so it can explain
rather than retry. Nobody answering is also a decline, after
`confirmTimeoutMs` (five minutes by default).

## Never

- **Never send a model id string as `model`.** The AI SDK resolves a string
  through the Vercel AI Gateway, over the *global* `fetch`, to a remote host.
  Always pass a provider instance. The layer does this for you; do not work
  around it.
- **Never let the browser reach a provider.** The page's CSP forbids it, and
  a key in a page is a published key. All provider traffic is host-side.
- **Never hide the data notice.** `<AiSettings/>` says whether the chosen
  provider runs on this computer or receives the user's documents. It stays
  visible.
- **Never put a key in `settings.json`, a log, an error, or a transcript.**
  The browser gets `hasKey` and the last four characters, nothing more.
- **Never quote a provider's response body in a user-facing message.** It can
  echo the prompt back or carry a fragment of the key. Use `AdapterError` with
  words a user can act on, and attach the body as `cause`.

## Testing it

`createFakeAdapter` is the AI SDK's own `MockLanguageModelV4` behind the
adapter interface, so `streamText` runs its real loop over scripted chunks. No
key, no network.

```ts
const adapter = createFakeAdapter({
  script: [
    { kind: 'tool', name: 'notes.list', input: {}, then: [{ kind: 'text', chunks: ['You have 2.'] }] },
  ],
});

const ai = createAi({
  dataDir,
  providers: [adapter],
  app: { name: 'Notes', purpose: 'testing' },
  tools: fromContract(contract, app, { read: ['notes.list'] }),
  fetch: noNetwork,   // a fetch that rejects; tests must not reach the network
});
```

Mount it on a test bridge, subscribe to `ai.chat`, and assert on the events.
`adapter.calls` holds every prompt the model was shown; `adapter.modelCalls`
and `adapter.aborted` cover the model instance and cancellation.

Useful cases: a plain reply, a read tool running, a confirm tool approved and
declined, a cancel mid-stream, and `ai.chat` before a provider is configured
(it fails with `unavailable`).
