import { describe, expect, test } from 'bun:test';

import { NdjsonDecoder, encodeEvent } from 'broapp/shared';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('NdjsonDecoder', () => {
  test('reassembles an event split across chunks', () => {
    // This is the case that makes framing necessary: a Brobridge stream is a
    // byte channel, so an event can arrive in pieces.
    const decoder = new NdjsonDecoder();
    const encoded = encodeEvent({ value: 'hello world' });
    expect(decoder.push(encoded.slice(0, 7))).toEqual([]);
    expect(decoder.push(encoded.slice(7))).toEqual([{ value: 'hello world' }]);
  });

  test('yields several events from one chunk', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push(bytes('{"n":1}\n{"n":2}\n{"n":3}\n'))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('handles a multi-byte character split across chunks', () => {
    const decoder = new NdjsonDecoder();
    const encoded = encodeEvent({ text: '→' });
    // Split inside the three-byte UTF-8 sequence.
    const cut = encoded.indexOf(0xe2) + 1;
    expect(decoder.push(encoded.slice(0, cut))).toEqual([]);
    expect(decoder.push(encoded.slice(cut))).toEqual([{ text: '→' }]);
  });

  test('flush returns a final unterminated line', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push(bytes('{"n":1}'))).toEqual([]);
    expect(decoder.flush()).toEqual([{ n: 1 }]);
  });

  test('refuses to buffer an unbounded line', () => {
    const decoder = new NdjsonDecoder(64);
    expect(() => decoder.push(bytes('x'.repeat(200)))).toThrow(/maximum size/);
  });

  test('rejects an event containing a newline', () => {
    expect(() => encodeEvent({ text: 'a\nb' })).not.toThrow(); // JSON escapes it
    expect(JSON.parse(new TextDecoder().decode(encodeEvent({ text: 'a\nb' })))).toEqual({ text: 'a\nb' });
  });
});
