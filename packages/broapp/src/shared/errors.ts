/**
 * The public/internal error boundary.
 *
 * A host operation runs with the invoking user's permissions and sees real
 * paths, real database handles and real environment. A browser tab must not
 * learn any of that from a failure, however that tab was authenticated. So
 * Broapp draws one line: an error a handler raises deliberately with
 * {@link PublicError} crosses to the browser with its message intact;
 * everything else is logged on the host and reaches the browser as a fixed
 * string.
 *
 * The transport is Brobridge's, unchanged. Brobridge already reduces any
 * non-`BridgeError` throw to `INTERNAL_ERROR` with the message `"internal
 * error"` (`services.ts`), which is exactly the behaviour wanted for the
 * second case — so Broapp adds nothing there and simply lets it happen. For
 * the first case Broapp throws a `BridgeError` whose message carries a short
 * marker, because Brobridge's `ErrorCode` set is a protocol vocabulary and
 * has no member for "this name is already taken".
 */
import { BridgeError, ErrorCode } from '@brobridgejs/core';

/** Machine-readable failure categories a browser may branch on. */
export type PublicErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'rejected'
  | 'internal';

const PUBLIC_CODES: readonly PublicErrorCode[] = [
  'invalid_input',
  'not_found',
  'conflict',
  'unavailable',
  'rejected',
  'internal',
];

/**
 * Protocol code carried alongside each public code.
 *
 * The mapping is lossy on purpose — several public codes share
 * `INTERNAL_ERROR` — which is why the public code also travels in the
 * message. A peer that only understands the protocol still sees a sensible
 * code; a Broapp client sees both.
 */
const PROTOCOL_CODE: Record<PublicErrorCode, ErrorCode> = {
  invalid_input: ErrorCode.PROTOCOL_VIOLATION,
  not_found: ErrorCode.NOT_FOUND,
  conflict: ErrorCode.INTERNAL_ERROR,
  unavailable: ErrorCode.INTERNAL_ERROR,
  rejected: ErrorCode.PERMISSION_DENIED,
  internal: ErrorCode.INTERNAL_ERROR,
};

/** The marker that tells a Broapp client the message is deliberately public. */
const MARKER = 'broapp/';

/**
 * An error whose message is safe for the browser to display.
 *
 * Raise it for a condition a user can act on: a name already taken, a path
 * outside the configured root, a record that is not there. Do not put a
 * filesystem path, a credential, or a driver message in it — the message is
 * shown to the browser verbatim.
 */
export class PublicError extends Error {
  readonly code: PublicErrorCode;

  constructor(code: PublicErrorCode, message: string) {
    super(message);
    this.name = 'PublicError';
    this.code = code;
  }

  /** As a `BridgeError`, which is what Brobridge forwards with its message intact. */
  toBridgeError(): BridgeError {
    return new BridgeError(PROTOCOL_CODE[this.code], `${MARKER}${this.code} ${this.message}`);
  }
}

/** The message every unhandled host failure becomes, on both sides. */
export const INTERNAL_ERROR_MESSAGE = 'The application could not complete that operation.';

/** An operation or stream failure, as the browser sees it. */
export class BroappError extends Error {
  readonly code: PublicErrorCode;
  /** The underlying protocol error, when there was one. */
  override readonly cause: unknown;

  constructor(code: PublicErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'BroappError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Translate anything a call rejected with into a {@link BroappError}.
 *
 * A message without the marker is not shown: it came from the protocol layer
 * or from Brobridge's own internal-error reduction, and neither is written
 * for a user to read.
 */
export function fromTransportError(error: unknown): BroappError {
  if (error instanceof BroappError) return error;
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith(MARKER)) {
    const space = message.indexOf(' ');
    const code = space < 0 ? message.slice(MARKER.length) : message.slice(MARKER.length, space);
    if ((PUBLIC_CODES as readonly string[]).includes(code)) {
      return new BroappError(
        code as PublicErrorCode,
        space < 0 ? INTERNAL_ERROR_MESSAGE : message.slice(space + 1),
        error,
      );
    }
  }
  if (error instanceof BridgeError && error.code === ErrorCode.CANCELLED) {
    return new BroappError('rejected', 'The operation was cancelled.', error);
  }
  return new BroappError('internal', INTERNAL_ERROR_MESSAGE, error);
}

/**
 * True when an error already carries a message written for the browser.
 *
 * Anything else is a host-side failure whose message may name a path, a query
 * or a token, and must be reduced before it leaves the host.
 */
export function isPublicBridgeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(MARKER);
}

/** Convenience constructors, so a handler reads as prose. */
export const publicError = {
  invalidInput: (message: string): PublicError => new PublicError('invalid_input', message),
  notFound: (message: string): PublicError => new PublicError('not_found', message),
  conflict: (message: string): PublicError => new PublicError('conflict', message),
  unavailable: (message: string): PublicError => new PublicError('unavailable', message),
  rejected: (message: string): PublicError => new PublicError('rejected', message),
} as const;
