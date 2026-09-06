# 01 — The execution gate

## What was built

- `packages/broapp/src/shared/contract.ts`: `Effect`, `effect` on
  `OperationSpec` and `StreamSpec`, `effectOf`, and validation of the value in
  `defineContract`. Exported from `broapp/shared`.
- `packages/broapp/src/host/gate.ts`: `decide`, `argumentsHash`, `createGate`
  and the types. The policy is the table the prompt gives, expressed as four
  lines rather than a lookup.
- `packages/broapp/src/host/approvals.ts`: `createPendingApprovals`, with
  release and arguments-hash binding, once-only consumption, and `TypeError` on
  a duplicate pending `requestId`.
- `packages/broapp/src/host/app.ts`: `HostApp.gate`, `CallContext` with
  `requestId` / `channel` / `caller` / `mode`, `runOperation` and `runStream`
  guarded, `invoke` taking a required envelope, and the bridge path building
  `{ channel: 'user', caller: 'tab' }`.
- AI layer: `AiTool.effect` replaces `permission`, `execute` takes the
  envelope, `GUARDED` / `guardedTool` / `GuardedTool` added, `Confirmations`
  and `createConfirmations` deleted, `createAi` refuses an unbranded tool and
  uses `createPendingApprovals`, `run.ts` builds one approver per run and one
  envelope per call.
- `examples/notes/src/shared/contract.ts`: every route declares its effect.
- `docs/autoapp/design.md` (150 lines), linked from `docs/architecture.md`.
  `docs/ai.md` updated where it described `permission` and hand-written tools.
- `tests/autoapp-gate.test.ts`: 24 tests covering cases 1–22.

## Deviations, and why

1. **`Envelope.effectHint`** was added — a field the prompt's `Envelope` does
   not list. The prompt is internally inconsistent without it: `runOperation`
   is told to use `effectOf(spec)` (missing effect = `write`), while
   `fromContract` is told that an undeclared route in the `read` list is
   treated as `read`. `tests/ai-chat.test.ts` has exactly that shape —
   `notes.list` with no declared effect in the `read` list — so with
   `effectOf` alone the gate would ask the user to confirm a read tool and the
   test would hang. `effectHint` fills the gap and cannot widen it:
   `runOperation` resolves `spec.effect ?? envelope.effectHint ?? 'write'`, so
   a declared effect always wins over anything an adapter says. It is set in
   exactly one place, `from-contract.ts`.
2. **The AI run's confirm deadline** is applied in `run.ts`, in the approver,
   as well as by the gate. `createAi({ confirmTimeoutMs })` is an option of the
   AI layer, and the application's gate is not the AI layer's to configure;
   `tests/ai-chat.test.ts` sets it to 100 ms and asserts the turn ends.
   The approver's signal is the narrower of the two, so neither can be evaded.
3. **`fromContract` returns `Record<string, GuardedTool>`** rather than
   `Record<string, AiTool>`, so `createAi` accepts its output without a cast.
4. **The commit trailer** names Claude Opus 5 rather than the model named in
   the prompt, per this session's attribution instruction.

## Decisions I made

- `guard` records `outcome: 'cancelled'` for a `run` that rejected while the
  request signal was aborted, and `'failed'` otherwise.
- `wasDeclined` in `run.ts` treats both a raw `PublicError` with code
  `rejected` and the marked bridge error `invoke` produces as the declined
  path, because a gated tool reaches the run loop through either route.
- `fromContract` allows `external` under the `confirm` list (both confirm), and
  refuses every other disagreement, matching the prompt's wording.
- The stream guard uses `effectOf(spec)` with no hint: a stream is always
  `channel: 'user'`, so no hint could change the answer.

## Commands run

```
bun run typecheck                       exit 0
bun test tests/autoapp-gate.test.ts     24 pass, 0 fail
bun test tests/ai-chat.test.ts          16 pass, 0 fail
bun test tests                          245 pass, 0 fail (19 files)
cd examples/notes && bunx tsc --noEmit  exit 0
cd examples/notes && bun run build      bin release/notes 69.5 MiB
bun install && bun run check            exit 0
git diff --stat tests/ai-chat.test.ts tests/dependencies.test.ts   (prints nothing)
```

## Acceptance criteria

- **Every path reaches `Gate.guard`** — pass. I temporarily made `guard` throw
  and ran `bun test tests/bridge.test.ts tests/ai-chat.test.ts`: 25 failed,
  including the bridge round-trip, all three stream tests, `invoke > runs an
  operation without a bridge`, and every chat test that calls a tool. Restored,
  and the suite is green again.
- **A model cannot set its own channel** — pass:

  ```
  $ grep -rn "channel: '" packages/broapp/src
  packages/broapp/src/host/app.ts:306:            channel: 'user',
  packages/broapp/src/host/app.ts:404:        channel: 'user',
  packages/broapp/src/ai/host/run.ts:280:              channel: 'ai',
  ```
- **All test cases present and green** — pass (24 tests for cases 1–22; case 23
  is `tests/ai-chat.test.ts`, run unmodified: `16 pass, 0 fail`).
- **`tests/ai-chat.test.ts` and `tests/dependencies.test.ts` unchanged** — pass.

## Tests I had to update

- `tests/bridge.test.ts`: four `invoke` calls now pass an envelope, built by a
  local `directCall()` helper. No assertion changed.

That is the only one. No other test constructed an `AiTool` or called `invoke`.

## Open questions

- `Envelope.effectHint` is the one addition to a surface the prompt specified
  exactly. If prompt 03's application specification always requires an explicit
  effect, the hint becomes dead weight for Autoapp applications and stays only
  for core Broapp contracts written before effects existed.
