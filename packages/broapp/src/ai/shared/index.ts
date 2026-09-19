/**
 * `broapp/ai` — the AI layer's shared surface.
 *
 * Shared code only: the contract, the types derived from it, and nothing that
 * knows how a provider is reached. The host half is `broapp/ai/host`.
 */
export { aiContract } from './contract.ts';
export type { AiContract } from './contract.ts';
export {
  describeModel,
  findModel,
  formatModelRef,
  LISTED_EARLIER,
  parseModelRef,
  unavailableLine,
  unavailableReason,
  whereItRuns,
} from './model-ref.ts';
export type { FoundModel, ModelDescription, ModelRef, ProviderPlace } from './model-ref.ts';
export type {
  AiSettings,
  BroappModel,
  ChatEvent,
  ChatFile,
  ChatTurn,
  ProviderInfo,
  ProviderSettings,
  StoredMessage,
  Thread,
  ToolPermission,
  UnavailableProvider,
  UnavailableReason,
} from './types.ts';
