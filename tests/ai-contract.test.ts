/**
 * What the AI contract accepts from the browser.
 *
 * Every bound in it is a limit on untrusted input, so the tests that matter
 * are the ones that prove the limits are enforced rather than decorative.
 */
import { describe, expect, test } from 'bun:test';

import { aiContract } from 'broapp/ai';

const chat = aiContract.streams['ai.chat'];

describe('aiContract', () => {
  test('every route is in the ai group', () => {
    for (const route of [...aiContract.routes.operations, ...aiContract.routes.streams]) {
      expect(route.startsWith('ai.')).toBe(true);
    }
  });

  test('declares exactly the routes the layer implements', () => {
    expect(aiContract.routes.operations).toEqual([
      'ai.settingsGet',
      'ai.settingsUpdate',
      'ai.providersList',
      'ai.modelsList',
      'ai.connectionTest',
      'ai.chatConfirm',
      'ai.threadsList',
      'ai.threadsCreate',
      'ai.threadsGet',
      'ai.threadsSave',
      'ai.threadsUpdate',
      'ai.threadsDelete',
      'ai.threadsClear',
    ]);
    expect(aiContract.routes.streams).toEqual(['ai.chat']);
  });

  test('ai.chat refuses a short runId', () => {
    const params = { runId: 'abc', message: 'hi', refs: [], history: [] };
    expect(() => chat.params.parse(params)).toThrow(/runId/);
  });

  test('ai.chat refuses an empty message', () => {
    const params = { runId: 'run-12345678', message: '', refs: [], history: [] };
    expect(() => chat.params.parse(params)).toThrow(/message/);
  });

  test('ai.chat accepts a well-formed turn', () => {
    expect(
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hello',
        refs: ['note:1'],
        history: [{ role: 'user', content: 'earlier' }],
      }),
    ).toEqual({
      runId: 'run-12345678',
      message: 'hello',
      refs: ['note:1'],
      history: [{ role: 'user', content: 'earlier' }],
    });
  });

  test('ai.chat accepts up to four images', () => {
    const file = { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' };
    const params = {
      runId: 'run-12345678',
      message: 'what is this?',
      refs: [],
      history: [],
      files: [file, file, file, file],
    };
    expect(chat.params.parse(params)).toEqual(params);
  });

  test('ai.chat refuses a fifth image', () => {
    const file = { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' };
    expect(() =>
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hi',
        refs: [],
        history: [],
        files: [file, file, file, file, file],
      }),
    ).toThrow(/files/);
  });

  test('ai.chat refuses a media type that is not a bitmap image', () => {
    expect(() =>
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hi',
        refs: [],
        history: [],
        // SVG is a document that can carry script, not a picture.
        files: [{ name: 'logo.svg', mediaType: 'image/svg+xml', data: 'AAAA' }],
      }),
    ).toThrow(/mediaType/);
  });

  test('ai.chat refuses an image over two million characters', () => {
    expect(() =>
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hi',
        refs: [],
        history: [],
        files: [{ name: 'big.png', mediaType: 'image/png', data: 'A'.repeat(2_000_001) }],
      }),
    ).toThrow(/data/);
  });

  test('a chat event needs a known type', () => {
    expect(chat.event.parse({ type: 'text', text: 'x' })).toEqual({ type: 'text', text: 'x' });
    expect(() => chat.event.parse({ type: 'nope' })).toThrow(/type/);
  });

  test('ai.chat accepts a per-turn model id', () => {
    expect(
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hi',
        refs: [],
        history: [],
        modelId: 'gemma4:31b-mlx',
      }).modelId,
    ).toBe('gemma4:31b-mlx');
  });

  test('ai.chat refuses a model id longer than the bound', () => {
    expect(() =>
      chat.params.parse({
        runId: 'run-12345678',
        message: 'hi',
        refs: [],
        history: [],
        modelId: 'm'.repeat(201),
      }),
    ).toThrow(/modelId/);
  });

  test('a thread route refuses an id that is not one', () => {
    const get = aiContract.operations['ai.threadsGet'];
    expect(() => get.input.parse({ id: 'short' })).toThrow(/id/);
    expect(get.input.parse({ id: 'a'.repeat(32) })).toEqual({ id: 'a'.repeat(32) });
  });

  test('ai.threadsCreate takes nothing, a title, or a model', () => {
    const create = aiContract.operations['ai.threadsCreate'];
    expect(create.input.parse({})).toEqual({});
    expect(create.input.parse({ title: 'Groceries', modelId: null })).toEqual({
      title: 'Groceries',
      modelId: null,
    });
    expect(() => create.input.parse({ title: 'x'.repeat(121) })).toThrow(/title/);
  });

  test('ai.threadsSave bounds the messages and their parts', () => {
    const save = aiContract.operations['ai.threadsSave'];
    const id = 'b'.repeat(32);
    const message = { id: 'm1', role: 'user' as const, parts: [{ type: 'text', text: 'hi' }] };
    expect(save.input.parse({ id, messages: [message] })).toEqual({ id, messages: [message] });
    // A part is `unknown` by design; the *number* of them is not.
    expect(() =>
      save.input.parse({
        id,
        messages: [{ id: 'm1', role: 'user', parts: new Array(201).fill({ type: 'text' }) }],
      }),
    ).toThrow(/parts/);
    expect(() =>
      save.input.parse({ id, messages: new Array(201).fill(message) }),
    ).toThrow(/messages/);
    expect(() => save.input.parse({ id, messages: [{ ...message, role: 'tool' }] })).toThrow(/role/);
  });

  test('ai.settingsUpdate accepts a partial change', () => {
    const update = aiContract.operations['ai.settingsUpdate'];
    expect(update.input.parse({ remember: false })).toEqual({ remember: false });
    expect(update.input.parse({ apiKey: null })).toEqual({ apiKey: null });
  });
});
