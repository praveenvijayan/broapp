/**
 * Merging contracts, and the route group Broapp keeps for itself.
 *
 * The AI layer rides on the same bridge as the application, so two things have
 * to hold: two contracts can be combined without either shadowing the other,
 * and an application cannot claim the group Broapp mounts its own routes in.
 */
import { describe, expect, test } from 'bun:test';

import { aiContract } from 'broapp/ai';
import { createHostApp, createReservedHostApp } from 'broapp/host';
import { defineContract, mergeContracts, s } from 'broapp/shared';

const spec = { input: s.void(), output: s.void() };
const streamSpec = { params: s.void(), event: s.void() };

describe('mergeContracts', () => {
  test('keeps every route from both sides', () => {
    const a = defineContract({ operations: { 'a.one': spec }, streams: { 'a.tick': streamSpec } });
    const b = defineContract({ operations: { 'b.two': spec }, streams: { 'b.tock': streamSpec } });
    const merged = mergeContracts(a, b);
    expect(merged.routes.operations).toEqual(['a.one', 'b.two']);
    expect(merged.routes.streams).toEqual(['a.tick', 'b.tock']);
    expect(merged.operations['a.one']).toBe(a.operations['a.one'] as never);
  });

  test('refuses an operation declared on both sides', () => {
    const a = defineContract({ operations: { 'x.y': spec }, streams: {} });
    const b = defineContract({ operations: { 'x.y': spec }, streams: {} });
    expect(() => mergeContracts(a, b)).toThrow(/both contracts/);
  });

  test('refuses a name that is an operation on one side and a stream on the other', () => {
    // Brobridge dispatches on the route name alone, so this is just as
    // unresolvable as a duplicate operation.
    const a = defineContract({ operations: { 'x.y': spec }, streams: {} });
    const b = defineContract({ operations: {}, streams: { 'x.y': streamSpec } });
    expect(() => mergeContracts(a, b)).toThrow(/both contracts/);
  });
});

describe('the reserved ai group', () => {
  test('an application that declares an ai route is refused at startup', () => {
    const app = defineContract({ operations: { 'ai.chat': spec }, streams: {} });
    expect(() => createHostApp(app)).toThrow(/reserved/);
  });

  test('a stream in the reserved group is refused too', () => {
    const app = defineContract({ operations: {}, streams: { 'ai.stuff': streamSpec } });
    expect(() => createHostApp(app)).toThrow(/reserved/);
  });

  test('an ordinary application contract is unaffected', () => {
    const app = defineContract({ operations: { 'notes.list': spec }, streams: {} });
    expect(() => createHostApp(app)).not.toThrow();
  });

  test("Broapp's own AI contract may use the group", () => {
    // The reservation exists to keep an application from colliding with the AI
    // layer, not to stop the AI layer from mounting.
    expect(() => createReservedHostApp(aiContract)).not.toThrow();
    expect(() => createHostApp(aiContract)).toThrow(/reserved/);
  });
});
