# 08 — The MCP adapter

## Goal

An external agent (Claude Desktop, Claude Code, any MCP client) can call a
running application's operations, through the same gate, with approvals
answered from the application's own tab, and denied outright when no tab
is attached. After this prompt: `broapp-autoapp mcp <appId>` is a stdio
MCP server; it talks to the launcher over a loopback control connection
with a secret; the launcher forwards each call to the child over IPC; the
child runs it through `invoke` with channel `mcp`.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far.
- Install the SDK first (Step 1), then read
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (`McpServer`, `registerTool` or `tool`, whichever exists — the `.d.ts` wins),
  `.../server/stdio.d.ts` (`StdioServerTransport`), and
  `.../types.d.ts` for `ToolAnnotations` (`readOnlyHint`, `destructiveHint`).
- `packages/broapp-autoapp/src/ipc/*`, `src/launcher/supervisor.ts`, `src/child/run-child.ts`, `src/host/autoapp.ts` (the `PendingApprovals` and `attachedOnly` from prompt 06).
- `packages/broapp/src/host/gate.ts`, `approvals.ts`.
- `node_modules/bun-types/bun.d.ts`: `Bun.listen`, `Bun.connect`, `TCPSocket`, `SocketHandler`.

## Step 1 — dependency

Add `@modelcontextprotocol/sdk` to `packages/broapp-autoapp/package.json`
`dependencies` at the exact latest version `bun add` resolves; write the
version into the report. It is used only by `src/mcp/*`, which the
launcher binary imports lazily (`await import`) inside the `mcp` command
so `serve` does not load it. Add a test in the browser-bundle boundary
file that `broapp-autoapp/react` and `/shared` do not import it.

## Step 2 — the control connection

`packages/broapp-autoapp/src/launcher/control.ts`. The launcher listens on
`127.0.0.1` at an ephemeral port and writes `<root>/launcher.json`
(`{ port, secret, pid }`, mode `0600`, secret 32 random bytes hex from
`crypto.randomBytes`) atomically; removes it on exit. Protocol: newline
delimited JSON; the first line from a client must be
`{ "v": 1, "type": "auth", "secret": "..." }` and the socket is closed on
anything else; a client that has not authenticated within 2 s is closed.
Then requests `{ v: 1, id, type: 'invoke', appId, route, input, client }`
and replies `{ v: 1, re: id, ok: true, output }` or
`{ v: 1, re: id, ok: false, code, message }` where `code` is a
`PublicError` code. Also `{ type: 'describe', appId }` → the app's
`ContractExport` from its current release (read from the store, no child
involved). Maximum line 1 MB; over it, close.

The control listener only accepts connections whose remote address is
`127.0.0.1`. Comment: this plus the secret file's mode is a same-user
check, and a process running as the user is already trusted local code;
the secret is there so a stray local port scanner cannot call tools.

## Step 3 — forwarding to the child

Add `Invoke` to `ipc/messages.ts`:

```ts
export interface Invoke extends Base {
  readonly type: 'invoke';
  readonly route?: string;
  readonly input?: unknown;
  readonly client?: string;              // MCP client name, for `caller`
  readonly requestId?: string;
  // reply
  readonly ok?: boolean;
  readonly output?: unknown;
  readonly code?: string;
  readonly message?: string;
}
```

`ChildHandle.invoke({ route, input, client, requestId, timeoutMs })`.
The child, on `invoke`: `app.invoke(route, input, { requestId, channel: 'mcp', caller: \`mcp:${client}\`, approver: attachedOnly(approvals, () => running.attached), signal })`
where `signal` aborts when the launcher's timeout passes or the IPC drops.
The child never sees the control secret. Errors map to
`{ ok: false, code, message }` with the same boundary as the bridge: a
`PublicError` keeps its message, anything else is the fixed sentence.

The child's `app` here is the application's `HostApp`; `AppInstance` gains
`invoke` in `child/module.ts` (`AppInstance.invoke = app.invoke`), and the
Notes `app.ts` and the fixture expose it.

## Step 4 — the stdio server

`packages/broapp-autoapp/src/mcp/server.ts`: `runMcp({ appId, root, stdin, stdout })`:

1. Read `launcher.json`; if absent, print to stderr "the launcher is not running; start it with `broapp-autoapp serve`" and exit 1.
2. Connect, authenticate, `describe` the app.
3. Register one MCP tool per operation whose `effect` is `read` or
   `write`. Operations with effect `external` are **not** exposed in v1;
   say so in the tool list's server instructions. Tool name is the route
   with the dot replaced by `_` (MCP tool names cannot contain a dot in
   some clients; check `types.d.ts` and note what it allows). Description
   is the route's `summary`. Input schema is the exported JSON Schema.
   Annotations: `readOnlyHint: effect === 'read'`,
   `destructiveHint: effect === 'write'`. Annotations are descriptive; the
   comment says the gate enforces, not the hint.
4. Each call forwards `invoke` with `client` = the MCP client's reported
   name from the initialize handshake (fall back to `unknown`) and
   `requestId` = a fresh uuid. A `rejected` reply becomes an MCP tool
   result with `isError: true` and the message; the person sees it in
   their agent's transcript and, if a tab was attached, the question they
   declined or let time out.
5. Server instructions (the `instructions` field of the server info)
   state: writes need approval in the application's browser tab; if no tab
   is open the call is refused; open the application from
   `broapp-autoapp serve` first.

`launcher/main.ts` gains `mcp <appId>` that calls `runMcp` with process
stdio. The command is what a person pastes into their MCP client
configuration:

```json
{ "command": "/path/to/broapp-autoapp", "args": ["mcp", "notes"] }
```

## Step 5 — the tab side

The approvals strip from prompt 06 already shows pending questions from
any channel; make sure the channel and caller are visible ("from Claude
Desktop via MCP"). Nothing else changes in the browser.

## Step 6 — tests

`tests/autoapp-mcp.test.ts`:

1. Control: no auth line → closed; wrong secret → closed; correct secret → `describe` returns the contract export; a non-loopback remote address is impossible to simulate without binding another interface, so assert the listener's `hostname` is `127.0.0.1` from its handle.
2. `launcher.json` has mode `0600` (skip the mode assertion on Windows with a printed reason).
3. Forwarded `invoke` of a `read` route succeeds with no tab attached.
4. `invoke` of a `write` route with no tab attached is `rejected` with the "no browser tab" message, and the child's run store records `denied`.
5. With a harness client connected as the tab: the pending question appears in `approvalsList`; answering `approved: true` with the right hash runs it; the run store shows channel `mcp`, caller `mcp:test-client`.
6. Wrong hash in the answer → mismatch → rejected.
7. Timeout: nobody answers → rejected after `confirmTimeoutMs`.
8. IPC drop mid-call (kill the child) → the control reply is `ok: false` with code `unavailable`, and the launcher's `serve` loop restarts the child from `current` (add that restart-on-crash to `serve` here if prompt 05 did not: at most three restarts in a minute, then stop and report).
9. The stdio server, driven through the SDK's `Client` with an in-memory transport pair if the SDK exports one (check `.../client/index.d.ts` and `.../inMemory.d.ts`), lists only `read` and `write` tools with the right annotations, and a tool call round-trips to the fixture application.
10. `launcher.json` absent → `runMcp` exits 1 with the stderr sentence.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-mcp.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run check
```

By hand: with `serve` running and Notes open, configure Claude Desktop
(or `claude mcp add` in Claude Code) with the command above; ask it to
list notes (works without approval), then to create one (a question
appears in the Notes tab; approve; the note appears); close the Notes tab
and ask again (refused with the "no browser tab" sentence). Record it.

## Acceptance criteria

- No path from an MCP client to an operation bypasses `Gate.guard`; the only entry is `app.invoke` with channel `mcp`, and `grep -rn "channel: 'mcp'"` shows exactly one site, in `run-child.ts`.
- The control secret never crosses IPC and never appears in a log or a run record.
- `external` operations are not offered to MCP clients.

## Report

`prompts/autoapp/reports/08-mcp.md`. Include the SDK version and the manual transcript.

## Commit

```
Add the MCP adapter over the gate

broapp-autoapp mcp <app> is a stdio MCP server that reaches the running
application through the launcher's loopback control connection and the
child's IPC. Every call runs through the application's gate with channel
mcp; writes are approved from the application's tab and refused when no
tab is attached. External operations are not offered.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
