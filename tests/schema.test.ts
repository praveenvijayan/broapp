import { describe, expect, test } from 'bun:test';

import { s, ValidationError, defineContract } from 'broapp/shared';

describe('schema', () => {
  test('accepts a valid object and drops unknown keys', () => {
    const schema = s.object({ name: s.string({ min: 1 }), age: s.number({ int: true }) });
    // The dropped key is the point: a property a caller smuggled in must not
    // reach application code just because it was well formed.
    expect(schema.parse({ name: 'ada', age: 36, isAdmin: true })).toEqual({ name: 'ada', age: 36 });
  });

  test('names the failing field in the message', () => {
    const schema = s.object({ profile: s.object({ email: s.string({ min: 3 }) }) });
    expect(() => schema.parse({ profile: { email: '' } })).toThrow(/profile\.email/);
  });

  test('reports an array index', () => {
    const schema = s.array(s.number());
    try {
      schema.parse([1, 2, 'three']);
      throw new Error('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ValidationError);
      expect((cause as ValidationError).issues[0]?.path).toEqual([2]);
    }
  });

  test('rejects a non-finite number', () => {
    expect(() => s.number().parse(Number.NaN)).toThrow();
    expect(() => s.number().parse(Number.POSITIVE_INFINITY)).toThrow();
  });

  test('anchors a pattern end to end', () => {
    const schema = s.string({ pattern: /[a-z]+/ });
    expect(schema.parse('abc')).toBe('abc');
    expect(() => schema.parse('abc!')).toThrow();
  });

  test('optional accepts absence, nullable accepts null, and they differ', () => {
    const schema = s.object({ maybe: s.optional(s.string()), nothing: s.nullable(s.string()) });
    expect(schema.parse({ nothing: null })).toEqual({ nothing: null } as never);
    expect(() => schema.parse({ maybe: 'x' })).toThrow(/nothing/);
  });

  test('void accepts undefined and null, because JSON has no undefined', () => {
    expect(s.void().parse(undefined)).toBeUndefined();
    expect(s.void().parse(null)).toBeUndefined();
    expect(() => s.void().parse(0)).toThrow();
  });

  test('enum rejects a value outside the set', () => {
    const schema = s.enum(['read', 'write']);
    expect(schema.parse('read')).toBe('read');
    expect(() => schema.parse('admin')).toThrow();
  });
});

describe('defineContract', () => {
  const spec = { input: s.void(), output: s.void() };

  test('rejects a route without a group', () => {
    expect(() => defineContract({ operations: { greet: spec }, streams: {} })).toThrow(/group\.member/);
  });

  test('rejects a route with two dots, which Brobridge cannot resolve', () => {
    expect(() => defineContract({ operations: { 'a.b.c': spec }, streams: {} })).toThrow();
  });

  test('rejects a name used as both an operation and a stream', () => {
    expect(() =>
      defineContract({
        operations: { 'x.y': spec },
        streams: { 'x.y': { params: s.void(), event: s.void() } },
      }),
    ).toThrow(/both/);
  });

  test('lists its routes', () => {
    const contract = defineContract({
      operations: { 'a.one': spec, 'a.two': spec },
      streams: { 'b.tick': { params: s.void(), event: s.void() } },
    });
    expect(contract.routes.operations).toEqual(['a.one', 'a.two']);
    expect(contract.routes.streams).toEqual(['b.tick']);
  });
});
