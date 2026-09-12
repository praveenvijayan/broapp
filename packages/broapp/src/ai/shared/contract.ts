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
    apiKey: s.enum(['required', 'optional', 'none']),
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
  // Names a run whose transcript the host wrote. It only ever selects
  // something the host already holds; an id it does not hold is ignored.
  runId: s.optional(runId),
});

/**
 * One image on a turn. `data` is base64 without the `data:` prefix.
 *
 * The bounds are the browser's contract as much as the host's: the panel
 * downscales before it sends, and four images of two million characters still
 * fit inside one Brobridge frame with room to spare.
 */
const chatFile = s.object({
  name: s.string({ max: 200 }),
  mediaType: s.string({ pattern: /image\/(png|jpeg|gif|webp)/ }),
  data: s.string({ min: 1, max: 2_000_000 }),
});

/** A conversation identifier. The host chooses it; the browser only echoes it. */
const threadId = s.string({ pattern: /[A-Za-z0-9_-]{8,64}/ });

/** A conversation, without its messages. */
const thread = s.object({
  id: threadId,
  title: s.string({ max: 120 }),
  /** Null means "whatever Settings says". */
  modelId: s.nullable(s.string({ max: 200 })),
  createdAt: s.number(),
  updatedAt: s.number(),
  messageCount: s.number({ int: true, min: 0 }),
});

/**
 * One stored UI message. Parts are the AI SDK's; the host stores, never
 * interprets.
 *
 * `s.unknown()` is normally forbidden on an input, because the point of an
 * input schema is that browser-supplied data is untrusted. It is right here
 * for the one reason that exempts it: nothing on the host ever reads inside a
 * part. They are written to SQLite as JSON and handed back to the same browser
 * that sent them, so the shape the host would be validating is a shape only
 * the AI SDK understands and only the AI SDK consumes. What is still bounded
 * is the *amount*: 200 parts to a message, 200 messages to a save, and a byte
 * ceiling on the whole save in `threads.ts`.
 */
const storedMessage = s.object({
  id: s.string({ max: 200 }),
  role: s.enum(['user', 'assistant', 'system']),
  parts: s.array(s.unknown(), { max: 200 }),
  metadata: s.optional(s.unknown()),
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
  requestId: s.optional(s.string()),
  releaseId: s.optional(s.string()),
  argumentsHash: s.optional(s.string()),
  expiresAt: s.optional(s.number()),
  inputTokens: s.optional(s.number()),
  outputTokens: s.optional(s.number()),
  code: s.optional(s.string()),
  message: s.optional(s.string()),
});

/** Broapp's AI routes. Applications may not declare the `ai` group themselves. */
export const aiContract = defineContract({
  operations: {
    'ai.settingsGet': {
      input: s.void(),
      output: settings,
      summary: 'The current AI settings. Never includes the API key itself.',
    },
    'ai.settingsUpdate': {
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
    'ai.providersList': {
      input: s.void(),
      output: s.object({ providers: s.array(providerInfo, { max: 50 }) }),
      summary: 'The providers compiled into this application.',
    },
    'ai.modelsList': {
      input: s.void(),
      output: s.object({ models: s.array(model, { max: 1000 }) }),
      summary: 'The models the configured provider offers.',
    },
    'ai.connectionTest': {
      input: s.void(),
      output: s.object({ ok: s.boolean(), message: s.string(), latencyMs: s.number() }),
      summary: 'Try the configured provider once and report what happened.',
    },
    'ai.chatConfirm': {
      input: s.object({ runId, callId: s.string({ max: 200 }), approve: s.boolean() }),
      output: s.object({ accepted: s.boolean() }),
      summary: 'Answer a confirm event. `accepted` is false when no run is waiting on that call.',
    },
    // Conversations are the user's own data, so every route below answers even
    // when no provider is configured: somebody who has just removed their key
    // is still entitled to read and delete what they wrote.
    'ai.threadsList': {
      input: s.void(),
      output: s.object({ threads: s.array(thread, { max: 500 }) }),
      summary: 'Every stored conversation, most recently changed first.',
    },
    'ai.threadsCreate': {
      input: s.object({
        title: s.optional(s.string({ max: 120 })),
        modelId: s.optional(s.nullable(s.string({ max: 200 }))),
      }),
      output: thread,
      summary: 'Start a conversation. Without a title it is named after its first message.',
    },
    'ai.threadsGet': {
      input: s.object({ id: threadId }),
      output: s.object({ thread, messages: s.array(storedMessage, { max: 200 }) }),
      summary: 'One conversation and its messages.',
    },
    'ai.threadsSave': {
      input: s.object({
        id: threadId,
        messages: s.array(storedMessage, { max: 200 }),
        title: s.optional(s.string({ max: 120 })),
      }),
      output: thread,
      summary: 'Replace the messages of a conversation, whole.',
    },
    'ai.threadsUpdate': {
      input: s.object({
        id: threadId,
        title: s.optional(s.string({ max: 120 })),
        // Null puts the conversation back on whatever Settings says.
        modelId: s.optional(s.nullable(s.string({ max: 200 }))),
      }),
      output: thread,
      summary: 'Rename a conversation, or give it a model of its own.',
    },
    'ai.threadsDelete': {
      input: s.object({ id: threadId }),
      output: s.object({ deleted: s.boolean() }),
      summary: 'Delete one conversation and its messages.',
    },
    'ai.threadsClear': {
      input: s.void(),
      output: s.object({ deleted: s.number({ int: true, min: 0 }) }),
      summary: 'Delete every conversation.',
    },
  },
  streams: {
    'ai.chat': {
      params: s.object({
        runId,
        message: s.string({ min: 1, max: 20_000 }),
        refs: s.array(s.string({ max: 200 }), { max: 50 }),
        history: s.array(chatTurn, { max: 100 }),
        // Images travel with the turn they arrive on. History keeps a
        // placeholder instead, because a transcript of base64 would not fit.
        files: s.optional(s.array(chatFile, { max: 4 })),
        // The model for this turn only, and only *within* the configured
        // provider. A provider is never overridden per turn: a different
        // provider means a different key and a different answer to "does this
        // leave my computer", and that stays a Settings decision.
        modelId: s.optional(s.string({ max: 200 })),
      }),
      event: chatEvent,
      summary: 'One chat turn. Emits text, tool calls, confirmations and usage.',
    },
  },
});

/** The AI contract's type, for `HostApp` and client generics. */
export type AiContract = typeof aiContract;
