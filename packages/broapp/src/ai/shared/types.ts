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

/** What the settings route returns. Never contains the key itself. */
export interface AiSettings {
  provider: string | null;
  modelId: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  /** Last four characters of the key, for the UI to show which key is set. */
  keyHint: string | null;
  /** False means the key is held in memory only and forgotten on exit. */
  remember: boolean;
  /** True when provider and model are both set and the provider's needs are met. */
  configured: boolean;
}

/** How much ceremony a tool call needs before it runs. */
export type ToolPermission = 'read' | 'confirm';

/** One turn of prior conversation the browser sends back with each message. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
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
 * `modelId` is null for a conversation that follows Settings, and a model id
 * for one that has been pinned to a model of its own. The provider is never
 * part of a conversation: it is a Settings decision, because changing it
 * changes which key is used and whether anything leaves the computer.
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
 *   usage       inputTokens, outputTokens
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
  code?: string;
  message?: string;
}
