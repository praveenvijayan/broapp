/**
 * `createAi({ standIn })`: a chat turn's questions answered before anybody is
 * asked (prompt 20a).
 *
 * Over a real bridge and a scripted model, as `ai-chat.test.ts` drives
 * `ai.chat`, with a gate that records: what is under test is that the stand-in
 * settles a question without a `confirm` event while the gate still records
 * the answer exactly as for a click, that `'defer'` is today's path, and that
 * an in-process turn never consults it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import type { ChatEvent } from 'broapp/ai';
import { createAi, createFakeAdapter, guardedTool } from 'broapp/ai/host';
import type { Ai, StandInQuestion } from 'broapp/ai/host';
import { createGate } from 'broapp/host';
import type { ExecutionRecord } from 'broapp/host';
import { s } from 'broapp/shared';

import { harness, until, type Harness } from './harness.ts';

const noNetwork: typeof fetch = Object.assign(
  () => Promise.reject(new Error('no network in tests')),
  { preconnect: () => undefined },
);

let live: Harness | null = null;
let directory = '';

afterEach(async () => {
  await live?.stop();
  live = null;
  if (directory !== '') await rm(directory, { recursive: true, force: true });
  directory = '';
});

interface World {
  readonly ai: Ai;
  readonly records: ExecutionRecord[];
  readonly asked: StandInQuestion[];
  readonly ran: number;
}

/** An `Ai` with one write tool behind a recording gate, and the stand-in given. */
async function world(standIn?: (question: StandInQuestion) => boolean | 'defer'): Promise<World> {
  directory = await mkdtemp(join(tmpdir(), 'broapp-ai-standin-'));
  const records: ExecutionRecord[] = [];
  const asked: StandInQuestion[] = [];
  const gate = createGate({
    appId: 'app',
    releaseId: 'r1',
    confirmTimeoutMs: 5_000,
    recorder: { record: (record) => records.push(record) },
  });
  const counter = { ran: 0 };
  const write = guardedTool(gate, {
    name: 'demo.write',
    description: 'Write one thing.',
    inputSchema: s.object({ appId: s.string(), n: s.number() }).toJsonSchema(),
    effect: 'write',
    run: () => {
      counter.ran += 1;
      return Promise.resolve({ wrote: true });
    },
  });
  const step = {
    kind: 'tool',
    name: 'demo.write',
    input: { appId: 'items', n: 1 },
    then: [{ kind: 'text', chunks: ['done'] }],
  } as const;
  const ai = createAi({
    dataDir: directory,
    providers: [createFakeAdapter({ script: [step, step] })],
    app: { name: 'test', purpose: 'testing a stand-in' },
    tools: { 'demo.write': write },
    fetch: noNetwork,
    logger: { warn: () => undefined, error: () => undefined },
    ...(standIn === undefined
      ? {}
      : {
          standIn: (question: StandInQuestion) => {
            asked.push(question);
            return standIn(question);
          },
        }),
  });
  await ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
  live = await harness((bridge) => ai.mount(bridge));
  return {
    ai,
    records,
    asked,
    get ran() {
      return counter.ran;
    },
  };
}

/** One `ai.chat` turn; `onConfirm` answers a `confirm` event as a person would. */
async function chat(runId: string, onConfirm?: (callId: string) => boolean): Promise<ChatEvent[]> {
  if (live === null) throw new Error('no harness');
  const client = await live.connect(aiContract);
  const events: ChatEvent[] = [];
  let finished = false;
  await client.subscribe(
    'ai.chat',
    { runId, message: 'write one', refs: [], history: [] },
    {
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'confirm' && onConfirm !== undefined) {
          const callId = event.callId ?? '';
          void client.call('ai.chatConfirm', { runId, callId, approve: onConfirm(callId) });
        }
        if (event.type === 'done' || event.type === 'error') finished = true;
      },
      onDone: () => {
        finished = true;
      },
      onError: () => {
        finished = true;
      },
    },
  );
  await until(() => finished, 5_000, 'the turn to finish');
  await client.close();
  return events;
}

describe('20a: a stand-in on ai.chat', () => {
  test('true: the tool runs, no confirm event, and the gate records confirmed', async () => {
    const w = await world(() => true);
    const events = await chat('run-standin-yes');
    expect(events.some((event) => event.type === 'confirm')).toBe(false);
    expect(w.ran).toBe(1);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toMatchObject({ runId: 'run-standin-yes', tool: 'demo.write', input: { appId: 'items', n: 1 } });
    expect(w.asked[0]?.requestId).toBe(`run-standin-yes:${w.asked[0]?.callId ?? ''}`);
    const record = w.records.find((each) => each.route === 'demo.write');
    expect(record?.decision).toBe('confirmed');
    expect(record?.channel).toBe('ai');
  });

  test('false: the declined result, and the gate records denied', async () => {
    const w = await world(() => false);
    const events = await chat('run-standin-no');
    expect(events.some((event) => event.type === 'confirm')).toBe(false);
    expect(w.ran).toBe(0);
    expect(events.some((event) => event.type === 'tool-result' && event.denied === true)).toBe(true);
    expect(w.records.find((each) => each.route === 'demo.write')?.decision).toBe('denied');
  });

  test("'defer': the confirm event goes out and ai.chatConfirm answers it", async () => {
    const w = await world(() => 'defer');
    const events = await chat('run-standin-defer', () => true);
    expect(events.filter((event) => event.type === 'confirm')).toHaveLength(1);
    expect(w.asked).toHaveLength(1);
    expect(w.ran).toBe(1);
    expect(w.records.find((each) => each.route === 'demo.write')?.decision).toBe('confirmed');
  });

  test('a stand-in that throws has answered nothing: the person is asked', async () => {
    const w = await world(() => {
      throw new Error('broken');
    });
    const events = await chat('run-standin-throws', () => false);
    expect(events.filter((event) => event.type === 'confirm')).toHaveLength(1);
    expect(w.ran).toBe(0);
    expect(w.records.find((each) => each.route === 'demo.write')?.decision).toBe('denied');
  });

  test('Ai.turn with a stand-in set still asks its own answer, and never the stand-in', async () => {
    const w = await world(() => true);
    const answered: string[] = [];
    const result = await w.ai.turn(
      { runId: 'turn-standin-1', message: 'write one' },
      { answer: ({ tool }) => (answered.push(tool), false) },
    );
    expect(result.status).toBe('succeeded');
    expect(answered).toEqual(['demo.write']);
    expect(w.asked).toHaveLength(0);
    expect(w.ran).toBe(0);
    expect(result.events.some((event) => event.type === 'confirm')).toBe(true);
    w.ai.close();
  });
});
