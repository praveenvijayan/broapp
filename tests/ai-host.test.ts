/**
 * The AI layer over a real bridge.
 *
 * Two host apps on one bridge — the application's and Broapp's — with a client
 * that speaks the merged contract, which is exactly the arrangement a real
 * application has. Nothing here reaches a provider: the fake adapter answers
 * in-process, so what is being tested is the layer, not a vendor.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterError, createAi, createFakeAdapter } from 'broapp/ai/host';
import type { ProviderAdapter } from 'broapp/ai/host';
import { aiContract } from 'broapp/ai';
import { createHostApp } from 'broapp/host';
import { defineContract, mergeContracts, s } from 'broapp/shared';

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
async function start(adapter: ProviderAdapter, dataDir?: string): Promise<Harness> {
  directory = dataDir ?? (await mkdtemp(join(tmpdir(), 'broapp-ai-host-')));
  const app = createHostApp(appContract);
  app.operation('demo.ping', () => ({ pong: true }));
  const ai = createAi({
    dataDir: directory,
    providers: [adapter],
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
          needs: { apiKey: false, baseUrl: 'none' },
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
    await expect(client.call('ai.connectionTest', undefined)).rejects.toMatchObject({
      code: 'unavailable',
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
