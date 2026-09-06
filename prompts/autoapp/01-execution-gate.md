# 01 — The execution gate

## Goal

Every mutation of an application, from any channel, passes one gate. After
this prompt: operations and streams carry an `effect`; `HostApp` owns a
`Gate`; the bridge path, `invoke`, the AI runner's tools and (later) the MCP
and workflow adapters all go through `Gate.guard`; approvals are bound to a
request, a release and an arguments hash, consumed once, and expire. The
existing chat confirmation flow keeps working, over the gate, with
`tests/ai-chat.test.ts` untouched.

This prompt changes `packages/broapp` only. No new package yet.

## Read first

- `prompts/autoapp/00-common-rules.md`, completely.
- `packages/broapp/src/shared/contract.ts`, `schema.ts` (find `toJsonSchema`), `errors.ts`, `index.ts`.
- `packages/broapp/src/host/app.ts`, completely. Note `runOperation`, `runStream`, `invoke`, `CallContext`, `mount`.
- `packages/broapp/src/host/index.ts`.
- `packages/broapp/src/ai/host/tool.ts`, `from-contract.ts`, `run.ts` (all of it), `create-ai.ts`, `index.ts`.
- `packages/broapp/src/ai/shared/types.ts` (`ToolPermission`, `ChatEvent`) and `contract.ts` (`ai.chatConfirm`).
- `tests/harness.ts`, `tests/bridge.test.ts`, `tests/ai-chat.test.ts` (read only; you may not change it).
- `examples/notes/src/shared/contract.ts` and `examples/notes/src/host/ai.ts`.
- `docs/security.md` and `docs/ai.md`, so the new document matches their tone.

## Step 1 — `effect` on the contract

In `packages/broapp/src/shared/contract.ts`:

```ts
/**
 * What an operation or stream does to the world.
 *
 * `read` changes nothing. `write` changes data inside the application's data
 * directory. `external` reaches outside it: the network, other files, a
 * spawned process, mail. The gate decides from this and from who is asking
 * whether a call runs, waits for a person, or is refused. A route that does
 * not say is treated as `write`, which asks a person before an agent may
 * run it and lets the owner's own click through.
 */
export type Effect = 'read' | 'write' | 'external';

export interface OperationSpec<I = unknown, O = unknown> {
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly summary?: string;
  readonly effect?: Effect;
}

export interface StreamSpec<P = unknown, E = unknown> {
  readonly params: Schema<P>;
  readonly event: Schema<E>;
  readonly summary?: string;
  readonly effect?: Effect;
}

/** The effect a route declares, or the conservative default. */
export function effectOf(spec: { readonly effect?: Effect }): Effect {
  return spec.effect ?? 'write';
}
```

`defineContract` validates the value when present: anything other than the
three strings is a `TypeError` at definition time, naming the route.

Export `Effect` and `effectOf` from `packages/broapp/src/shared/index.ts`.

Add `effect` to every route in `examples/notes/src/shared/contract.ts`:
`notes.list` and `notes.status` are `read`; `notes.create`, `notes.update`,
`notes.remove` are `write`; `notes.backup` is `write` (it writes inside the
data directory). Do not touch the other examples or the templates in this
prompt.

## Step 2 — `packages/broapp/src/host/gate.ts`

Create it. The exact public surface:

```ts
import { createHash } from 'node:crypto';
import type { Effect } from '../shared/contract.ts';
import type { HostLogger } from './app.ts';

export type Channel = 'user' | 'ai' | 'mcp' | 'workflow';
export type ExecutionMode = 'live' | 'preview';
export type Decision = 'allowed' | 'confirmed' | 'denied' | 'refused';
export type Outcome = 'succeeded' | 'failed' | 'cancelled';
export type PolicyVerdict = 'allow' | 'confirm' | 'refuse';

/**
 * Who is asking, on behalf of what, and how the answer may be obtained.
 *
 * Built by the trusted adapter that received the request — the bridge
 * handler, the AI runner, the MCP adapter, the workflow runner — and never
 * from anything a model, a browser or an MCP client sent. That is the whole
 * basis of the policy: a model cannot claim to be the user.
 */
export interface Envelope {
  /** Unique per request. Correlates the question, the answer and the record. */
  readonly requestId: string;
  readonly channel: Channel;
  /** Free text for records: 'tab', 'ai:<runId>', 'mcp:<client>', 'workflow:<id>'. */
  readonly caller: string;
  /** May only tighten the gate's default: `preview` wins over `live`. */
  readonly mode?: ExecutionMode;
  readonly signal?: AbortSignal;
  /** Who to ask when the policy says `confirm`. Absent means nobody, so denied. */
  readonly approver?: Approver;
}

export interface GuardRequest extends Envelope {
  readonly route: string;
  readonly effect: Effect;
  /** Already validated by the contract. Shown to the approver and hashed. */
  readonly input: unknown;
}

export interface ApprovalQuestion {
  readonly requestId: string;
  readonly channel: Channel;
  readonly caller: string;
  readonly appId: string;
  readonly releaseId: string;
  readonly route: string;
  readonly effect: Effect;
  readonly input: unknown;
  readonly argumentsHash: string;
}

export interface Approver {
  /**
   * Ask a person. Resolves `true` only for an approval that names this
   * question. Must resolve `false` when `signal` aborts.
   */
  ask(question: ApprovalQuestion, signal: AbortSignal): Promise<boolean>;
}

export interface ExecutionRecord extends ApprovalQuestion {
  readonly mode: ExecutionMode;
  readonly decision: Decision;
  readonly outcome?: Outcome;
  /** A sentence safe to show. Never a stack, never a secret. */
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface Recorder {
  record(record: ExecutionRecord): void;
}

export interface GateOptions {
  readonly appId: string;
  readonly releaseId: string;
  readonly recorder?: Recorder;
  /** Default 120_000. */
  readonly confirmTimeoutMs?: number;
  /** Default 'live'. A preview child passes 'preview'. */
  readonly mode?: ExecutionMode;
  readonly logger?: HostLogger;
}

export interface Gate {
  readonly appId: string;
  readonly releaseId: string;
  readonly mode: ExecutionMode;
  /**
   * Decide, ask if needed, record, run.
   *
   * Throws `PublicError` with code `rejected` when the policy refuses or a
   * person declines, times out or the request is cancelled while waiting.
   * `run` is called at most once and only after an allow or a confirmed
   * approval.
   */
  guard<T>(request: GuardRequest, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** The whole v1 policy. Pure, exported so the table can be tested row by row. */
export function decide(channel: Channel, effect: Effect, mode: ExecutionMode): PolicyVerdict;

/** Canonical JSON (object keys sorted at every depth) hashed with sha256, hex, first 32 characters. */
export function argumentsHash(input: unknown): string;

export function createGate(options: GateOptions): Gate;
```

`decide` is exactly:

| channel | effect | live | preview |
|---|---|---|---|
| user | read | allow | allow |
| user | write | allow | allow |
| user | external | allow | refuse |
| ai, mcp, workflow | read | allow | allow |
| ai, mcp, workflow | write | confirm | confirm |
| ai, mcp, workflow | external | confirm | refuse |

`guard` in order:

1. Effective mode is `preview` if either the gate's or the request's mode is
   `preview`.
2. `decide`. On `refuse`: record `{ decision: 'refused' }`, throw
   `publicError.rejected('<route> is not allowed in preview')`.
3. On `confirm`: if `request.approver` is absent, record `denied`, throw
   `publicError.rejected('<route> needs approval and nobody can give it')`.
   Otherwise build the question, create a signal that aborts on
   `request.signal` or after `confirmTimeoutMs`, and `await approver.ask`.
   `false` → record `denied` (outcome `cancelled` when the request signal
   aborted, otherwise no outcome), throw `publicError.rejected('<route> was
   not approved')`.
4. Record `startedAt`, call `run(signal)` where `signal` is the request's
   or a never-aborting one. On resolve record `succeeded`; on reject record
   `failed` with `error` = the `PublicError` message if it is one, else the
   fixed `INTERNAL_ERROR_MESSAGE` from `errors.ts`; if the signal aborted,
   `cancelled`. Rethrow unchanged.
5. `decision` is `allowed` for a policy allow, `confirmed` for an approval.

The recorder is called synchronously and its throw is caught and logged,
never propagated: a broken recorder must not block the application.

## Step 3 — `packages/broapp/src/host/approvals.ts`

The reusable table an adapter uses to build an `Approver` whose answers
arrive later over some route. This replaces `createConfirmations` in
`ai/host/tool.ts`, which you delete.

```ts
export interface ApprovalAnswer {
  readonly requestId: string;
  readonly approved: boolean;
  /** When given, must equal the pending question's value or the answer is a mismatch. */
  readonly releaseId?: string;
  readonly argumentsHash?: string;
}

export type AnswerResult = 'accepted' | 'unknown' | 'mismatch';

export interface PendingApprovals extends Approver {
  /** Called by the route that receives the person's answer. */
  answer(answer: ApprovalAnswer): AnswerResult;
  /** Questions currently waiting, for a UI to show. Never includes `input` for `external` routes' secrets — input is shown as-is; adapters must not put secrets in inputs. */
  readonly pending: readonly ApprovalQuestion[];
}

export function createPendingApprovals(logger?: HostLogger): PendingApprovals;
```

Rules: `ask` stores the question under `requestId` and resolves when
`answer` arrives or `signal` aborts (as `false`). `answer` with an unknown
`requestId` returns `unknown` and changes nothing. A mismatch on
`releaseId` or `argumentsHash` resolves the pending question as `false`,
removes it, logs one `warn` line naming the route and which field differed,
and returns `mismatch`. A second answer for the same `requestId` returns
`unknown`. A `requestId` already pending when `ask` is called again is a
programming error: throw `TypeError`.

## Step 4 — wire `HostApp` through the gate

In `packages/broapp/src/host/app.ts`:

- `HostAppOptions` gains `readonly gate?: Gate`. When absent, create one
  with `appId: 'app'`, `releaseId: 'unreleased'`, no recorder, mode `live`.
- `HostApp` gains `readonly gate: Gate`.
- `CallContext` gains `readonly requestId: string; readonly channel: Channel; readonly caller: string; readonly mode: ExecutionMode;`.
- `runOperation(route, raw, envelope: Envelope)`: parse input as today,
  then `gate.guard({ ...envelope, route, effect: effectOf(spec), input }, () => handler(input, context))`,
  then check output as today. Validation errors still surface before the
  gate; a call that fails validation is never recorded, because nothing was
  asked.
- The bridge path (inside `mount`) builds the envelope:
  `{ requestId: crypto.randomUUID(), channel: 'user', caller: 'tab' }`.
- `invoke(name, input, envelope: Envelope)`: the envelope is **required**.
  Update the type in the interface and its doc comment.
- `runStream`: after parsing params and before calling the handler, guard
  with `channel: 'user'`, `caller: 'tab'`, `requestId: crypto.randomUUID()`,
  `effect: effectOf(spec)`, `input: params`. The `run` callback is the
  existing handler invocation; the stream's abort signal is the request
  signal.

Export from `packages/broapp/src/host/index.ts`: `createGate`, `decide`,
`argumentsHash`, `createPendingApprovals`, and the types `Gate`,
`GateOptions`, `Envelope`, `GuardRequest`, `Channel`, `ExecutionMode`,
`Decision`, `Outcome`, `PolicyVerdict`, `Approver`, `ApprovalQuestion`,
`ApprovalAnswer`, `AnswerResult`, `PendingApprovals`, `ExecutionRecord`,
`Recorder`.

## Step 5 — the AI layer over the gate

In `packages/broapp/src/ai/host/tool.ts`:

- `AiTool` loses `permission` and gains `readonly effect: Effect`.
- `execute(input: unknown, envelope: Envelope, signal: AbortSignal): Promise<unknown>`.
- Delete `Confirmations` and `createConfirmations`.
- Add a brand: `export const GUARDED: unique symbol = Symbol('broapp.guarded')` and
  `export interface GuardedTool extends AiTool { readonly [GUARDED]: true }`.
- Add `guardedTool(gate: Gate, tool: { description, inputSchema, effect, run(input, signal) }): GuardedTool`
  whose `execute` calls `gate.guard({ ...envelope, route: name, effect, input }, (signal) => run(input, signal))`.
  The tool's name is passed by the caller of `guardedTool` as the first
  field of the tool object (`name: string`), used as `route` in records.

In `from-contract.ts`:

- Keep the `ContractToolAllowList` shape (`read`, `confirm`) so existing
  callers compile. The lists now **select** which operations become tools.
  The permission the browser sees is derived from the route's effect: `read`
  when `effectOf(spec) === 'read'`, else `confirm`. If a route is listed
  under `confirm` but declares `effect: 'read'`, or listed under `read` but
  declares `write` or `external`, throw `TypeError` at startup naming the
  route and both values. When the route declares no `effect`, the list it
  sits in decides: `read` list → treated as `read`; `confirm` list → `write`.
  This is what keeps `tests/ai-chat.test.ts` valid without a change.
- Each produced tool is a `GuardedTool` whose `execute` is
  `(input, envelope, signal) => app.invoke(route, input, { ...envelope, signal })`.
  `invoke` guards; the tool does not guard again.

In `create-ai.ts`:

- Refuse any tool in `options.tools` that lacks the `GUARDED` brand:
  `TypeError('tool "<name>" does not pass the gate; build it with guardedTool()')`.
- Replace `createConfirmations()` with `createPendingApprovals(logger)`.
  `ai.chatConfirm` calls `approvals.answer({ requestId: \`${runId}:${callId}\`, approved: approve })`
  and returns `{ accepted: result === 'accepted' }` — same wire shape as
  today. Do not change the `ai.chatConfirm` route's input schema.

In `run.ts`:

- Remove the permission dance from `buildTools`. For each tool: emit
  `tool-call` with `permission` derived from `effect` as above (so the
  browser's event shape is unchanged), then call
  `definition.execute(input, envelope, sink.signal)` where the envelope is
  `{ requestId: \`${runId}:${callId}\`, channel: 'ai', caller: \`ai:${runId}\`, signal: sink.signal, approver }`.
- The `approver` is built once per run: an `Approver` whose `ask` emits
  the `confirm` event (`callId`, `tool`, `input`, exactly as today) and then
  awaits `approvals.ask(question, signal)`. The `confirm` event may
  additionally carry `requestId`, `releaseId` and `argumentsHash`; add these
  three as optional fields to `ChatEvent` in `ai/shared/types.ts` and to
  the event schema in `ai/shared/contract.ts`. Adding optional fields keeps
  the existing test's `toMatchObject` assertions valid.
- A `rejected` `PublicError` from `execute` is the declined path: emit
  `tool-result` with `output: DECLINED, denied: true` and return `DECLINED`
  so the model is told, exactly as today. Any other error is the existing
  failure path.

Update `ai/host/index.ts` exports: remove `Confirmations`, add `guardedTool`,
`GUARDED`, `GuardedTool`.

Update `docs/ai.md` where it describes `permission`, `Confirmations` or
hand-written tools, so the document matches the code.

## Step 6 — `docs/autoapp/design.md`

Write it from the decisions table in `00-common-rules.md`, in the voice of
`docs/architecture.md`. Sections: what Autoapp is; the seven parts
(launcher, application child, Brobridge, renderer, specification, engineer,
gate); the gate (channels, effects, the policy table, approval identity,
what it does not protect against — an unrestricted child); release
identity; the candidate-and-activation loop in eight steps; the rollback
boundary; what v1 calls trusted local code and why; offline tiers, marked
"untested until prompt 09". Under 250 lines. Link it from `docs/architecture.md`
in one sentence at the end of "Four layers, and who owns what".

## Step 7 — tests

`tests/autoapp-gate.test.ts`, with `bun:test`. Every case below is
required. Use `confirmTimeoutMs: 50` where a timeout is involved.

1. `decide` returns the table above for all 24 `(channel, effect, mode)` rows. Write the expected table in the test as data; do not derive it.
2. `argumentsHash` is identical for `{a:1,b:{c:2,d:3}}` and `{b:{d:3,c:2},a:1}`, and differs when a leaf changes. Length 32, lowercase hex.
3. `user` + `write` runs with no approver. Record has `decision: 'allowed'`, `outcome: 'succeeded'`.
4. `ai` + `read` runs with no approver.
5. `ai` + `write` with no approver: `run` never called, throws `PublicError` code `rejected`, record `denied`.
6. `ai` + `write`, approver answers `approved: true`: `run` called once, record `confirmed` / `succeeded`.
7. Approver answers `approved: false`: `run` not called, `rejected`, record `denied`.
8. Nobody answers: rejected after the timeout, `run` not called.
9. Request signal aborts while waiting: rejected, record `denied` with `outcome: 'cancelled'`.
10. Answer carries a wrong `argumentsHash`: `answer` returns `'mismatch'`, guard rejects, `run` not called, one `warn` logged.
11. Answer carries a wrong `releaseId`: same as 10.
12. Second answer for the same `requestId` returns `'unknown'`; the first decision stands.
13. Two pending requests; answering the second runs only the second; the first then times out.
14. `ask` for a `requestId` already pending throws `TypeError`.
15. Gate in `preview`: `user` + `external` refused with `rejected`; `ai` + `external` refused without asking the approver (approver's `ask` never called).
16. Envelope `mode: 'preview'` on a `live` gate tightens; envelope `mode: 'live'` on a `preview` gate does not loosen.
17. `run` throws a `PublicError`: rethrown unchanged, record `failed` with that message. `run` throws a plain `Error`: record `error` is `INTERNAL_ERROR_MESSAGE`.
18. A recorder that throws does not fail the call; one `error` line is logged.
19. Over the real harness: an operation with `effect: 'external'` on an app whose gate is `preview` answers a client call with a `rejected` error, and the handler is not invoked. The same operation on a `live` gate runs. Same pair for a stream with `effect: 'external'`.
20. `invoke` with `channel: 'ai'` on a `write` route and no approver rejects; with an approver that approves, runs.
21. `createAi` with a hand-written tool that is not `guardedTool(...)` throws `TypeError`; with `guardedTool(...)` it starts.
22. `fromContract` throws when a route listed under `confirm` declares `effect: 'read'`, and when a route under `read` declares `write`.
23. `tests/ai-chat.test.ts` passes unmodified. Run it by name and paste the result line into the report.

Existing tests that construct `AiTool`s or call `invoke` must be updated for
the new signatures; list each in the report.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-gate.test.ts
bun test tests/ai-chat.test.ts
bun test tests
cd examples/notes && bunx tsc --noEmit && bun run build && cd ../..
bun run check
```

All exit 0. `git diff --stat tests/ai-chat.test.ts tests/dependencies.test.ts`
prints nothing.

## Acceptance criteria

- Every bridge call, `invoke`, stream start and AI tool call reaches
  `Gate.guard`. Prove it: temporarily make `guard` throw, run the suite,
  observe that the bridge, invoke, stream and chat tests all fail, then
  restore. Say in the report that you did this.
- A model cannot set its own channel: `Envelope` is built only in
  `app.ts` (bridge path), `run.ts` (AI) and tests. `grep -rn "channel: '" packages/broapp/src` lists only those files.
- All 23 test cases present and green.
- `tests/ai-chat.test.ts` and `tests/dependencies.test.ts` unchanged.

## Report

`prompts/autoapp/reports/01-gate.md`. Include the `grep` output from the
acceptance criteria and the list of tests you had to update.

## Commit

```
Add the execution gate and effect classification

Every operation and stream may declare an effect. One gate decides, from
the effect and the channel that asked, whether a call runs, waits for a
person, or is refused, and records what happened. The bridge path,
invoke, streams and AI tools all pass through it. Approvals bind to a
request, a release and an arguments hash, and are consumed once.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
