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

Never import `broapp/host` from browser code: it pulls in `node:fs` and
`Bun.spawn`, and a browser bundle that reaches it fails the build — which is the
intended outcome.

## The command

```
broapp dev [--no-open]        Watch, rebuild, restart the host
broapp build [--target <id>]  Build the UI and compile an executable
broapp build --page           Build the UI document only
broapp build --all-targets    Every supported target
```

## Requirements

Bun 1.2 or newer. Peer dependency on React 18 or newer, and only if you use
`broapp/react`.

## Licence

MIT.
