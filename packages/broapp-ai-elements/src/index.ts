/**
 * `broapp-ai-elements` — the AI SDK transport for a Broapp application.
 *
 * The panel itself arrives from `broapp-ai-elements/ui`. This entry point is
 * the plumbing: a `ChatTransport` over Brobridge, and the hook that pairs it
 * with the AI SDK's `useChat`.
 */
export { createBroappChatTransport } from './transport.ts';
export type {
  BroappApprovalDescriptor,
  BroappChatTransport,
  BroappChatTransportOptions,
  BroappMessageMetadata,
  BroappUIMessage,
} from './transport.ts';

export { IMAGE_LIMITS, intrinsicSize, prepareImage, splitDataUrl } from './images.ts';
export type { PreparedImage } from './images.ts';

export { useBroappChat } from './use-broapp-chat.ts';
export type { BroappChatHook, BroappChatOptions } from './use-broapp-chat.ts';
