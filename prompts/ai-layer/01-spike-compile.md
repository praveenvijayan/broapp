# 01 — Spike: does the AI SDK survive `bun build --compile`?

Nothing in this prompt touches `packages/`, `examples/` or `templates/`.
It produces evidence and a report. Later prompts depend on the answer.

## Goal

Prove, with commands you actually ran, that:

1. A Bun host that imports `ai`, `@ai-sdk/anthropic` and
   `@ai-sdk/openai-compatible` compiles with `bun build --compile` for all
   six Broapp targets, and the native one runs.
2. With an explicit provider instance, the AI SDK makes **one** outbound
   request, to the provider's host, and never contacts any Vercel gateway
   host.
3. The size cost of the three packages in the compiled binary, in bytes.

## Read first

- `prompts/ai-layer/00-common-rules.md`
- `packages/broapp/src/cli/targets.ts` — the six target names.
- `packages/broapp/src/cli/build-binary.ts` — how Broapp invokes `bun build --compile`. Use the same flags.
- `.gitignore` — confirm `.broapp-tmp/` is ignored. Work under `.broapp-tmp/ai-spike/`.

## Steps

### 1. Make the spike project

Create `.broapp-tmp/ai-spike/` with its own `package.json` (name
`ai-spike`, `"type": "module"`, `"private": true`) and install exactly:

```
ai@7.0.93
@ai-sdk/anthropic@4.0.49
@ai-sdk/openai-compatible@3.0.44
```

Run `bun install` inside that directory, not at the repository root.

### 2. Confirm the API from the type definitions

Open `.broapp-tmp/ai-spike/node_modules/ai/dist/index.d.ts` and write down,
in the report, the exact names and signatures of:

- the function that streams text (expected: `streamText`),
- its option for an abort signal (expected: `abortSignal`),
- the property on its result that yields every stream part (expected:
  `fullStream`),
- the `type` strings of the parts for text deltas, tool calls, tool
  results, finish and error, and the property that carries the text of a
  text delta,
- the helper that builds a tool from a JSON schema (expected: `jsonSchema`)
  and the tool constructor (expected: `tool`),
- the helper that limits agent steps (expected: `stepCountIs`),
- the `LanguageModel` type name,
- whether `ai/test` exists and what mock model class it exports (expected:
  something like `MockLanguageModelV3`) plus `simulateReadableStream`.

Do the same for `createAnthropic` in `@ai-sdk/anthropic` and
`createOpenAICompatible` in `@ai-sdk/openai-compatible`: constructor
option names for the API key and base URL, and how a model instance is
obtained from the provider object.

### 3. Write `baseline.ts` and `spike.ts`

`baseline.ts`: a script that prints `"baseline"` and exits. It exists only
so the binary size delta can be measured.

`spike.ts`:

```ts
// Records every URL fetch is asked for, refuses the network, and reports.
const seen: string[] = [];
const recordingFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  seen.push(url);
  throw new Error('network disabled in spike');
};

// 1. Build both providers with the recording fetch injected.
//    Use the option names you confirmed in step 2.
// 2. Call streamText once per provider with model id 'claude-opus-5'
//    (anthropic) and 'llama3' (compatible, baseURL http://127.0.0.1:11434/v1),
//    prompt 'Say hi', and consume fullStream inside try/catch.
// 3. Print JSON: { seen, ok: <every URL in seen starts with the expected host> }.
// 4. Exit 0 if ok, 1 otherwise.
```

Expected hosts: `https://api.anthropic.com/` and `http://127.0.0.1:11434/`.
The spike **fails** if any URL contains `vercel`, `gateway`, or any host
other than those two.

Also add a third call that passes the model as a **string** (`'anthropic/claude-opus-5'`)
instead of a provider instance, and record what host it tries. Do not make
this part of the pass/fail; report it. It documents the trap the layer must
guard against.

### 4. Run it under Bun directly

```bash
cd .broapp-tmp/ai-spike && bun run spike.ts
```

Must exit 0. Paste the printed JSON into the report.

### 5. Compile for all six targets

For each target in `targets.ts`, compile both scripts with the same flags
`build-binary.ts` uses (minify, sourcemap settings, `--target=bun-<t>`),
into `.broapp-tmp/ai-spike/out/<target>/`. Record the size of every output.
Then run the native `spike` binary and confirm it still exits 0 and prints
the same `seen` list.

If any target fails to compile, record the exact error. If the error is
about a Node built-in or a dynamic `require`, try once with
`--external <module>` and record whether that helps. Do not spend more than
two attempts per target.

### 6. Report

Write `prompts/ai-layer/reports/01-spike.md` with:

- The API names table from step 2.
- Output of step 4.
- A size table: target, baseline bytes, spike bytes, delta.
- The string-model-id observation.
- Verdict line: `SPIKE PASSED` or `SPIKE FAILED: <reason>`.

Do not commit anything from `.broapp-tmp/`. Commit only the report:

```
Record the AI SDK compile spike results
```

## Done when

- `bun run spike.ts` exits 0 on this machine.
- Six targets compiled, native one runs.
- Report written and committed.

If the verdict is `SPIKE FAILED`, stop. Do not start prompt 02.
