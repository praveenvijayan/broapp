/**
 * `broapp/ai/react` — the AI layer's interface.
 *
 * Shared code: nothing here imports the AI SDK, and a browser bundle that
 * follows these imports gets the contract and the components and nothing else.
 * Pair it with `ai.css`, or write your own using the class names these
 * components emit.
 */
export { AiProvider, useAiContext } from './provider.tsx';
export type { AiClient } from './provider.tsx';

export { useAiSettings } from './use-ai-settings.ts';
export type { AiSettingsHook, ConnectionResult, UpdatePatch } from './use-ai-settings.ts';

export { useAiModels } from './use-ai-models.ts';
export type { AiModelsHook } from './use-ai-models.ts';

export { useAiChat } from './use-ai-chat.ts';
export type { AiChatHook, AiChatOptions, ChatMessage, ToolCallState } from './use-ai-chat.ts';

export { AiSettings } from './AiSettings.tsx';
export { AiChat } from './AiChat.tsx';
export type { AiChatProps } from './AiChat.tsx';

// Re-exported so an application needs one import to install the extension.
export { aiContract } from '../shared/index.ts';
export type {
  AiContract,
  AiSettings as AiSettingsValue,
  BroappModel,
  ChatEvent,
  ChatTurn,
  ProviderInfo,
  ToolPermission,
} from '../shared/index.ts';
