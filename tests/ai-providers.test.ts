/**
 * The two provider packages, against a `fetch` that never leaves the process.
 *
 * Each adapter is a small amount of code around one HTTP call, and the things
 * worth testing are exactly the ones that are easy to get wrong quietly: the
 * URL and headers actually sent, the order models come back in, and — most of
 * all — that a provider's error body never reaches the user's screen.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai } from 'broapp-ai-compatible';
import { aiContract } from 'broapp/ai';
import { AdapterError, createAi } from 'broapp/ai/host';
import type { AdapterConfig } from 'broapp/ai/host';

import { harness, type Harness } from './harness.ts';

/** Every request the stub saw. */
interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch & { seen: Seen[] } {
  const seen: Seen[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    seen.push({ url, headers });
    return handler(url, init);
  };
  return Object.assign(stub as unknown as typeof fetch, { seen, preconnect: () => undefined });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configWith(fetchImpl: typeof fetch, overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return { apiKey: null, baseUrl: null, fetch: fetchImpl, ...overrides };
}

const never = new AbortController().signal;

describe('the Anthropic adapter', () => {
  test('asks for models with the documented headers, capable models first', async () => {
    const fetchImpl = stubFetch(() =>
      json({
        data: [
          { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
          { id: 'claude-sonnet-5', display_name: 'Sonnet 5', created_at: '2026-01-01T00:00:00Z' },
          { id: 'claude-opus-5', display_name: 'Opus 5', created_at: '2026-02-01T00:00:00Z' },
        ],
        has_more: false,
      }),
    );
    const models = await anthropic().models(
      configWith(fetchImpl, { apiKey: 'sk-ant-test' }),
      never,
    );

    expect(fetchImpl.seen[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(fetchImpl.seen[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(fetchImpl.seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
    // The first entry is what a settings dialog will preselect, so the order
    // is part of the behaviour rather than an accident of the response.
    expect(models.map((model) => model.modelId)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(models[0]?.label).toBe('Opus 5');
  });

  test('follows pagination', async () => {
    let call = 0;
    const fetchImpl = stubFetch(() => {
      call += 1;
      return call === 1
        ? json({ data: [{ id: 'claude-opus-5' }], has_more: true, last_id: 'claude-opus-5' })
        : json({ data: [{ id: 'claude-haiku-4-5' }], has_more: false });
    });
    const models = await anthropic().models(configWith(fetchImpl, { apiKey: 'k' }), never);
    expect(models.map((model) => model.modelId)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
    expect(fetchImpl.seen[1]?.url).toContain('after_id=claude-opus-5');
  });

  test.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'provider'],
    [418, 'provider'],
  ])('status %i becomes a %s failure that does not quote the body', async (status, code) => {
    const fetchImpl = stubFetch(() => new Response('super-secret-body', { status: status as number }));
    try {
      await anthropic().models(configWith(fetchImpl, { apiKey: 'k' }), never);
      throw new Error('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(AdapterError);
      const error = cause as AdapterError;
      expect(error.code).toBe(code as AdapterError['code']);
      // A provider's body can echo the prompt back, or a fragment of the key.
      expect(error.message).not.toContain('super-secret-body');
    }
  });

  test('a fetch that throws is a network failure', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('connect ECONNREFUSED 1.2.3.4:443');
    });
    try {
      await anthropic().models(configWith(fetchImpl, { apiKey: 'k' }), never);
      throw new Error('should have thrown');
    } catch (cause) {
      expect((cause as AdapterError).code).toBe('network');
      expect((cause as AdapterError).message).not.toContain('ECONNREFUSED');
    }
  });

  test('knows whether requests leave the machine', () => {
    const fetchImpl = stubFetch(() => json({}));
    const adapter = anthropic();
    expect(adapter.local(configWith(fetchImpl))).toBe(false);
    expect(adapter.local(configWith(fetchImpl, { baseUrl: 'http://127.0.0.1:8080' }))).toBe(true);
  });

  test('refuses to build a model without a key', () => {
    const fetchImpl = stubFetch(() => json({}));
    expect(() => anthropic().model(configWith(fetchImpl), 'claude-opus-5')).toThrow(AdapterError);
    expect(() => anthropic().model(configWith(fetchImpl), 'claude-opus-5')).toThrow(/API key/);
  });

  test('builds a real model instance when it has one', () => {
    const fetchImpl = stubFetch(() => json({}));
    const model = anthropic().model(configWith(fetchImpl, { apiKey: 'k' }), 'claude-opus-5');
    // A string here would be resolved by the AI SDK's gateway instead; see
    // reports/01-spike.md.
    expect(typeof model).not.toBe('string');
  });
});

describe('the OpenAI-compatible adapter', () => {
  test('Ollama asks the loopback address and sends no Authorization header', async () => {
    const fetchImpl = stubFetch(() => json({ data: [{ id: 'llama3' }, { id: 'gemma' }] }));
    const models = await ollama().models(configWith(fetchImpl), never);

    expect(fetchImpl.seen[0]?.url).toBe('http://127.0.0.1:11434/v1/models');
    expect(fetchImpl.seen[0]?.headers['authorization']).toBeUndefined();
    expect(models.map((model) => model.modelId)).toEqual(['gemma', 'llama3']);
    expect(models[0]?.capabilities).toEqual({
      tools: true,
      vision: false,
      structuredOutput: false,
    });
  });

  test('OpenAI sends the key as a bearer token', async () => {
    const fetchImpl = stubFetch(() => json({ data: [{ id: 'gpt-4o' }] }));
    await openai().models(configWith(fetchImpl, { apiKey: 'sk-openai' }), never);
    expect(fetchImpl.seen[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(fetchImpl.seen[0]?.headers['authorization']).toBe('Bearer sk-openai');
  });

  test('a failure names the server without quoting it', async () => {
    const fetchImpl = stubFetch(() => new Response('super-secret-body', { status: 401 }));
    try {
      await openai().models(configWith(fetchImpl, { apiKey: 'k' }), never);
      throw new Error('should have thrown');
    } catch (cause) {
      expect((cause as AdapterError).code).toBe('auth');
      expect((cause as AdapterError).message).toBe('OpenAI rejected the API key.');
    }
  });

  test('local is about the address, not the vendor', () => {
    const fetchImpl = stubFetch(() => json({}));
    expect(ollama().local(configWith(fetchImpl))).toBe(true);
    expect(openai().local(configWith(fetchImpl))).toBe(false);
    expect(customServer().local(configWith(fetchImpl))).toBe(false);
    expect(customServer().local(configWith(fetchImpl, { baseUrl: 'http://localhost:8000/v1' }))).toBe(
      true,
    );
  });

  test('a server that needs an address refuses to build a model without one', () => {
    const fetchImpl = stubFetch(() => json({}));
    expect(() => customServer().model(configWith(fetchImpl), 'x')).toThrow(/server URL/);
  });

  test('a provider that needs a key refuses to build a model without one', () => {
    const fetchImpl = stubFetch(() => json({}));
    expect(() => openai().model(configWith(fetchImpl), 'gpt-4o')).toThrow(/API key/);
  });

  test('builds a chat model when it has what it needs', () => {
    const fetchImpl = stubFetch(() => json({}));
    expect(typeof ollama().model(configWith(fetchImpl), 'llama3')).not.toBe('string');
  });
});

describe('both providers in a running application', () => {
  let live: Harness | null = null;
  let directory = '';

  afterEach(async () => {
    await live?.stop();
    live = null;
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  test('settings, models and the connection test work end to end', async () => {
    directory = await mkdtemp(join(tmpdir(), 'broapp-ai-providers-'));
    const fetchImpl = stubFetch((url) =>
      url.startsWith('https://api.anthropic.com')
        ? json({ data: [{ id: 'claude-opus-5', display_name: 'Opus 5' }], has_more: false })
        : json({ data: [{ id: 'llama3' }] }),
    );
    const ai = createAi({
      dataDir: directory,
      providers: [anthropic(), ollama()],
      app: { name: 'test', purpose: 'testing providers' },
      fetch: fetchImpl,
    });
    live = await harness((bridge) => ai.mount(bridge));
    const client = await live.connect(aiContract);

    const providers = await client.call('ai.providersList', undefined);
    expect(providers.providers.map((entry) => [entry.id, entry.local])).toEqual([
      ['anthropic', false],
      ['ollama', true],
    ]);

    // Selecting the local provider stores its loopback address. That address
    // belongs to Ollama alone: reporting Anthropic as local because of it
    // would be exactly the wrong answer to "does this leave my computer".
    await client.call('ai.settingsUpdate', { provider: 'ollama' });
    const afterSelecting = await client.call('ai.providersList', undefined);
    expect(afterSelecting.providers.map((entry) => [entry.id, entry.local])).toEqual([
      ['anthropic', false],
      ['ollama', true],
    ]);

    await client.call('ai.settingsUpdate', {
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      apiKey: 'sk-ant-test-1234',
    });
    expect(await client.call('ai.modelsList', undefined)).toEqual({
      models: [
        {
          provider: 'anthropic',
          modelId: 'claude-opus-5',
          label: 'Opus 5',
          capabilities: { tools: true, vision: true, structuredOutput: true },
        },
      ],
    });

    const tested = await client.call('ai.connectionTest', undefined);
    expect(tested.ok).toBe(true);
    expect(tested.message).toBe('Connected to Anthropic.');
    // The key travelled to the provider and nowhere else.
    expect(fetchImpl.seen.every((entry) => entry.url.startsWith('https://api.anthropic.com'))).toBe(
      true,
    );
    await client.close();
  });
});
