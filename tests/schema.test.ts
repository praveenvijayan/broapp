import { describe, expect, test } from 'bun:test';

import { s, ValidationError, defineContract, splitRoute } from 'broapp/shared';

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

describe('toJsonSchema', () => {
  test('string, with and without bounds', () => {
    expect(s.string().toJsonSchema()).toEqual({ type: 'string' });
    expect(s.string({ min: 1, max: 20, pattern: /[a-z]+/ }).toJsonSchema()).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 20,
      pattern: '[a-z]+',
    });
  });

  test('number becomes integer when int is set', () => {
    expect(s.number({ min: 0, max: 9 }).toJsonSchema()).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 9,
    });
    expect(s.number({ int: true }).toJsonSchema()).toEqual({ type: 'integer' });
  });

  test('boolean', () => {
    expect(s.boolean().toJsonSchema()).toEqual({ type: 'boolean' });
  });

  test('literal becomes const', () => {
    expect(s.literal('text').toJsonSchema()).toEqual({ const: 'text' });
  });

  test('enum lists its values', () => {
    expect(s.enum(['read', 'confirm']).toJsonSchema()).toEqual({
      type: 'string',
      enum: ['read', 'confirm'],
    });
  });

  test('array carries its item schema and bounds', () => {
    expect(s.array(s.string(), { min: 1, max: 50 }).toJsonSchema()).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 50,
    });
  });

  test('object lists required keys and closes itself', () => {
    expect(s.object({ name: s.string(), age: s.optional(s.number()) }).toJsonSchema()).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
      additionalProperties: false,
    });
  });

  test('an object with no required keys still has the array', () => {
    expect(s.object({ maybe: s.optional(s.string()) }).toJsonSchema()).toMatchObject({
      required: [],
    });
  });

  test('optional defers to its inner schema', () => {
    expect(s.optional(s.string({ max: 4 })).toJsonSchema()).toEqual({
      type: 'string',
      maxLength: 4,
    });
  });

  test('nullable becomes anyOf with null', () => {
    expect(s.nullable(s.string()).toJsonSchema()).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  test('void is an empty closed object, which is what a provider wants', () => {
    expect(s.void().toJsonSchema()).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  test('unknown constrains nothing', () => {
    expect(s.unknown().toJsonSchema()).toEqual({});
  });

  test('a nested object describes optional, nullable and array fields', () => {
    const schema = s.object({
      id: s.string({ min: 1 }),
      tags: s.array(s.string(), { max: 3 }),
      note: s.optional(s.string()),
      parent: s.nullable(s.string()),
      meta: s.object({ count: s.number({ int: true, min: 0 }) }),
    });
    expect(schema.toJsonSchema()).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        note: { type: 'string' },
        parent: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        meta: {
          type: 'object',
          properties: { count: { type: 'integer', minimum: 0 } },
          required: ['count'],
          additionalProperties: false,
        },
      },
      required: ['id', 'tags', 'parent', 'meta'],
      additionalProperties: false,
    });
  });

  test('an unset bound leaves no key behind at all', () => {
    // `{ minLength: undefined }` would stringify the same but is still a key,
    // and a provider that enumerates keywords would find it.
    expect(JSON.stringify(s.string().toJsonSchema())).toBe('{"type":"string"}');
  });
});

describe('defineContract', () => {
  const spec = { input: s.void(), output: s.void() };

  test('rejects a route without a group', () => {
    expect(() => defineContract({ operations: { greet: spec }, streams: {} })).toThrow(/group\.member/);
  });

  test('rejects a route with two dots, which Brobridge cannot resolve', () => {
    // Brobridge splits a route at its *last* dot and refuses to expose a
    // service whose name contains one, so `a.b.c` would look for the service
    // "a.b", which can never have been registered.
    expect(() => defineContract({ operations: { 'a.b.c': spec }, streams: {} })).toThrow();
    expect(splitRoute('a.b')).toEqual({ group: 'a', member: 'b' });
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
