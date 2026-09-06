/**
 * The two shapes the run loop shares with `create-ai.ts`.
 *
 * They are derived from the contract rather than restated, so a change to the
 * contract is a type error here instead of a mismatch at runtime.
 */
import type { StreamEvent, StreamParams } from '../../shared/contract.ts';
import type { AiContract } from '../shared/contract.ts';

/** What the browser sends to start a turn. */
export type StreamChatParams = StreamParams<AiContract, 'ai.chat'>;

/** One event on the way back. */
export type ChatEvent = StreamEvent<AiContract, 'ai.chat'>;
