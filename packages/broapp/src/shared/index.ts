/**
 * `broapp/shared` — everything both sides import.
 *
 * This entry point holds no host code and no browser code, only the contract
 * description and the types derived from it. That is what makes it safe for
 * the browser bundle to follow.
 */
export { defineContract, splitRoute } from './contract.ts';
export type {
  AnyContract,
  Contract,
  ContractShape,
  ShapeOf,
  OperationInput,
  OperationName,
  OperationOutput,
  OperationSpec,
  StreamEvent,
  StreamName,
  StreamParams,
  StreamSpec,
} from './contract.ts';

export { s, ValidationError } from './schema.ts';
export type { Infer, Issue, Result, Schema } from './schema.ts';

export {
  BroappError,
  INTERNAL_ERROR_MESSAGE,
  PublicError,
  fromTransportError,
  publicError,
} from './errors.ts';
export type { PublicErrorCode } from './errors.ts';

export { encodeEvent, MAX_EVENT_BYTES, NdjsonDecoder } from './ndjson.ts';
