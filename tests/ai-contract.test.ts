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
      'ai.settings.get',
      'ai.settings.update',
      'ai.providers.list',
      'ai.models.list',
      'ai.connection.test',
      'ai.chat.confirm',
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

  test('a chat event needs a known type', () => {
    expect(chat.event.parse({ type: 'text', text: 'x' })).toEqual({ type: 'text', text: 'x' });
    expect(() => chat.event.parse({ type: 'nope' })).toThrow(/type/);
  });

  test('ai.settings.update accepts a partial change', () => {
    const update = aiContract.operations['ai.settings.update'];
    expect(update.input.parse({ remember: false })).toEqual({ remember: false });
    expect(update.input.parse({ apiKey: null })).toEqual({ apiKey: null });
  });
});
