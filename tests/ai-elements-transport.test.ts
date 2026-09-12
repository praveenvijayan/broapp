/**
 * The `useChat` transport, over a real bridge, against a scripted model.
 *
 * Nothing here renders: what is under test is the translation from Broapp's
 * `ChatEvent` stream to the AI SDK's `UIMessageChunk`s. Every case that cares
 * about parts folds the chunks with `readUIMessageStream`, so the SDK's own
 * processor — the one a browser would run — validates the sequence rather
 * than a hand-written expectation of it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUIMessageStream } from 'ai';
import type { UIMessageChunk } from 'ai';
import { aiContract } from 'broapp/ai';
import { createAi, createFakeAdapter, fromContract, guardedTool } from 'broapp/ai/host';
import type { Ai, FakeAdapter, FakeStep } from 'broapp/ai/host';
import type { AiClient, ToolCallState } from 'broapp/ai/react';
import { createGate, createHostApp, publicError } from 'broapp/host';
import type { BroappClient } from 'broapp/client';
import { defineContract, mergeContracts, s } from 'broapp/shared';
import { createBroappChatTransport } from 'broapp-ai-elements';
import type { BroappChatTransport, BroappUIMessage } from 'broapp-ai-elements';

import { harness, until, type Harness } from './harness.ts';

const appContract = defineContract({
  operations: {
    'notes.list': {
      input: s.object({ limit: s.optional(s.number({ int: true, min: 1, max: 50 })) }),
      output: s.object({ titles: s.array(s.string()) }),
      summary: 'List the titles of the notes in this application.',
    },
    'notes.create': {
      input: s.object({ title: s.string({ min: 1, max: 100 }) }),
      output: s.object({ ref: s.string() }),
      summary: 'Create a note with the given title.',
    },
  },
  streams: {},
});

const merged = mergeContracts(appContract, aiContract);

/** Documents the context providers hand back, keyed by ref. */
const LIBRARY: Record<string, { title: string; content: string }> = {
  'note:1': { title: 'Shopping', content: 'milk, bread, coffee' },
};

const noNetwork: typeof fetch = Object.assign(
  () => Promise.reject(new Error('no network in tests')),
  { preconnect: () => undefined },
);

interface Started {
  readonly harness: Harness;
  readonly adapter: FakeAdapter;
  readonly ai: Ai;
  readonly ran: Record<string, number>;
}

interface StartOptions {
  readonly script?: readonly FakeStep[];
  readonly chunkDelayMs?: number;
  /** Whether the fake model says it can read images. Default `false`. */
  readonly vision?: boolean;
  /** Leave the provider unset, to test the "not set up" path. */
  readonly skipSetup?: boolean;
}

let live: Harness | null = null;
let directory = '';

async function start(options: StartOptions = {}): Promise<Started> {
  directory = await mkdtemp(join(tmpdir(), 'broapp-ai-elements-'));
  const ran: Record<string, number> = { 'notes.list': 0, 'notes.create': 0, 'demo.cycle': 0, 'demo.build': 0 };

  // A tool that asks for one of its own steps under `<callId>.build`, the way
  // the launcher's candidate.cycle asks for its build and its preview.
  const gate = createGate({ appId: 'notes', releaseId: 'r1', confirmTimeoutMs: 5_000 });
  const build = guardedTool(gate, {
    name: 'demo.build',
    description: 'The step.',
    inputSchema: { type: 'object', properties: {} },
    effect: 'write',
    run: () => {
      ran['demo.build'] = (ran['demo.build'] ?? 0) + 1;
      return Promise.resolve({ built: true });
    },
  });
  const cycle = guardedTool(gate, {
    name: 'demo.cycle',
    description: 'A call with a step of its own.',
    inputSchema: { type: 'object', properties: {} },
    effect: 'write',
    run: async (_input, _signal, envelope) => {
      ran['demo.cycle'] = (ran['demo.cycle'] ?? 0) + 1;
      if (envelope === undefined) throw new Error('no envelope');
      const step = await build.execute({}, { ...envelope, requestId: `${envelope.requestId}.build` }, new AbortController().signal);
      return { step };
    },
  });

  const app = createHostApp(appContract);
  app.operation('notes.list', () => {
    ran['notes.list'] = (ran['notes.list'] ?? 0) + 1;
    return { titles: ['Shopping', 'Long'] };
  });
  app.operation('notes.create', ({ title }) => {
    ran['notes.create'] = (ran['notes.create'] ?? 0) + 1;
    return { ref: `note:${title}` };
  });

  const adapter = createFakeAdapter({
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
    ...(options.vision === undefined ? {} : { vision: options.vision }),
  });

  const ai = createAi({
    dataDir: directory,
    providers: [adapter],
    app: { name: 'Notes', purpose: 'It keeps notes.', terminology: ['note', 'notebook'] },
    fetch: noNetwork,
    context: {
      search: () => Promise.resolve([]),
      resolve: (refs) =>
        Promise.resolve(
          refs.flatMap((ref) => {
            const found = LIBRARY[ref];
            return found === undefined ? [] : [{ ref, title: found.title, content: found.content }];
          }),
        ),
    },
    tools: {
      ...fromContract(appContract, app, {
        read: ['notes.list'],
        confirm: ['notes.create'],
      }),
      'demo.cycle': cycle,
      'demo.build': build,
    },
    logger: { warn: () => undefined, error: () => undefined },
  });

  live = await harness((bridge) => {
    app.mount(bridge);
    ai.mount(bridge);
  });

  if (options.skipSetup !== true) {
    const client = await live.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
    await client.close();
  }
  return { harness: live, adapter, ai, ran };
}

afterEach(async () => {
  await live?.stop();
  live = null;
  if (directory !== '') await rm(directory, { recursive: true, force: true });
  directory = '';
});

/** A user message with one text part, as `useChat` would build it. */
function user(text: string, id = 'm-user'): BroappUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** A one-pixel PNG, as AI Elements' `PromptInput` hands one over. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** One image part on a user message. */
function imagePart(filename: string): BroappUIMessage['parts'][number] {
  return { type: 'file', mediaType: 'image/png', filename, url: PNG };
}

/** An assistant message with one text part. */
function assistant(text: string, id = 'm-assistant'): BroappUIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

/** A connected client and a transport talking to it. */
interface Wired {
  readonly client: BroappClient<typeof merged>;
  readonly transport: BroappChatTransport;
  readonly tools: ToolCallState[];
  readonly awaiting: number[];
}

async function wire(started: Started): Promise<Wired> {
  const client = await started.harness.connect(merged);
  const tools: ToolCallState[] = [];
  const awaiting: number[] = [];
  let runs = 0;
  const transport = createBroappChatTransport({
    client: () => Promise.resolve(client),
    runId: () => {
      runs += 1;
      return `run-elements-${String(runs)}`;
    },
    onToolResult: (call) => tools.push(call),
    onAwaiting: (pending) => awaiting.push(pending),
  });
  return { client, transport, tools, awaiting };
}

/** Every chunk the transport produced, in order. */
async function chunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) out.push(chunk);
  return out;
}

/** The final message, as the SDK's own processor builds it. */
async function fold(stream: ReadableStream<UIMessageChunk>): Promise<BroappUIMessage> {
  let last: BroappUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<BroappUIMessage>({
    stream,
    // An `error` chunk would otherwise throw out of the loop and lose the
    // snapshots before it; the cases that provoke one assert on chunks.
    terminateOnError: false,
  })) {
    last = snapshot;
  }
  if (last === undefined) throw new Error('the stream produced no message');
  return last;
}

/** The same stream, with every chunk also recorded as it passes. */
function watch(stream: ReadableStream<UIMessageChunk>): {
  readonly stream: ReadableStream<UIMessageChunk>;
  readonly seen: UIMessageChunk[];
} {
  const seen: UIMessageChunk[] = [];
  const spy = new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      seen.push(chunk);
      controller.enqueue(chunk);
    },
  });
  return { stream: stream.pipeThrough(spy), seen };
}

/** The call id the host is waiting on, once it has asked. */
function askedCallId(seen: readonly UIMessageChunk[]): string {
  const asked = seen.find((chunk) => chunk.type === 'tool-approval-request');
  if (asked === undefined) throw new Error('no confirmation was asked for');
  return asked.toolCallId;
}

/** Start a turn. `messages` ends with the user message being sent. */
function send(
  transport: BroappChatTransport,
  messages: BroappUIMessage[],
  options: { trigger?: 'submit-message' | 'regenerate-message'; abortSignal?: AbortSignal } = {},
): Promise<ReadableStream<UIMessageChunk>> {
  return transport.sendMessages({
    trigger: options.trigger ?? 'submit-message',
    chatId: 'chat-1',
    messageId: undefined,
    messages,
    abortSignal: options.abortSignal,
  });
}

describe('a plain reply', () => {
  test('becomes start, text, metadata, finish', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['Hel', 'lo'] }] });
    const wired = await wire(started);
    const seen = await chunks(await send(wired.transport, [user('hello')]));

    // `usage` reaches the browser before `done`, and the text part is closed
    // by `done` — so the metadata chunk lands before `text-end`. The SDK
    // attaches metadata to the message, not to the open part, so the order is
    // harmless and asserting it keeps the mapping honest. The first metadata
    // chunk names the run as soon as the message has text (12j), so a turn
    // stopped before `usage` still carries it.
    expect(seen.map((chunk) => chunk.type)).toEqual([
      'start',
      'text-start',
      'message-metadata',
      'text-delta',
      'text-delta',
      'message-metadata',
      'text-end',
      'finish',
    ]);
    await wired.client.close();
  });

  test('folds to one text part with usage', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['Hel', 'lo'] }] });
    const wired = await wire(started);
    const message = await fold(await send(wired.transport, [user('hello')]));

    expect(message.role).toBe('assistant');
    expect(message.parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'Hello', state: 'done' },
    ]);
    expect(typeof message.metadata?.usage?.inputTokens).toBe('number');
    await wired.client.close();
  });
});

describe('history', () => {
  test('earlier turns and the new message reach the model in order', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['ok'] }] });
    const wired = await wire(started);
    await chunks(
      await send(wired.transport, [
        user('first', 'm1'),
        assistant('answered', 'm2'),
        user('second', 'm3'),
      ]),
    );

    const prompt = JSON.stringify(started.adapter.calls[0]);
    expect(prompt).toContain('first');
    expect(prompt).toContain('answered');
    expect(prompt).toContain('second');
    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('answered'));
    expect(prompt.indexOf('answered')).toBeLessThan(prompt.indexOf('second'));
    await wired.client.close();
  });

  test('an empty assistant turn is not sent', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['ok'] }] });
    const wired = await wire(started);
    const empty: BroappUIMessage = { id: 'm2', role: 'assistant', parts: [] };
    await chunks(await send(wired.transport, [user('first', 'm1'), empty, user('second', 'm3')]));

    // Two user turns and no assistant turn: the transcript the model sees has
    // exactly the two lines that were said.
    const prompt = JSON.stringify(started.adapter.calls[0]);
    expect(prompt).toContain('first');
    expect(prompt).toContain('second');
    await wired.client.close();
  });
});

describe('tools', () => {
  test('a read tool becomes an output-available part, then text', async () => {
    const started = await start({
      script: [
        {
          kind: 'tool',
          name: 'notes.list',
          input: {},
          then: [{ kind: 'text', chunks: ['two notes'] }],
        },
      ],
    });
    const wired = await wire(started);
    const message = await fold(await send(wired.transport, [user('how many notes?')]));

    const tool = message.parts.find((part) => part.type === 'tool-notes.list');
    expect(tool).toMatchObject({ state: 'output-available', output: { titles: ['Shopping', 'Long'] } });
    expect(message.parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'two notes', state: 'done' },
    ]);
    expect(wired.tools).toHaveLength(1);
    expect(wired.tools[0]).toMatchObject({ tool: 'notes.list', status: 'done' });
    await wired.client.close();
  });

  test('a confirm tool waits, then runs when approved', async () => {
    const started = await start({
      script: [
        {
          kind: 'tool',
          name: 'notes.create',
          input: { title: 'New' },
          then: [{ kind: 'text', chunks: ['made it'] }],
        },
      ],
    });
    const wired = await wire(started);
    const watched = watch(await send(wired.transport, [user('make a note')]));
    const folding = fold(watched.stream);

    await until(() => wired.awaiting[0] === 1, 5_000, 'a confirmation to be asked');
    await wired.transport.confirm(askedCallId(watched.seen), true);

    const message = await folding;
    const tool = message.parts.find((part) => part.type === 'tool-notes.create');
    expect(tool).toMatchObject({ state: 'output-available', approval: { approved: true } });
    expect(started.ran['notes.create']).toBe(1);
    expect(wired.awaiting.at(-1)).toBe(0);
    expect(wired.tools[0]).toMatchObject({ tool: 'notes.create', status: 'done' });
    await wired.client.close();
  });

  test('a question about a step of a call goes on that call’s card, and its answer reaches the step', async () => {
    const started = await start({
      script: [{ kind: 'tool', name: 'demo.cycle', input: {}, then: [{ kind: 'text', chunks: ['cycled'] }] }],
    });
    const wired = await wire(started);
    const watched = watch(await send(wired.transport, [user('run the cycle')]));
    const folding = fold(watched.stream);

    // The call's own question first.
    await until(() => wired.awaiting[0] === 1, 5_000, 'the call to ask');
    const callId = askedCallId(watched.seen);
    await wired.transport.confirm(callId, true);

    // Then the step's, on the same card, naming the step.
    await until(() => watched.seen.filter((chunk) => chunk.type === 'tool-approval-request').length === 2, 5_000, 'the step to ask');
    const stepAsk = watched.seen.filter((chunk) => chunk.type === 'tool-approval-request')[1];
    expect(stepAsk).toMatchObject({ toolCallId: callId, approvalDescriptor: { tool: 'demo.build' } });
    expect(stepAsk?.type === 'tool-approval-request' ? stepAsk.approvalId : '').toMatch(/\.build$/);
    expect(wired.awaiting.at(-1)).toBe(1);
    // The card answers with its own id; the step is what runs.
    await wired.transport.confirm(callId, true);

    const message = await folding;
    const tool = message.parts.find((part) => part.type === 'tool-demo.cycle');
    expect(tool).toMatchObject({ state: 'output-available', output: { step: { built: true } } });
    expect(started.ran['demo.cycle']).toBe(1);
    expect(started.ran['demo.build']).toBe(1);
    expect(wired.awaiting.at(-1)).toBe(0);
    // Nothing threw inside the stream: the turn ended on its own.
    expect(watched.seen.some((chunk) => chunk.type === 'error')).toBe(false);
    await wired.client.close();
  });

  test('a declined tool does not run', async () => {
    const started = await start({
      script: [
        {
          kind: 'tool',
          name: 'notes.create',
          input: { title: 'New' },
          then: [{ kind: 'text', chunks: ['fine'] }],
        },
      ],
    });
    const wired = await wire(started);
    const watched = watch(await send(wired.transport, [user('make a note')]));
    const folding = fold(watched.stream);

    await until(() => wired.awaiting[0] === 1, 5_000, 'a confirmation to be asked');
    await wired.transport.confirm(askedCallId(watched.seen), false);

    const message = await folding;
    const tool = message.parts.find((part) => part.type === 'tool-notes.create');
    expect(tool).toMatchObject({ state: 'output-denied', approval: { approved: false } });
    expect(started.ran['notes.create']).toBe(0);
    expect(wired.awaiting.at(-1)).toBe(0);
    expect(wired.tools[0]).toMatchObject({ tool: 'notes.create', status: 'denied' });
    await wired.client.close();
  });

  test('answering a call nobody is waiting on says so', async () => {
    const started = await start({
      script: [
        {
          kind: 'tool',
          name: 'notes.create',
          input: { title: 'New' },
          then: [{ kind: 'text', chunks: ['fine'] }],
        },
      ],
    });
    const wired = await wire(started);
    const watched = watch(await send(wired.transport, [user('make a note')]));
    const folding = fold(watched.stream);

    await expect(wired.transport.confirm('nobody', true)).rejects.toThrow(
      'That request has expired.',
    );

    await until(() => wired.awaiting[0] === 1, 5_000, 'a confirmation to be asked');
    const callId = askedCallId(watched.seen);
    await wired.transport.confirm(callId, true);
    // The second answer has nothing left to answer: the call is settled.
    await expect(wired.transport.confirm(callId, true)).rejects.toThrow(
      'That request has expired.',
    );
    await folding;
    await wired.client.close();
  });
});

describe('ending a turn', () => {
  test('cancelling keeps the text so far and stops the host', async () => {
    const script = Array.from({ length: 40 }, (_, index) => `${String(index)} `);
    const started = await start({ script: [{ kind: 'text', chunks: script }], chunkDelayMs: 50 });
    const wired = await wire(started);
    const controller = new AbortController();
    const stream = await send(wired.transport, [user('count')], {
      abortSignal: controller.signal,
    });

    const seen: UIMessageChunk[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) {
      seen.push(chunk);
      if (chunk.type === 'text-delta') controller.abort();
    }

    expect(seen.some((chunk) => chunk.type === 'finish')).toBe(false);
    expect(seen.some((chunk) => chunk.type === 'error')).toBe(false);
    const text = seen
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(script.join('').length);
    await until(() => started.ai.activeStreams === 0, 2_000, 'the stream to close');
    await wired.client.close();
  });

  test('a second send while one runs is refused, not queued', async () => {
    const script = Array.from({ length: 20 }, () => 'x ');
    const started = await start({ script: [{ kind: 'text', chunks: script }], chunkDelayMs: 20 });
    const wired = await wire(started);
    const first = await send(wired.transport, [user('one')]);
    await until(() => wired.transport.active, 5_000, 'the first turn to open');
    const calls = started.adapter.modelCalls;

    const second = await chunks(await send(wired.transport, [user('two')]));
    expect(second).toEqual([{ type: 'error', errorText: 'A reply is still being written.' }]);
    expect(started.adapter.modelCalls).toBe(calls);

    await chunks(first);
    await wired.client.close();
  });

  test('a fifth image is refused before anything is sent', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['hi'] }], vision: true });
    const wired = await wire(started);
    const parts: BroappUIMessage['parts'] = [{ type: 'text', text: 'what are these?' }];
    for (let index = 0; index < 5; index += 1) parts.push(imagePart(`shot-${String(index)}.png`));
    const seen = await chunks(await send(wired.transport, [{ id: 'm1', role: 'user', parts }]));

    expect(seen).toEqual([{ type: 'error', errorText: 'Up to four images per message.' }]);
    expect(started.adapter.modelCalls).toBe(0);
    expect(wired.transport.active).toBe(false);
    await wired.client.close();
  });

  test('an image that cannot be read stops the turn', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['hi'] }], vision: true });
    const wired = await wire(started);
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'what is this?' },
        { type: 'file', mediaType: 'image/svg+xml', filename: 'logo.svg', url: 'data:image/svg+xml;base64,PHN2Zy8+' },
      ],
    };
    const seen = await chunks(await send(wired.transport, [message]));

    expect(seen.at(-1)).toEqual({
      type: 'error',
      errorText: 'Only PNG, JPEG, GIF and WebP images can be sent.',
    });
    expect(started.adapter.modelCalls).toBe(0);
    await wired.client.close();
  });

  test('nothing to send is refused', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['hi'] }] });
    const wired = await wire(started);

    expect(await chunks(await send(wired.transport, [user('   ')]))).toEqual([
      { type: 'error', errorText: 'Nothing to send.' },
    ]);
    expect(await chunks(await send(wired.transport, [assistant('mine')]))).toEqual([
      { type: 'error', errorText: 'Nothing to send.' },
    ]);
    await wired.client.close();
  });

  test('chatting before the provider is chosen says so', async () => {
    const started = await start({ skipSetup: true });
    const wired = await wire(started);
    const seen = await chunks(await send(wired.transport, [user('hello')]));

    const failure = seen.find((chunk) => chunk.type === 'error');
    expect(failure?.errorText).toContain('AI is not set up');
    expect(seen.some((chunk) => chunk.type === 'finish')).toBe(false);
    await wired.client.close();
  });

  test('regenerating a message behaves like sending it', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['Hel', 'lo'] }] });
    const wired = await wire(started);
    // `regenerate` trims the assistant reply before calling the transport, so
    // `messages` ends with the user message either way.
    const message = await fold(
      await send(wired.transport, [user('hello')], { trigger: 'regenerate-message' }),
    );

    expect(message.parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'Hello', state: 'done' },
    ]);
    await wired.client.close();
  });
});

describe('images', () => {
  test('an image reaches the model as a file part', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['a dot'] }], vision: true });
    const wired = await wire(started);
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'what is this?' }, imagePart('shot.png')],
    };
    await chunks(await send(wired.transport, [message]));

    const prompt = JSON.stringify(started.adapter.calls[0]);
    expect(prompt).toContain('"type":"file"');
    expect(prompt).toContain('image/png');
    expect(prompt).toContain('shot.png');
    await wired.client.close();
  });

  test('a model that cannot see refuses the turn', async () => {
    // `vision` defaults to false, which is what the fake model has always said.
    const started = await start({ script: [{ kind: 'text', chunks: ['a dot'] }] });
    const wired = await wire(started);
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'what is this?' }, imagePart('shot.png')],
    };
    const seen = await chunks(await send(wired.transport, [message]));

    expect(seen.find((chunk) => chunk.type === 'error')?.errorText).toBe(
      'The chosen model cannot read images. Pick one that can in Settings.',
    );
    expect(started.adapter.modelCalls).toBe(0);
    await wired.client.close();
  });

  test('a later turn carries a placeholder, not the image again', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['ok'] }], vision: true });
    const wired = await wire(started);
    const first: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'what is this?' }, imagePart('shot.png')],
    };
    await chunks(
      await send(wired.transport, [first, assistant('a dot', 'm2'), user('and now?', 'm3')]),
    );

    const prompt = JSON.stringify(started.adapter.calls[0]);
    expect(prompt).toContain('[image: shot.png]');
    // The history turn is a string: the picture was sent once, with the
    // message it arrived on.
    expect(prompt).not.toContain('"type":"file"');
    await wired.client.close();
  });

  test('two large images travel through the bridge intact', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['seen'] }], vision: true });
    const wired = await wire(started);
    // 1,900,000 base64 characters each: under the contract's per-file bound,
    // and together well past anything a single frame would carry by accident.
    const big = (name: string): BroappUIMessage['parts'][number] => ({
      type: 'file',
      mediaType: 'image/png',
      filename: name,
      url: `data:image/png;base64,${'A'.repeat(1_900_000)}`,
    });
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'what are these?' }, big('one.png'), big('two.png')],
    };
    const seen = await chunks(await send(wired.transport, [message]));

    expect(seen.some((chunk) => chunk.type === 'error')).toBe(false);
    const prompt = JSON.stringify(started.adapter.calls[0]);
    expect(prompt).toContain('one.png');
    expect(prompt).toContain('two.png');
    await wired.client.close();
  });
});

describe('a conversation with its own model', () => {
  test('sends modelId when one is set, and nothing when it is null', async () => {
    const started = await start({ script: [{ kind: 'text', chunks: ['ok'] }] });
    const client = await started.harness.connect(merged);
    const sent: Record<string, unknown>[] = [];
    let model: string | null = null;
    // A recording client: what matters is the params the turn carries, and
    // nothing on the host reports the model id back to the browser.
    const connected = client as unknown as AiClient;
    const spy: AiClient = {
      ...connected,
      subscribe: (route, params, handlers) => {
        sent.push(params as unknown as Record<string, unknown>);
        return connected.subscribe(route, params, handlers);
      },
    };
    const transport = createBroappChatTransport({
      client: () => Promise.resolve(spy),
      runId: () => `run-model-${String(sent.length + 1)}`,
      modelId: () => model,
    });

    await chunks(await send(transport, [user('first')]));
    expect(sent[0]).not.toHaveProperty('modelId');

    model = 'fake-2';
    await chunks(await send(transport, [user('second')]));
    expect(sent[1]?.['modelId']).toBe('fake-2');

    await client.close();
  });
});

