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
  needs: { apiKey: boolean; baseUrl: 'required' | 'optional' | 'none' };
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
 * One event on the `ai.chat` stream. Flat on purpose: the `s` validator has
 * no unions, so the discriminant is `type` and the other fields are
 * optional. Which fields are present for which type:
 *
 *   text        text
 *   tool-call   callId, tool, input, permission
 *   confirm     callId, tool, input          (waits for ai.chat.confirm)
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
  inputTokens?: number;
  outputTokens?: number;
  code?: string;
  message?: string;
}
