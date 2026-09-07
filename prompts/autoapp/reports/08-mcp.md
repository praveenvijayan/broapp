# 08 — The MCP adapter

`broapp-autoapp mcp <appId>` is a stdio MCP server. It reaches a running
application the long way round — loopback control connection to the launcher,
IPC to the child, the application's own gate at the end — because that is the
only path that ends at `Gate.guard` with a channel the caller did not choose.

## What was built

- `src/launcher/control.ts` — the launcher's loopback listener. Ephemeral port
  on `127.0.0.1`, `<root>/launcher.json` written atomically at mode `0600`
  with a 32-byte hex secret and removed on exit, newline-delimited JSON, an
  auth line first or the socket closes, a 2 s auth deadline and a 1 MB line
  cap. The secret is compared with a constant-time equality, and lives only in
  the launcher process and that file.
- `ipc/messages.ts` gains `Invoke`, the eighth message. `ChildHandle.invoke`
  forwards; `run-child.ts` answers it by building the envelope itself.
- `src/mcp/client.ts` — the control protocol's client half, separate so the
  protocol can be tested without an MCP client and so the one file that reads
  the secret is short.
- `src/mcp/server.ts` — the MCP server. One tool per `read` or `write`
  operation, named with the route's dot replaced by `_`, described by the
  route's summary, with the exported JSON Schema as its input schema and
  `readOnlyHint`/`destructiveHint` annotations.
- `src/launcher/keepalive.ts` — `serve` restarts a crashed child from
  `current`, at most three times in a minute.

`@modelcontextprotocol/sdk` at **1.30.0**, added to `packages/broapp-autoapp`
and to the root `devDependencies` (the tests live in `tests/`, outside that
workspace, exactly as `react` was added in prompt 05).

## Decisions

1. **The low-level `Server`, not `McpServer`.** The `.d.ts` wins, and
   `server/mcp.d.ts`'s `registerTool` types its handler against a Zod shape.
   The tools here are built at runtime from an exported JSON Schema, which has
   no Zod shape to give it. `Server` with `ListToolsRequestSchema` and
   `CallToolRequestSchema` takes the schema as data, which is what a contract
   loaded from a release actually is.

2. **`external` operations are not offered at all, not offered-and-refused.**
   Listing a tool that always fails teaches an agent to keep trying. The
   server's `instructions` say the category exists and is not available.

3. **Annotations are hints and the comment says so.** The specification calls
   them untrusted hints. A client that ignores every one of them gets exactly
   the same answers, because the gate is on the other end of the connection.

4. **The channel is set in the child, from the door the message came through.**
   `grep -rn "channel: 'mcp'"` has one hit, `run-child.ts:359`. Nothing the
   client sends is consulted when the envelope is filled in — the `client`
   name only becomes `caller`, which is a label, never a permission.

5. **A refusal with no tab open says why.** The gate refuses a write the same
   way whether a person declined or nobody was asked; it cannot tell the
   difference. The child can, and appends the explanation at the reply. This
   is at the boundary, after the gate has decided and written its `denied`
   row — not a second path, and not a loosened check.

6. **A dead child wakes its waiters.** `Channel.waitFor` now also rejects when
   the child exits, with `unavailable`. Without it an MCP call that was waiting
   on a person when the child died sat out the whole forwarding deadline.
   Checked after the inbox, so a reply that arrived just before the exit is
   still delivered.

7. **`serve` restarts a crashed child.** Prompt 05 did not, and with a control
   socket in the picture a dead child means an agent talking to a launcher that
   answers `unavailable` forever. Three restarts in a minute, then it is left
   stopped and reported — a crash loop is a broken release, and hiding it
   behind a tab that keeps reappearing is worse than stopping.

8. **The restart prints a new address.** A restarted child has a new port and a
   new one-time launch token; the tab that was open is talking to a process
   that no longer exists. Reconnecting it is a later prompt's problem; saying
   so is this one's.

## The manual run

**Deviation:** the prompt suggests Claude Desktop or `claude mcp add`. Both
write to the user's own MCP client configuration, which is not this task's to
change. Instead a real MCP `Client` from the same SDK drove the real compiled
`broapp-autoapp mcp notes` over a real `StdioClientTransport`, against a real
`serve` with the Notes tab open in a browser. Everything below the client is
the path the prompt describes, byte for byte.

`bun run --cwd packages/broapp-autoapp build:launcher` → `dist/broapp-autoapp`.

| Step | What happened |
|---|---|
| `import ./examples/notes --as notes --grant` | git repository initialised; release `3592cd1c…` |
| `serve notes --no-open`, tab opened | Notes, "Connected"; `launcher.json` written, mode `600`, `{"v":1,"port":50218,"secret":"692246b7…","pid":9767}` |
| MCP client connects | `server: {"name":"broapp-autoapp:notes","version":"0.1.0"}`, instructions as written |
| `tools/list` | `notes_list`, `notes_get`, `notes_status` with `readOnlyHint: true`; `notes_create`, `notes_update`, `notes_remove`, `notes_backup` with `destructiveHint: true` — all seven of Notes' operations, because Notes has no `external` one to leave out |
| `notes_list` | `{"notes": []}` — no approval asked, no tab involvement |
| `notes_create {"title":"From an agent","body":"over MCP"}` | the strip in the Notes tab: **claude-code-manual — an agent in another program, over MCP** wants to run `notes.create` (write), with the arguments as JSON |
| Approve | the call returned the new note; `notes_list` then showed it |
| Close the tab, call `notes_create` again | `isError: true`, `notes.create was not approved: no browser tab is open for this application, so nobody could be asked. Open it with `broapp-autoapp serve`.` |
| `notes_list` with no tab | still succeeded — a read needs nobody |
| `runs.sqlite` | `mcp` / `mcp:claude-code-manual`: `notes.create · confirmed · succeeded`, then two `notes.create · denied`, and the reads `allowed · succeeded` |
| The secret | not in `runs.sqlite`, not in any log, not in `journal.sqlite`; `grep` of the 64-character value across the whole run root's applications found nothing |
| `serve` exits | `launcher.json` gone |

The configuration a person pastes into their own client is unchanged from the
prompt:

```json
{ "command": "/path/to/broapp-autoapp", "args": ["mcp", "notes"] }
```

## Commands run

```
bun run typecheck                            exit 0
bun test tests/autoapp-mcp.test.ts           16 pass, 0 fail
bun test tests                               421 pass, 0 fail (28 files)
bun run --cwd packages/broapp-autoapp build:launcher   exit 0
bun run check                                exit 0
cd examples/notes && bunx tsc --noEmit       exit 0
cd examples/notes && bun test tests          23 pass, 0 fail
```

## Acceptance criteria

- **No path from an MCP client to an operation bypasses `Gate.guard`; the only
  entry is `app.invoke` with channel `mcp`, and `grep -rn "channel: 'mcp'"`
  shows exactly one site, in `run-child.ts`** — pass, one hit at
  `run-child.ts:359`. A test asserts the grep itself, over the shipped sources,
  so a second site fails the suite rather than a review.
- **The control secret never crosses IPC and never appears in a log or a run
  record** — pass. The launcher authenticates the connection and forwards only
  `{ route, input, client, requestId }`; `ipc/messages.ts` says so in a comment
  where the next person will read it. Confirmed by grep over the manual run's
  databases and logs.
- **`external` operations are not offered to MCP clients** — pass, filtered in
  `offerable()` and asserted with a fixture contract that has one. The manual
  run does not prove this: Notes has no `external` operation, so its
  `tools/list` would look the same either way. The test is the evidence.

## For a later prompt

- A restarted child is unreachable from the tab that was open. The launcher
  knows the new address and could hand it to a page that reconnects; today it
  prints it.
- `notes.backup` writes a file and is a `write`, so it is offered. Whether a
  file-writing operation should be reachable from another program at all is a
  question the effect vocabulary does not currently ask.
