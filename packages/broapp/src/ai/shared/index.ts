/**
 * `broapp/ai` — the AI layer's shared surface.
 *
 * Shared code only: the contract, the types derived from it, and nothing that
 * knows how a provider is reached. The host half is `broapp/ai/host`.
 */
export { aiContract } from './contract.ts';
export type { AiContract } from './contract.ts';
export type {
  AiSettings,
  BroappModel,
  ChatEvent,
  ChatTurn,
  ProviderInfo,
  ToolPermission,
} from './types.ts';
