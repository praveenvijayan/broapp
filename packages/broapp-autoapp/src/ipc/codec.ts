/**
 * Reading a message off the channel.
 *
 * Bun's IPC hands over a value that has already survived a structured clone,
 * so it is an object of some shape — but which shape is entirely up to the
 * process at the other end, and after prompt 05 that process may be running a
 * release nobody in this build has seen. So nothing is assumed: every field is
 * checked, an unknown `type` is refused, and an unknown `v` is refused before
 * anything else, because a version this build does not understand is the one
 * case where guessing is worse than stopping.
 */
import { IPC_VERSION, MAX_MESSAGE_BYTES, type Message } from './messages.ts';

/** Every `type` a message may have. */
const TYPES = ['hello', 'ready', 'health', 'drain', 'shutdown', 'fatal', 'migrate', 'invoke'] as const;

/** The states a child may report. */
const STATES = ['starting', 'serving', 'draining', 'stopping'] as const;

/** A field that has to be there and has to be a non-empty string. */
function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`message field ${JSON.stringify(field)} must be a non-empty string`);
  }
  return value;
}

/** A field that has to be there and has to be a finite number. */
function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`message field ${JSON.stringify(field)} must be a finite number`);
  }
  return value;
}

/** A field that may be absent, but must be a finite number when present. */
function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  if (record[field] === undefined) return undefined;
  return requireNumber(record, field);
}

/** A field that may be absent, but must be a boolean when present. */
function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new TypeError(`message field ${JSON.stringify(field)} must be a boolean`);
  }
  return value;
}

/**
 * Validate one incoming message.
 *
 * Throws `TypeError` with a sentence naming what was wrong. The caller decides
 * what that means — the launcher kills the child, the child sends `fatal` and
 * exits 3 — but neither of them gets a half-checked object to work with.
 */
export function parseMessage(raw: unknown): Message {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('a message must be an object');
  }
  const record = raw as Record<string, unknown>;

  // Size is checked before anything else that could allocate, and measured on
  // the serialized form because that is the thing with a size at all.
  let serialized: string;
  try {
    serialized = JSON.stringify(record) ?? '';
  } catch {
    throw new TypeError('a message must be serializable as JSON');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new TypeError(`a message must be at most ${String(MAX_MESSAGE_BYTES)} bytes`);
  }

  if (record['v'] !== IPC_VERSION) {
    throw new TypeError(
      `message protocol version ${JSON.stringify(record['v'])} is not ${String(IPC_VERSION)}`,
    );
  }
  const id = requireString(record, 'id');
  const re = record['re'] === undefined ? undefined : requireString(record, 're');
  const type = record['type'];
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
    throw new TypeError(`message type ${JSON.stringify(type)} is not one of ${TYPES.join(', ')}`);
  }
  const base = { v: IPC_VERSION, id, ...(re === undefined ? {} : { re }) } as const;

  switch (type as (typeof TYPES)[number]) {
    case 'hello':
      return {
        ...base,
        type: 'hello',
        appId: requireString(record, 'appId'),
        releaseId: requireString(record, 'releaseId'),
        pid: requireNumber(record, 'pid'),
      };
    case 'ready':
      return {
        ...base,
        type: 'ready',
        url: requireString(record, 'url'),
        schemaVersion: requireNumber(record, 'schemaVersion'),
      };
    case 'health': {
      const state = record['state'];
      if (state !== undefined && !(STATES as readonly unknown[]).includes(state)) {
        throw new TypeError(`message field "state" must be one of ${STATES.join(', ')}`);
      }
      const activeWork = optionalNumber(record, 'activeWork');
      const attached = optionalBoolean(record, 'attached');
      return {
        ...base,
        type: 'health',
        ...(state === undefined ? {} : { state: state as (typeof STATES)[number] }),
        ...(activeWork === undefined ? {} : { activeWork }),
        ...(attached === undefined ? {} : { attached }),
      };
    }
    case 'drain': {
      const drained = optionalBoolean(record, 'drained');
      return {
        ...base,
        type: 'drain',
        deadlineMs: requireNumber(record, 'deadlineMs'),
        ...(drained === undefined ? {} : { drained }),
      };
    }
    case 'shutdown':
      return { ...base, type: 'shutdown', deadlineMs: requireNumber(record, 'deadlineMs') };
    case 'fatal':
      return { ...base, type: 'fatal', reason: requireString(record, 'reason') };
    case 'invoke': {
      const ok = optionalBoolean(record, 'ok');
      return {
        ...base,
        type: 'invoke',
        ...(record['route'] === undefined ? {} : { route: requireString(record, 'route') }),
        ...(record['input'] === undefined ? {} : { input: record['input'] }),
        ...(record['client'] === undefined ? {} : { client: requireString(record, 'client') }),
        ...(record['requestId'] === undefined ? {} : { requestId: requireString(record, 'requestId') }),
        ...(ok === undefined ? {} : { ok }),
        ...(record['output'] === undefined ? {} : { output: record['output'] }),
        ...(record['code'] === undefined ? {} : { code: requireString(record, 'code') }),
        ...(record['message'] === undefined ? {} : { message: requireString(record, 'message') }),
      };
    }
    case 'migrate': {
      const from = optionalNumber(record, 'from');
      const to = optionalNumber(record, 'to');
      return {
        ...base,
        type: 'migrate',
        dataDir: requireString(record, 'dataDir'),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      };
    }
  }
}

/** True when `raw` is a message this build understands. */
export function isMessage(raw: unknown): raw is Message {
  try {
    parseMessage(raw);
    return true;
  } catch {
    return false;
  }
}
