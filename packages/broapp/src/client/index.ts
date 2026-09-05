/** `broapp/client` — the browser client. Framework-agnostic. */
export { createClient } from './client.ts';
export type {
  BridgeState,
  BroappClient,
  CreateClientOptions,
  StreamCallbacks,
  Subscription,
} from './client.ts';

export { BroappError } from '../shared/errors.ts';
export type { PublicErrorCode } from '../shared/errors.ts';
