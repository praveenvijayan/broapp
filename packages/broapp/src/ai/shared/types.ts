/**
 * The types the browser sees.
 *
 * Everything here is shared code: it names what the AI layer exchanges over
 * the bridge and nothing about how a provider is reached. No file in this
 * directory may import the AI SDK packages — the browser bundle follows these
 * imports, and the page's CSP forbids it from talking to a provider anyway.
 *
 * The fields are not marked `readonly`. These interfaces must be *identical*
 * to what `Infer` derives from the contract in `contract.ts`, which
 * `types.check.ts` asserts at compile time; a `readonly` here would make the
 * two types merely compatible instead, and the drift check would stop
 * catching drift.
 */

/** A model a provider offers, as the browser sees it. */
export interface BroappModel {
  provider: string;
  modelId: string;
  label: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    structuredOutput: boolean;
  };
}

/** A provider compiled into this application, as the browser sees it. */
export interface ProviderInfo {
  id: string;
  label: string;
  /** True when requests stay on this machine with the current settings. */
  local: boolean;
  needs: {
    apiKey: 'required' | 'optional' | 'none';
    baseUrl: 'required' | 'optional' | 'none';
  };
  defaultBaseUrl: string | null;
}

/**
 * One provider's own settings, whether or not it is the one in use. Never
 * contains the key itself.
 */
export interface ProviderSettings {
  id: string;
  baseUrl: string | null;
  modelId: string | null;
  /** Whether it may be sent anything. The provider in use always may. */
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  /**
   * True when its key and address are what it needs: a model reference naming
   * it would run, given a model, once it is enabled. Neither the model nor
   * `enabled` is part of this; each has its own field.
   */
  configured: boolean;
}

/**
 * What the settings route returns. Never contains a key itself.
 *
 * The top-level fields are the provider in use — the one a turn runs on when
 * nothing names another — so an application written against one provider
 * reads what it always read.
 */
export interface AiSettings {
  provider: string | null;
  modelId: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  /** Last four characters of the key, for the UI to show which key is set. */
  keyHint: string | null;
  /** False means every key is held in memory only and forgotten on exit. */
  remember: boolean;
  /** True when provider and model are both set and the provider's needs are met. */
  configured: boolean;
  /** Every provider in this build, in the build's order. */
  providers: ProviderSettings[];
}

/** How much ceremony a tool call needs before it runs. */
export type ToolPermission = 'read' | 'confirm';

/** One turn of prior conversation the browser sends back with each message. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /**
   * On an assistant turn: the run that produced it. The host expands a turn
   * whose run it holds a transcript for into that turn's own tool calls and
   * results; any other turn, and any run it does not hold, is `content`.
   */
  runId?: string;
}

/**
 * One image sent with a chat turn.
 *
 * `data` is base64 with no `data:` prefix, at most 2,000,000 characters, and
 * `mediaType` is one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
 * At most four travel with one message, and they travel only with the message
 * they arrive on: a later turn's `history` keeps the line
 * `[image: <name>]` in place of the image itself, because a transcript of
 * base64 would not fit inside the contract's bound on a turn.
 */
export interface ChatFile {
  name: string;
  mediaType: string;
  data: string;
}

/**
 * A stored conversation, without its messages.
 *
 * `modelId` is null for a conversation that follows Settings, and a model
 * reference for one that has been pinned to a model of its own: bare, a model
 * of the provider in use; `<provider>:<model>`, a model of any provider the
 * person turned on (see `model-ref.ts`). It once could not name a provider,
 * because changing provider changes which key is used and whether anything
 * leaves the computer. That reason stands, and is why wherever a model is
 * chosen the person must be told whether it runs on this computer.
 */
export interface Thread {
  id: string;
  title: string;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * One message as it is stored.
 *
 * `parts` are the AI SDK's own message parts. The host writes them as JSON and
 * hands them back unread — it has no opinion about what a part is, which is
 * why the type is `unknown[]` rather than a copy of the SDK's union that would
 * drift from it. One thing the host *does* change on the way in: a `file` part
 * becomes the text `[image: name]`, because a data URL in SQLite would be a
 * copy of the image nobody asked to keep.
 */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: unknown[];
  metadata?: unknown;
}

/**
 * One event on the `ai.chat` stream. Flat on purpose: the `s` validator has
 * no unions, so the discriminant is `type` and the other fields are
 * optional. Which fields are present for which type:
 *
 *   text        text
 *   tool-call   callId, tool, input, permission
 *   confirm     callId, tool, input, requestId, releaseId, argumentsHash,
 *               expiresAt                    (waits for ai.chatConfirm)
 *   tool-result callId, tool, output, denied?
 *   usage       inputTokens, outputTokens, partial? (true: the turn did not
 *               finish, and these are only its completed steps)
 *   done        —
 *   error       code, message
 */
export interface ChatEvent {
  type: 'text' | 'tool-call' | 'confirm' | 'tool-result' | 'usage' | 'done' | 'error';
  text?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  denied?: boolean;
  permission?: ToolPermission;
  /** On `confirm`: what the gate is waiting on, so an answer can name it. */
  requestId?: string;
  releaseId?: string;
  argumentsHash?: string;
  /** On `confirm`: when the question stops waiting, so the card can count down. */
  expiresAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** On `usage`: the turn did not finish, so this is a subtotal, not the whole. */
  partial?: boolean;
  code?: string;
  message?: string;
}
