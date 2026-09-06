# Common rules for every Autoapp prompt

Read this file completely before starting any numbered prompt. These rules
override anything you remember about how Broapp, Brobridge, Bun or the AI
SDK "usually" work.

## 1. What you are building

Autoapp turns a Broapp application into one its owner can reshape while
using it. An AI engineer, running in the host, proposes changes to the
application's specification and code; the change is built as a candidate
release, previewed on a copy of the user's data, and activated with a
recovery path. External agents reach the same operations through an MCP
adapter that passes the same gate.

Everything is built on the existing Broapp packages. Brobridge stays
unchanged. The single-document, hash-pinned-CSP page model stays unchanged.

Fixed decisions. Do not reopen them. If a later prompt seems to contradict
one, the prompt is wrong; follow this table and say so in your report.

| Decision | Value |
|---|---|
| Branch | `autoapp`. Every commit goes here. Never commit to `main`. Never merge. |
| New package | `packages/broapp-autoapp`, npm name `broapp-autoapp`, version `0.1.0`, private until prompt 09 says otherwise. Depends on `broapp` (`workspace:*`). Added to the root workspace by the existing `packages/*` glob; nothing to change in the root `package.json` `workspaces`. |
| Core changes allowed | In `packages/broapp` only: the `effect` field on `OperationSpec` and `StreamSpec`; the execution gate under `src/host/gate.ts` and `src/host/approvals.ts`; `runOperation` and `runStream` in `src/host/app.ts` calling the gate; `fromContract` deriving permission from `effect`; `RESERVED_GROUPS` gaining `autoapp` (prompt 04); `RunningApp` exposing `attached` and `Gate` gaining `pause`/`resume` (prompt 05); new exports in `src/host/index.ts` and `src/shared/index.ts`. Nothing else in `packages/broapp` changes unless a prompt names the file. |
| Untouchable | Brobridge options, the CSP in `build-page.ts`, the route table, loopback binding, `open-browser.ts`, the generator, `tests/dependencies.test.ts`, `tests/ai-chat.test.ts`. |
| Presentation | A launcher process manages applications. Each application runs as its own child process, its own Brobridge bridge, its own top-level browser tab. No iframes. The launcher never proxies application operations; it supervises lifecycle only. |
| Generated browser code | None, ever. The browser runs the pinned renderer (`broapp-autoapp/react`) over a declarative view specification. A view specification contains no JavaScript expressions and no raw HTML. |
| Generated host code | Allowed, inside a candidate release, run by a child process. In v1 that child is **trusted local code**: crash-isolated, not permission-isolated. Every document, comment and UI string describes it that way. The words "sandbox" and "isolated" are not used for it. |
| Effect classification | Every operation and stream may carry `effect: 'read' \| 'write' \| 'external'`. `read` changes nothing. `write` changes local data. `external` reaches outside the machine or the data directory (network, other files, spawned processes, mail). In core Broapp a missing `effect` is treated as `write`, so existing contracts and `tests/ai-chat.test.ts` keep working unchanged. An Autoapp application specification (prompt 03) refuses a route without an explicit `effect`. |
| Policy, v1 | Three rows, in `src/host/gate.ts`. Channel `user`: allow every effect. Channels `ai`, `mcp`, `workflow`: allow `read`; require confirmation for `write` and `external`. Mode `preview`: refuse `external` for every channel. No policy language, no configuration file. |
| Approval identity | An approval binds to `{ requestId, appId, releaseId, route, argumentsHash }`. It is consumed once, expires after `confirmTimeoutMs`, and an answer that names a different `releaseId` or `argumentsHash` than the pending question is a mismatch and counts as a denial. |
| Channel identity | The `channel` and `caller` of a request are set by the trusted adapter that received it (the bridge handler, the AI runner, the MCP adapter, the workflow runner). They are never read from model output, tool arguments, or anything a browser or MCP client sent. |
| Release identity | `releaseId` = `sha256` of the built page bytes, the host bundle bytes and the exported contract JSON, hex, lowercase, first 32 characters. Computed by the build, stored in the manifest, reported by the child on `hello`. A running application with no candidate loop has exactly one release. |
| Data layout | The launcher's own data directory is `ensureDataDir('broapp-autoapp')`, called `<root>` below. `<root>/apps/<appId>/releases/<releaseId>/` is an immutable release (page, host bundle, spec). `<root>/apps/<appId>/source/` is the candidate workspace, a git repository. `<root>/apps/<appId>/data/` is the live data directory, passed to the child as `BROAPP_DATA_DIR`; `data-next/` and `data-prev-<timestamp>/` are the other halves of a pair during activation. `<root>/apps/<appId>/snapshots/` holds consistent database copies. `<root>/apps/<appId>/current` names the active release. `<root>/journal.sqlite` is the launcher's activation journal. `runs.sqlite` lives **inside** each application's data directory and is owned by the child, so a preview child records into the copy and a live child into the real one. `<root>/launcher.json` (mode 0600) holds the launcher's loopback control port and secret for MCP processes. |
| Where the engineer lives | In the launcher's own browser tab, which is itself a Broapp application with the AI layer. The application's tab keeps the existing `AiChat` for using the application. The launcher never runs application code in its own process: building, migrating and previewing all happen in child processes. |
| IPC | `Bun.spawn` with `ipc`. Six lifecycle messages: `hello`, `ready`, `health`, `drain`, `shutdown`, `fatal`. Prompt 05 adds `migrate` (launcher asks a child to migrate a data copy and report). Prompt 08 adds `invoke` (launcher forwards one MCP call to the child, which runs it through its gate with channel `mcp`). No other messages. Every message has `{ v: 1, id, type, ... }`. Unknown `v` is rejected with `fatal` and exit code 3. The launcher kills a child that has not answered `shutdown` within its deadline. |
| SQLite snapshots | `bun:sqlite` only. A snapshot is `VACUUM INTO` on an open connection, or the backup API where the prompt says so. Never a file copy of the main database while a connection may be writing. |
| Migrations | Forward only. `down` is not required and not modelled. Rollback before the new release has accepted a write is a pair switch; after that, it is a compatible downgrade, a forward repair, or an explicitly approved restore that discards later writes. The activation journal records which of those the user is in. |
| Run outcomes | `succeeded`, `failed`, `cancelled`, `unknown`. A step whose external effect was in flight when the process died is `unknown`. Nothing with an `unknown` step is replayed automatically. |
| Workflow promotion | Promoting a workflow to a feature adds a named action or form to the view specification. It does not generate host code. |
| Offline tiers | Run offline: installed features needing only local resources work. Edit offline: the packaged tooling and packaged dependencies support changes; AI help needs a local model. Extend dependencies offline: only explicitly packaged dependencies are available. Documented only once tested. |
| AI engine | Unchanged from the AI layer: `ai@7.0.93`, adapters via `broapp/ai/host`. No new provider packages. |
| MCP | `@modelcontextprotocol/sdk`, exact version pinned by prompt 08 after reading its `.d.ts`. Stdio transport only. |

## 2. Repository conventions you must follow

- Bun ≥ 1.4, TypeScript strict, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`. Relative imports carry the `.ts` / `.tsx`
  extension. Named exports only.
- Run everything with `bun`. Never `npm`, `npx`, `node`, `yarn`, `pnpm`.
- Framework tests live in `tests/` at the repository root, use `bun:test`,
  and run with `bun test tests`. Real-bridge tests use `tests/harness.ts`;
  read it before writing one. Autoapp tests are named `tests/autoapp-*.test.ts`.
- Tests must not use the network. Mock `fetch` by passing a `fetch` function
  in, never by patching `globalThis.fetch`.
- Tests that spawn processes clean them up in `afterEach`, always, including
  on failure. A test that leaks a child fails the prompt.
- Tests that touch disk use a fresh directory under `mkdtempSync(join(tmpdir(), 'autoapp-'))`
  and remove it in `afterEach`.
- Comments explain *why*, in full sentences. Match the tone of
  `packages/broapp/src/host/app.ts`.
- Errors that reach a browser or an agent are `PublicError` (from
  `broapp/host`) with one of the existing codes: `invalid_input`,
  `not_found`, `conflict`, `unavailable`, `rejected`. Do not add codes.
- Do not add dependencies beyond the ones the prompt lists.
- No `any`. No `// @ts-ignore`. No `eslint-disable` except the one pattern
  already used in `hooks.tsx` for the connection effect.
- `bun build --compile --bytecode` rejects top-level `await`. Every host
  entry point keeps `await` inside functions. Copy the `main().then(...)`
  shape from `examples/notes/src/host/main.ts`.
- Secrets are never returned to a browser, never logged, never in a
  `PublicError` message, never in a run record, never in a journal row.

## 3. Verifying third-party APIs

Do not write Bun, Brobridge, `bun:sqlite`, AI SDK or MCP SDK calls from
memory. Before writing any such call:

1. Open the relevant declaration file and search inside it:
   - Bun: `node_modules/bun-types/bun.d.ts` (search `spawn(`, `ipc`,
     `Subprocess`, `Bun.build(`, `BuildConfig`).
   - `bun:sqlite`: `node_modules/bun-types/sqlite.d.ts`.
   - Brobridge: `node_modules/brobridge/dist/index.d.ts`,
     `node_modules/@brobridgejs/core/dist/index.d.ts`,
     `node_modules/@brobridgejs/client/dist/index.d.ts`.
   - AI SDK: `node_modules/ai/dist/index.d.ts`.
   - MCP SDK: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts`
     and `.../server/mcp.d.ts` and `.../server/stdio.d.ts`.
2. Confirm the exact export name, parameter names and return shapes.
3. If a name in a prompt differs from the `.d.ts`, **the `.d.ts` wins**.
   Note the difference in your report.

## 4. Working method

1. Run `git branch --show-current`. If it is not `autoapp`, stop.
2. Read the files the prompt lists under "Read first", completely.
3. Read `prompts/autoapp/reports/*.md` written by earlier prompts.
4. Write a five-line plan in your first message: files you will create,
   files you will modify, tests you will add. Then start.
5. Implement in the order the prompt gives. Run the prompt's verification
   commands after each numbered step, not only at the end.
6. When a verification command fails, fix the cause. Do not delete or skip
   the test. Do not loosen an assertion to make it pass.
7. When done, run the full gate:

   ```bash
   bun install
   bun run check
   ```

   Both must exit 0.

8. Write the report file the prompt names. Include: what was built, every
   deviation from the prompt and why, exact commands run and their final
   status lines, open questions, and the acceptance criteria of the prompt
   with a pass or fail against each. Keep it under 100 lines.
9. Commit with the message the prompt gives. One commit per prompt, on
   `autoapp`.

## 5. When you are unsure

- If a prompt's instruction conflicts with a file in the repository, the
  repository is right about how things work today, the prompt is right about
  what to build. Report the conflict.
- If something needs a design decision the prompt did not make, choose the
  option that changes the fewest existing files, and write the decision in
  the report under "Decisions I made".
- Never ask the user a question mid-task. Decide, record, continue.
- Never stub a feature with a `TODO` and call the prompt done. If a part
  cannot be finished, finish everything else, then say so in the report.
- Never weaken a security property to make a test pass. If a test can only
  pass by loosening the trust fence, the CSP, the gate or an approval
  check, the test is wrong or the design is wrong; stop and report.

## 6. Facts already established

- `bun build --compile` binaries can run other scripts: with the environment
  variable `BUN_BE_BUN=1` the binary behaves as the plain `bun` CLI. Verified
  on macOS with Bun 1.4.0: `--version`, `add`, and script execution all
  work. Nothing else is verified; prompt 02 verifies the rest.
- A compiled binary can `await import(absolutePath)` of a file outside the
  bundle, and can call `Bun.build()` at runtime. Verified on macOS only.
- Brobridge splits a route on its **last** dot and refuses a service name
  containing a dot. Routes are `group.member` with exactly one dot;
  `defineContract` enforces this.
- Brobridge's trust fence allows only `Sec-Fetch-Site: same-origin` or
  `none`. A page on any other origin, including another loopback port,
  cannot frame or fetch a Broapp application. This is why there are no
  iframes in this design.
- `HostApp.invoke` exists and validates like a bridge call, but the bridge
  path calls `runOperation` directly, streams go through `runStream`, and
  hand-written `AiTool`s own their `execute`. Wrapping `invoke` alone
  gates nothing. Prompt 01 fixes this.
- The AI layer's confirmations are keyed by `runId` and `callId` inside one
  `Ai` instance. They are not a general approval authority. Prompt 01
  replaces them with one that is.
- Chat history lives in the browser and is sent with every `ai.chat` call.
  The host persists nothing about a run today. Prompt 06 adds the store.
