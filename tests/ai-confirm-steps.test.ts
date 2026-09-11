/**
 * A question about one of a tool call's own steps goes on that call's card.
 *
 * The launcher's `candidate.cycle` asks once for its patch, then once each for
 * the build and the preview, as `<callId>.build` and `<callId>.preview`. The
 * chat has one card per tool call; these are the two pure functions that put a
 * step's question on its parent's card and take it off again once answered.
 */
import { describe, expect, test } from 'bun:test';

import { attachConfirm, settleAnswer, type ToolCallState } from '../packages/broapp/src/ai/react/use-ai-chat.ts';

const card = (callId: string, status: ToolCallState['status'] = 'running'): ToolCallState => ({
  callId,
  tool: 'candidate.cycle',
  input: { appId: 'items' },
  status,
});

describe('questions about a call’s own steps', () => {
  test('a question naming the call is the call’s own, as before', () => {
    const [cycle, other] = attachConfirm([card('call-1'), card('call-2')], { callId: 'call-1', expiresAt: 5 });
    expect(cycle).toEqual({ ...card('call-1'), status: 'awaiting-confirmation', expiresAt: 5 });
    expect(other).toEqual(card('call-2'));
  });

  test('a step’s question goes on its parent, saying what it asks about and answering with the step’s id', () => {
    const [cycle, other] = attachConfirm([card('call-1'), card('call-10')], {
      callId: 'call-1.build',
      tool: 'candidate.build',
      input: { appId: 'items' },
      expiresAt: 9,
    });
    expect(cycle).toMatchObject({
      status: 'awaiting-confirmation',
      confirmId: 'call-1.build',
      asks: 'candidate.build',
      asksInput: { appId: 'items' },
      expiresAt: 9,
    });
    // `call-10` begins with `call-1` but is not its step: the separator decides.
    expect(other).toEqual(card('call-10'));
  });

  test('an accepted answer takes the question off, so the next step can ask again', () => {
    const asked = attachConfirm([card('call-1')], { callId: 'call-1.build', tool: 'candidate.build' });
    const [settled] = settleAnswer(asked, 'call-1.build');
    expect(settled).toEqual(card('call-1'));
    const again = attachConfirm([settled ?? card('call-1')], { callId: 'call-1.preview', tool: 'candidate.preview' });
    expect(again[0]).toMatchObject({ confirmId: 'call-1.preview', asks: 'candidate.preview' });
    // And an answer to the call's own question settles it the same way.
    expect(settleAnswer([card('call-2', 'awaiting-confirmation')], 'call-2')[0]).toEqual(card('call-2'));
  });
});
