/**
 * Newline-delimited JSON over a Brobridge byte stream.
 *
 * A Brobridge stream is an ordered byte channel, not a message channel: a
 * chunk delivered to a consumer may hold two events, half an event, or the
 * tail of one and the head of the next. Treating a chunk as an event works
 * until a payload crosses a frame boundary and then fails in production, so
 * Broapp frames explicitly.
 *
 * NDJSON is used rather than a length prefix because it stays readable in a
 * packet dump and costs one byte per event.
 */

const encoder = new TextEncoder();

/** Encode one event as a single NDJSON line. */
export function encodeEvent(event: unknown): Uint8Array {
  const line = JSON.stringify(event);
  if (line === undefined) throw new TypeError('stream events must be JSON-encodable');
  if (line.includes('\n')) throw new TypeError('encoded event contains a newline');
  return encoder.encode(`${line}\n`);
}

/** Largest single event Broapp will reassemble, in bytes of UTF-8. */
export const MAX_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Reassemble NDJSON events from arbitrary byte chunks.
 *
 * The buffer is bounded: a peer that sends four megabytes without a newline
 * is a fault, not a slow event, and the decoder throws rather than growing.
 */
export class NdjsonDecoder {
  readonly #decoder = new TextDecoder('utf-8');
  readonly #limit: number;
  #buffer = '';

  constructor(limit: number = MAX_EVENT_BYTES) {
    this.#limit = limit;
  }

  /** Feed one chunk; returns every event that completed within it. */
  push(chunk: Uint8Array): unknown[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const events: unknown[] = [];
    for (;;) {
      const cut = this.#buffer.indexOf('\n');
      if (cut < 0) break;
      const line = this.#buffer.slice(0, cut);
      this.#buffer = this.#buffer.slice(cut + 1);
      if (line.trim() !== '') events.push(JSON.parse(line));
    }
    if (this.#buffer.length > this.#limit) {
      throw new Error('stream event exceeded the maximum size');
    }
    return events;
  }

  /**
   * Finish. Returns a trailing event that had no newline, if any.
   *
   * A well-behaved producer always terminates its last line, so this normally
   * returns an empty array; it exists so a stream ended by `end()` mid-line
   * does not silently drop its final event.
   */
  flush(): unknown[] {
    this.#buffer += this.#decoder.decode();
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest === '' ? [] : [JSON.parse(rest)];
  }
}
