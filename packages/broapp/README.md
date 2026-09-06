# broapp

Runtime and build tooling for local applications made of a Bun host, a browser
UI, and a [Brobridge](https://github.com/praveenvijayan/brobridge) connection
between them.

You normally get this as a dependency of a generated project:

```bash
bun create broapp my-app
```

Full documentation lives in the
[repository](https://github.com/praveenvijayan/broapp).

## Entry points

| Import | What it holds |
| --- | --- |
| `broapp/shared` | The contract, schemas, error types. Safe for both sides. |
| `broapp/host` | `createHostApp`, `startApp`, the data directory, the browser launcher. |
| `broapp/client` | The framework-agnostic browser client. |
| `broapp/react` | `BroappProvider`, `useOperation`, `useStream`, `useConnection`. |
| `broapp/build` | `buildPage`, `buildBinary`, `defineConfig`. |
| `broapp/ai` | The AI contract and its types. Safe for both sides. |
| `broapp/ai/host` | `createAi`, `fromContract`, the secret stores, `createFakeAdapter`. Host only. |
| `broapp/ai/react` | `AiProvider`, `useAiChat`, `useAiSettings`, `useAiModels`, `<AiSettings/>`, `<AiChat/>`. |

Never import `broapp/host` or `broapp/ai/host` from browser code: they pull in
`node:fs`, `Bun.spawn` and the AI SDK, and a browser bundle that reaches either
fails the build — which is the intended outcome.

The AI layer is optional. `broapp/ai/host` needs the `ai` peer dependency and
at least one provider package (`broapp-ai-anthropic`, `broapp-ai-compatible`);
an application that never imports it carries none of that. See
[docs/ai.md](https://github.com/praveenvijayan/broapp/blob/main/docs/ai.md).

## The command

```
broapp dev [--no-open]        Watch, rebuild, restart the host
broapp build [--target <id>]  Build the UI and compile an executable
broapp build --page           Build the UI document only
broapp build --all-targets    Every supported target
```

## Requirements

Bun 1.2 or newer. Peer dependency on React 18 or newer, and only if you use
`broapp/react`. Peer dependency on `ai@7.0.93`, and only if you use
`broapp/ai/host`.

## Licence

MIT.
