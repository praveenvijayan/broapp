/**
 * The AI layer over a real bridge.
 *
 * Two host apps on one bridge — the application's and Broapp's — with a client
 * that speaks the merged contract, which is exactly the arrangement a real
 * application has. Nothing here reaches a provider: the fake adapter answers
 * in-process, so what is being tested is the layer, not a vendor.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterError, createAi, createFakeAdapter, guardedTool } from 'broapp/ai/host';
import type { ProviderAdapter } from 'broapp/ai/host';
import { aiContract } from 'broapp/ai';
import { createGate, createHostApp } from 'broapp/host';
import { defineContract, mergeContracts, s } from 'broapp/shared';
import { ollama, openai, openrouter } from 'broapp-ai-compatible';

import { harness, type Harness } from './harness.ts';

const appContract = defineContract({
  operations: { 'demo.ping': { input: s.void(), output: s.object({ pong: s.boolean() }) } },
  streams: {},
});

const merged = mergeContracts(appContract, aiContract);

/** A `fetch` that refuses, so a test cannot accidentally reach a provider. */
const noNetwork: typeof fetch = Object.assign(
  () => Promise.reject(new Error('no network in tests')),
  { preconnect: () => undefined },
);

let live: Harness | null = null;
let directory = '';

/** Start a bridge with the application and the AI layer mounted side by side. */
async function start(adapter: ProviderAdapter | readonly ProviderAdapter[], dataDir?: string): Promise<Harness> {
  directory = dataDir ?? (await mkdtemp(join(tmpdir(), 'broapp-ai-host-')));
  const app = createHostApp(appContract);
  app.operation('demo.ping', () => ({ pong: true }));
  const ai = createAi({
    dataDir: directory,
    providers: Array.isArray(adapter) ? [...adapter] : [adapter as ProviderAdapter],
    app: { name: 'test', purpose: 'testing the AI layer' },
    // Injected and never called: a test that can reach the network is a test
    // that can fail for reasons that have nothing to do with the code.
    fetch: noNetwork,
  });
  live = await harness((bridge) => {
    app.mount(bridge);
    ai.mount(bridge);
  });
  return live;
}

afterEach(async () => {
  await live?.stop();
  live = null;
  if (directory !== '') await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('the AI layer on a bridge', () => {
  test('a fresh installation is not set up', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    // The application's own routes still work: the two apps share a bridge.
    expect(await client.call('demo.ping', undefined)).toEqual({ pong: true });
    expect(await client.call('ai.settingsGet', undefined)).toEqual({
      provider: null,
      modelId: null,
      baseUrl: null,
      hasKey: false,
      keyHint: null,
      remember: true,
      configured: false,
      providers: [
        { id: 'fake', baseUrl: null, modelId: null, enabled: false, hasKey: false, keyHint: null, configured: true },
      ],
    });
  });

  test('lists the providers this build has', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    expect(await client.call('ai.providersList', undefined)).toEqual({
      providers: [
        {
          id: 'fake',
          label: 'Fake provider',
          local: true,
          needs: { apiKey: 'none', baseUrl: 'none' },
          defaultBaseUrl: null,
        },
      ],
    });
  });

  test('listing models before setup says so, rather than failing obscurely', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    await expect(client.call('ai.modelsList', undefined)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  test('a provider chosen with no model asks for a model, not for a provider', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake' });
    await expect(client.call('ai.connectionTest', undefined)).rejects.toMatchObject({
      message: 'Choose a model for Fake provider.',
    });
  });

  test('choosing a provider and model makes it configured', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    const settings = await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
    expect(settings.configured).toBe(true);
    expect(settings.provider).toBe('fake');
    expect(await client.call('ai.modelsList', undefined)).toEqual({
      models: [
        {
          provider: 'fake',
          modelId: 'fake-1',
          label: 'Fake 1',
          capabilities: { tools: true, vision: false, structuredOutput: true },
        },
      ],
    });
  });

  test('a provider that needs a key is not configured until it has one', async () => {
    const test = await start(createFakeAdapter({ needsKey: true }));
    const client = await test.connect(merged);

    const before = await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
    expect(before.configured).toBe(false);
    expect(before.hasKey).toBe(false);
    // The missing key is named, rather than "AI is not set up": the user has
    // chosen a provider and is looking at the panel.
    await expect(client.call('ai.connectionTest', undefined)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'An API key is required for Fake provider.',
    });

    const after = await client.call('ai.settingsUpdate', { apiKey: 'sk-test-1234abcd' });
    expect(after.configured).toBe(true);
    expect(after.hasKey).toBe(true);
    expect(after.keyHint).toBe('abcd');
    // The key itself must never come back to the browser, in any field.
    expect(JSON.stringify(after)).not.toContain('sk-test');
  });

  test('a remembered key survives a restart', async () => {
    const first = await start(createFakeAdapter({ needsKey: true }));
    const firstClient = await first.connect(merged);
    await firstClient.call('ai.settingsUpdate', {
      provider: 'fake',
      modelId: 'fake-1',
      apiKey: 'sk-test-1234abcd',
    });
    const dataDir = directory;
    await first.stop();
    live = null;

    const second = await start(createFakeAdapter({ needsKey: true }), dataDir);
    const secondClient = await second.connect(merged);
    const settings = await secondClient.call('ai.settingsGet', undefined);
    expect(settings.hasKey).toBe(true);
    expect(settings.configured).toBe(true);
  });

  test('turning remember off takes the key off the disk', async () => {
    const first = await start(createFakeAdapter({ needsKey: true }));
    const firstClient = await first.connect(merged);
    await firstClient.call('ai.settingsUpdate', {
      provider: 'fake',
      modelId: 'fake-1',
      apiKey: 'sk-test-1234abcd',
    });
    const forgotten = await firstClient.call('ai.settingsUpdate', { remember: false });
    expect(forgotten.hasKey).toBe(true);
    expect(forgotten.remember).toBe(false);

    const secrets = await readFile(join(directory, 'ai', 'secrets.json'), 'utf8').catch(() => '');
    expect(secrets).not.toContain('sk-test');

    const dataDir = directory;
    await first.stop();
    live = null;

    const second = await start(createFakeAdapter({ needsKey: true }), dataDir);
    const secondClient = await second.connect(merged);
    expect((await secondClient.call('ai.settingsGet', undefined)).hasKey).toBe(false);
  });

  test('a failed connection test is an answer, not an error', async () => {
    const adapter = createFakeAdapter({
      failTestWith: new AdapterError('auth', 'The API key was rejected.'),
    });
    const test = await start(adapter);
    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
    const result = await client.call('ai.connectionTest', undefined);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The API key was rejected.');
  });

  test('a successful connection test reports the provider', async () => {
    const test = await start(createFakeAdapter());
    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
    const result = await client.call('ai.connectionTest', undefined);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected to Fake provider.');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('an application that claims the ai group fails at startup', async () => {
    // Prompt 02 proved `createHostApp` refuses it; this proves the refusal is
    // not swallowed somewhere between there and a running host.
    const clashing = defineContract({
      operations: { 'ai.foo': { input: s.void(), output: s.void() } },
      streams: {},
    });
    await expect(
      harness((bridge) => {
        createHostApp(clashing).operation('ai.foo', () => undefined).mount(bridge);
      }),
    ).rejects.toThrow(/reserved/);
  });
});

describe('Ai.model()', () => {
  test('returns the configured adapter’s model instance, and says when nothing is configured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'broapp-ai-model-'));
    try {
      const adapter = createFakeAdapter();
      const ai = createAi({
        dataDir,
        providers: [adapter],
        app: { name: 'test', purpose: 'testing Ai.model' },
        fetch: noNetwork,
      });
      await expect(ai.model()).rejects.toMatchObject({ code: 'unavailable' });
      expect(adapter.modelCalls).toBe(0);

      await ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
      const model = await ai.model();
      expect(adapter.modelCalls).toBe(1);
      expect(model).toMatchObject({ provider: 'fake', modelId: 'fake-1' });
      // A conversation may pin a model within the configured provider.
      expect(await ai.model({ modelId: 'fake-2' })).toMatchObject({ modelId: 'fake-2' });
      ai.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Ai.turn()', () => {
  test('runs one turn in-process: the gate asks, the answer decides, and no provider is a failed turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'broapp-ai-turn-'));
    try {
      let ran = 0;
      const gate = createGate({ appId: 'app', releaseId: 'r1', confirmTimeoutMs: 5_000 });
      const write = guardedTool(gate, {
        name: 'demo.write',
        description: 'Write one thing.',
        inputSchema: s.object({ n: s.number() }).toJsonSchema(),
        effect: 'write',
        run: () => {
          ran += 1;
          return Promise.resolve({ wrote: true });
        },
      });
      // A fresh adapter each time, so each turn's script starts at its beginning.
      const make = (): ReturnType<typeof createAi> =>
        createAi({
          dataDir,
          providers: [
            createFakeAdapter({
              script: [{ kind: 'tool', name: 'demo.write', input: { n: 1 }, then: [{ kind: 'text', chunks: ['done'] }] }],
            }),
          ],
          app: { name: 'test', purpose: 'testing Ai.turn' },
          tools: { 'demo.write': write },
          fetch: noNetwork,
        });

      const unset = await make().turn({ runId: 'turn-unset-1', message: 'write one' }, { answer: () => true });
      expect(unset.status).toBe('failed');
      expect(unset.error).toContain('not set up');

      const ai = make();
      await ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
      const asked: string[] = [];
      const allowed = await ai.turn(
        { runId: 'turn-allow-1', message: 'write one' },
        { answer: ({ tool }) => (asked.push(tool), true) },
      );
      expect(allowed.status).toBe('succeeded');
      expect(asked).toEqual(['demo.write']);
      expect(ran).toBe(1);
      expect(allowed.events.map((event) => event.type)).toContain('confirm');

      // Declined: the tool never runs, and the model is told, as it would be by a person's No.
      const declined = await make().turn({ runId: 'turn-decline-1', message: 'write one' }, { answer: () => false });
      expect(declined.status).toBe('succeeded');
      expect(ran).toBe(1);
      expect(declined.events.some((event) => event.type === 'tool-result' && event.denied === true)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an answer of 'defer' leaves the question to ai.chatConfirm: yes runs the tool, no refuses it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'broapp-ai-defer-'));
    try {
      let ran = 0;
      const gate = createGate({ appId: 'app', releaseId: 'r1', confirmTimeoutMs: 5_000 });
      const write = guardedTool(gate, {
        name: 'demo.write',
        description: 'Write one thing.',
        inputSchema: s.object({ n: s.number() }).toJsonSchema(),
        effect: 'write',
        run: () => {
          ran += 1;
          return Promise.resolve({ wrote: true });
        },
      });
      const step = { kind: 'tool', name: 'demo.write', input: { n: 1 }, then: [{ kind: 'text', chunks: ['done'] }] } as const;
      const ai = createAi({
        dataDir,
        providers: [createFakeAdapter({ script: [step, step] })],
        app: { name: 'test', purpose: 'testing a deferred answer' },
        tools: { 'demo.write': write },
        fetch: noNetwork,
      });
      await ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
      live = await harness((bridge) => ai.mount(bridge));
      const client = await live.connect(aiContract);

      const deferred = async (runId: string, approve: boolean): Promise<Awaited<ReturnType<typeof ai.turn>>> => {
        let asked: { callId: string } | null = null;
        const turn = ai.turn(
          { runId, message: 'write one' },
          {
            answer: (question) => {
              asked = { callId: question.callId };
              expect(question.requestId).toBe(`${runId}:${question.callId}`);
              return 'defer';
            },
          },
        );
        while (asked === null) await Bun.sleep(5);
        const callId = (asked as { callId: string }).callId;
        // Nothing has run: the question waits for somebody else.
        await Bun.sleep(50);
        expect(ran).toBe(approve ? 0 : 1);
        expect((await client.call('ai.chatConfirm', { runId, callId, approve })).accepted).toBe(true);
        // Answered once: a second answer finds nobody waiting.
        expect((await client.call('ai.chatConfirm', { runId, callId, approve })).accepted).toBe(false);
        return await turn;
      };

      const yes = await deferred('turn-defer-yes', true);
      expect(yes.status).toBe('succeeded');
      expect(ran).toBe(1);

      const no = await deferred('turn-defer-no', false);
      expect(no.status).toBe('succeeded');
      expect(ran).toBe(1);
      expect(no.events.some((event) => event.type === 'tool-result' && event.denied === true)).toBe(true);
      ai.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/** A fresh data directory and an `Ai` over the given adapters, with a `fetch` that counts and refuses. */
async function multi(providers: readonly ProviderAdapter[]): Promise<{
  ai: ReturnType<typeof createAi>;
  dataDir: string;
  fetched: () => number;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'broapp-ai-multi-'));
  let count = 0;
  const counting: typeof fetch = Object.assign(
    () => {
      count += 1;
      return Promise.reject(new Error('no network in tests'));
    },
    { preconnect: () => undefined },
  );
  const ai = createAi({ dataDir, providers: [...providers], app: { name: 'test', purpose: 'test' }, fetch: counting });
  return { ai, dataDir, fetched: () => count };
}

describe('18a: every provider keeps its settings, and a reference may name one', () => {
  test('changing provider and changing back types nothing twice', async () => {
    const { ai, dataDir } = await multi([ollama(), openai()]);
    try {
      await ai.registry.update({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9999/v1', modelId: 'qwen3:27b' });
      await ai.registry.update({ provider: 'openai', baseUrl: 'https://gateway.example/v1', modelId: 'gpt-x' });
      const back = await ai.registry.update({ provider: 'ollama' });
      expect(back).toMatchObject({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9999/v1', modelId: 'qwen3:27b' });
      // B's settings are kept too, and it stays on: it was made active once.
      expect(back.providers.find((provider) => provider.id === 'openai')).toMatchObject({
        baseUrl: 'https://gateway.example/v1',
        modelId: 'gpt-x',
        enabled: true,
      });
      // A provider with no entry yet gets its default address, no model, and is turned on by being chosen.
      const fresh = await (await multi([ollama(), openai()])).ai.registry.update({ provider: 'openai' });
      expect(fresh).toMatchObject({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: null });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('resolve: a qualified reference runs on an enabled second provider, with its own key and address', async () => {
    const second = createFakeAdapter({ id: 'second', needsKey: true });
    const { ai, dataDir } = await multi([createFakeAdapter(), second]);
    try {
      // Nothing set up: "not set up" comes first, even for a reference naming another provider.
      await expect(ai.registry.resolve({ modelId: 'second:m' })).rejects.toMatchObject({
        message: 'AI is not set up yet. Open Settings to choose a provider.',
      });
      await ai.registry.update({ provider: 'fake', modelId: 'fake-1', apiKey: 'sk-first-key-0001' });
      await expect(ai.registry.resolve({ modelId: 'second:m' })).rejects.toMatchObject({
        code: 'unavailable',
        message: 'Fake provider is not turned on in Settings.',
      });
      await ai.registry.update({ target: 'second', enabled: true, baseUrl: 'http://second.example/v1' });
      // Turned on but its key missing: that provider's own sentence, not the first's.
      await expect(ai.registry.resolve({ modelId: 'second:m' })).rejects.toMatchObject({
        message: 'An API key is required for Fake provider.',
      });
      await ai.registry.update({ target: 'second', apiKey: 'sk-second-key-0002' });
      const resolved = await ai.registry.resolve({ modelId: 'second:m:with-colon' });
      expect(resolved.adapter.id).toBe('second');
      expect(resolved.modelId).toBe('m:with-colon');
      expect(resolved.config.apiKey).toBe('sk-second-key-0002');
      expect(resolved.config.baseUrl).toBe('http://second.example/v1');
      // Unqualified, and qualified with the provider in use, both run where they ran before.
      expect((await ai.registry.resolve({ modelId: 'other:thing' })).adapter.id).toBe('fake');
      expect(await ai.registry.resolve({ modelId: 'fake:fake-2' })).toMatchObject({ modelId: 'fake-2' });
      expect((await ai.registry.resolve()).config.apiKey).toBe('sk-first-key-0001');
      ai.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('a reference naming a provider that is not turned on sends nothing anywhere', async () => {
    const { ai, dataDir, fetched } = await multi([ollama(), openai()]);
    try {
      await ai.registry.update({ provider: 'ollama', modelId: 'qwen3:27b' });
      await ai.registry.update({ target: 'openai', apiKey: 'sk-openai-key-0003' });
      await expect(ai.registry.resolve({ modelId: 'openai:gpt-x' })).rejects.toMatchObject({
        message: 'OpenAI is not turned on in Settings.',
      });
      expect(await ai.registry.configOf('openai')).toBeNull();
      const turn = await ai.turn({ runId: 'turn-off-provider-1', message: 'hello', modelId: 'openai:gpt-x' }, { answer: () => true });
      expect(turn.status).toBe('failed');
      expect(turn.error).toContain('not turned on');
      expect(fetched()).toBe(0);
      ai.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('configFor gives a provider not in use its own stored address', async () => {
    const { ai, dataDir } = await multi([ollama(), openai()]);
    try {
      await ai.registry.update({ provider: 'openai', baseUrl: 'https://gateway.example/v1' });
      await ai.registry.update({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9999/v1' });
      const openaiAdapter = ai.registry.adapter('openai');
      expect(openaiAdapter).not.toBeNull();
      if (openaiAdapter === null) return;
      expect(ai.registry.configFor(openaiAdapter)).toMatchObject({ baseUrl: 'https://gateway.example/v1', apiKey: null });
      // And a provider nobody has set up gets its own default, never the one in use's.
      const { ai: other, dataDir: otherDir } = await multi([ollama(), openai()]);
      await other.registry.update({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9999/v1' });
      const unset = other.registry.adapter('openai');
      if (unset !== null) expect(other.registry.configFor(unset).baseUrl).toBe('https://api.openai.com/v1');
      await rm(otherDir, { recursive: true, force: true });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('ai.settingsUpdate with a target: its own key, the one in use unchanged, and remember moves every key', async () => {
    const test = await start([createFakeAdapter({ needsKey: true }), createFakeAdapter({ id: 'second', needsKey: true })]);
    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1', apiKey: 'sk-first-key-0001' });
    const after = await client.call('ai.settingsUpdate', { target: 'second', apiKey: 'sk-second-key-0002', enabled: true });
    expect(after.provider).toBe('fake');
    expect(after.keyHint).toBe('0001');
    expect(after.providers.find((provider) => provider.id === 'second')).toMatchObject({ enabled: true, hasKey: true, keyHint: '0002' });
    const secretsFile = join(directory, 'ai', 'secrets.json');
    const stored = JSON.parse(await readFile(secretsFile, 'utf8')) as { secrets: Record<string, string> };
    expect(stored.secrets['provider:second:apiKey']).toBe('sk-second-key-0002');
    expect(stored.secrets['provider:fake:apiKey']).toBe('sk-first-key-0001');

    await expect(client.call('ai.settingsUpdate', { enabled: false })).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'The provider in use cannot be turned off. Choose another first.',
    });
    await expect(client.call('ai.settingsUpdate', { target: 'fake', enabled: false })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.call('ai.settingsUpdate', { target: 'nobody' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.call('ai.settingsUpdate', { provider: 'second', target: 'fake' })).rejects.toMatchObject({ code: 'invalid_input' });

    const forgotten = await client.call('ai.settingsUpdate', { remember: false });
    expect(existsSync(secretsFile)).toBe(false);
    // Both keys still work, from memory.
    expect(forgotten.hasKey).toBe(true);
    expect(forgotten.providers.map((provider) => provider.hasKey)).toEqual([true, true]);
    const settingsRaw = await readFile(join(directory, 'ai', 'settings.json'), 'utf8');
    expect(settingsRaw).not.toContain('sk-');
  });

  test('AiSettings.providers: one per adapter in order, the top level equal to the one in use', async () => {
    const test = await start([ollama(), openai(), openrouter()]);
    const client = await test.connect(merged);
    const settings = await client.call('ai.settingsUpdate', { provider: 'openai', modelId: 'gpt-x', apiKey: 'sk-openai-key-0003' });
    expect(settings.providers.map((provider) => provider.id)).toEqual(['ollama', 'openai', 'openrouter']);
    const inUse = settings.providers[1];
    expect(inUse).toBeDefined();
    if (inUse === undefined) return;
    expect({
      provider: settings.provider,
      modelId: settings.modelId,
      baseUrl: settings.baseUrl,
      hasKey: settings.hasKey,
      keyHint: settings.keyHint,
    }).toEqual({ provider: inUse.id, modelId: inUse.modelId, baseUrl: inUse.baseUrl, hasKey: inUse.hasKey, keyHint: inUse.keyHint });
    expect(inUse.enabled).toBe(true);
    // An adapter with no entry: its default address, off, and configured as far as its needs go.
    expect(settings.providers[0]).toEqual({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: null,
      enabled: false,
      hasKey: false,
      keyHint: null,
      configured: true,
    });
    expect(settings.providers[2]).toMatchObject({ id: 'openrouter', enabled: false, configured: false });
  });
});
