/**
 * The AI contract.
 *
 * It is a contract like any application's, with one difference: it owns the
 * reserved `ai` route group, and it is mounted as a *second* host app on the
 * same bridge rather than merged into the application's own contract. That
 * keeps an application's route table free of Broapp's routes and lets the AI
 * layer be absent entirely when it is not enabled.
 *
 * Every bound here is a limit on what a browser may send. They are deliberate:
 * an unbounded `message` or `history` is a way to make the host allocate.
 */
import { defineContract } from '../../shared/contract.ts';
import { s } from '../../shared/schema.ts';

/** A run identifier, chosen by the browser and echoed on every event. */
const runId = s.string({ pattern: /[A-Za-z0-9_-]{8,64}/ });

const capabilities = s.object({
  tools: s.boolean(),
  vision: s.boolean(),
  structuredOutput: s.boolean(),
});

const model = s.object({
  provider: s.string(),
  modelId: s.string(),
  label: s.string(),
  capabilities,
});

const providerInfo = s.object({
  id: s.string(),
  label: s.string(),
  local: s.boolean(),
  needs: s.object({
    apiKey: s.boolean(),
    baseUrl: s.enum(['required', 'optional', 'none']),
  }),
  defaultBaseUrl: s.nullable(s.string()),
});

const settings = s.object({
  provider: s.nullable(s.string()),
  modelId: s.nullable(s.string()),
  baseUrl: s.nullable(s.string()),
  hasKey: s.boolean(),
  keyHint: s.nullable(s.string()),
  remember: s.boolean(),
  configured: s.boolean(),
});

const chatTurn = s.object({
  role: s.enum(['user', 'assistant']),
  content: s.string({ max: 20_000 }),
});

/**
 * One stream event, flat because the validator has no unions.
 *
 * `input` and `output` are `unknown`: they carry whatever an application's own
 * operation takes and returns, which this layer cannot describe in advance.
 * They are host-controlled on the way out, which is the only place `unknown`
 * is safe.
 */
const chatEvent = s.object({
  type: s.enum(['text', 'tool-call', 'confirm', 'tool-result', 'usage', 'done', 'error']),
  text: s.optional(s.string()),
  callId: s.optional(s.string()),
  tool: s.optional(s.string()),
  input: s.optional(s.unknown()),
  output: s.optional(s.unknown()),
  denied: s.optional(s.boolean()),
  permission: s.optional(s.enum(['read', 'confirm'])),
  inputTokens: s.optional(s.number()),
  outputTokens: s.optional(s.number()),
  code: s.optional(s.string()),
  message: s.optional(s.string()),
});

/** Broapp's AI routes. Applications may not declare the `ai` group themselves. */
export const aiContract = defineContract({
  operations: {
    'ai.settings.get': {
      input: s.void(),
      output: settings,
      summary: 'The current AI settings. Never includes the API key itself.',
    },
    'ai.settings.update': {
      input: s.object({
        provider: s.optional(s.string({ max: 64 })),
        modelId: s.optional(s.string({ max: 200 })),
        baseUrl: s.optional(s.nullable(s.string({ max: 2000 }))),
        // Null clears the stored key; a string replaces it. It goes to the
        // secret store and is never read back out to the browser.
        apiKey: s.optional(s.nullable(s.string({ max: 4000 }))),
        remember: s.optional(s.boolean()),
      }),
      output: settings,
      summary: 'Change one or more settings and return the result.',
    },
    'ai.providers.list': {
      input: s.void(),
      output: s.object({ providers: s.array(providerInfo, { max: 50 }) }),
      summary: 'The providers compiled into this application.',
    },
    'ai.models.list': {
      input: s.void(),
      output: s.object({ models: s.array(model, { max: 1000 }) }),
      summary: 'The models the configured provider offers.',
    },
    'ai.connection.test': {
      input: s.void(),
      output: s.object({ ok: s.boolean(), message: s.string(), latencyMs: s.number() }),
      summary: 'Try the configured provider once and report what happened.',
    },
    'ai.chat.confirm': {
      input: s.object({ runId, callId: s.string({ max: 200 }), approve: s.boolean() }),
      output: s.object({ accepted: s.boolean() }),
      summary: 'Answer a confirm event. `accepted` is false when no run is waiting on that call.',
    },
  },
  streams: {
    'ai.chat': {
      params: s.object({
        runId,
        message: s.string({ min: 1, max: 20_000 }),
        refs: s.array(s.string({ max: 200 }), { max: 50 }),
        history: s.array(chatTurn, { max: 100 }),
      }),
      event: chatEvent,
      summary: 'One chat turn. Emits text, tool calls, confirmations and usage.',
    },
  },
});

/** The AI contract's type, for `HostApp` and client generics. */
export type AiContract = typeof aiContract;
