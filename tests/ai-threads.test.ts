/**
 * Conversations, over a real bridge.
 *
 * The store is the user's own data, so most of what matters here is that it
 * behaves the same whether or not a provider is configured, that it never
 * keeps a copy of an image or of a key, and that a conversation's own model
 * reaches the adapter without letting a turn change the provider.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import type { ChatEvent, StoredMessage } from 'broapp/ai';
import type { BroappClient } from 'broapp/client';
import { createAi, createFakeAdapter } from 'broapp/ai/host';
import type { AdapterConfig, ProviderAdapter } from 'broapp/ai/host';
import { createHostApp } from 'broapp/host';
import { defineContract, mergeContracts, s } from 'broapp/shared';

import { harness, until, type Harness } from './harness.ts';

const appContract = defineContract({
  operations: { 'demo.ping': { input: s.void(), output: s.object({ pong: s.boolean() }) } },
  streams: {},
});

const merged = mergeContracts(appContract, aiContract);

const noNetwork: typeof fetch = Object.assign(
  () => Promise.reject(new Error('no network in tests')),
  { preconnect: () => undefined },
);

/**
 * The fake adapter, plus the model ids it was asked for.
 *
 * `FakeAdapter` counts `model()` calls but does not say which model each one
 * named, and that is exactly what a per-conversation model has to be proved
 * by. Recording it here rather than in `fake.ts` keeps the shipped fake as it
 * is.
 */
interface RecordingAdapter extends ProviderAdapter {
  readonly ids: string[];
}

function recordingAdapter(models?: readonly string[]): RecordingAdapter {
  const inner = createFakeAdapter(
    models === undefined
      ? {}
      : {
          models: models.map((modelId) => ({
            provider: 'fake',
            modelId,
            label: modelId,
            capabilities: { tools: true, vision: false, structuredOutput: true },
          })),
        },
  );
  const ids: string[] = [];
  return {
    id: inner.id,
    label: inner.label,
    needs: inner.needs,
    defaultBaseUrl: inner.defaultBaseUrl,
    local: (config: AdapterConfig) => inner.local(config),
    models: (config: AdapterConfig, signal: AbortSignal) => inner.models(config, signal),
    test: (config: AdapterConfig, signal: AbortSignal) => inner.test(config, signal),
    model: (config: AdapterConfig, modelId: string) => {
      ids.push(modelId);
      return inner.model(config, modelId);
    },
    ids,
  };
}

interface Started {
  readonly harness: Harness;
  readonly adapter: RecordingAdapter;
  readonly dataDir: string;
}

let live: Harness | null = null;
let directory = '';

async function start(
  options: { adapter?: RecordingAdapter; dataDir?: string; needsKey?: boolean } = {},
): Promise<Started> {
  directory = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'broapp-ai-threads-')));
  const adapter = options.adapter ?? recordingAdapter();
  const app = createHostApp(appContract);
  app.operation('demo.ping', () => ({ pong: true }));
  const ai = createAi({
    dataDir: directory,
    providers: [adapter],
    app: { name: 'test', purpose: 'testing conversations' },
    fetch: noNetwork,
    logger: { warn: () => undefined, error: () => undefined },
  });
  live = await harness((bridge) => {
    app.mount(bridge);
    ai.mount(bridge);
  });
  return { harness: live, adapter, dataDir: directory };
}

afterEach(async () => {
  await live?.stop();
  live = null;
  if (directory !== '') await rm(directory, { recursive: true, force: true });
  directory = '';
});

/** Run one `ai.chat` turn to the end, and report the error it carried, if any. */
async function drain(
  client: BroappClient<typeof merged>,
  params: {
    runId: string;
    message: string;
    refs: string[];
    history: [];
    modelId?: string;
  },
): Promise<{ events: ChatEvent[]; error: string | null }> {
  const events: ChatEvent[] = [];
  let error: string | null = null;
  let finished = false;
  await client.subscribe('ai.chat', params, {
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'error') error = event.message ?? 'error';
      if (event.type === 'done' || event.type === 'error') finished = true;
    },
    onDone: () => {
      finished = true;
    },
    // A refusal thrown by the host arrives as a stream error, not an event.
    onError: (cause) => {
      error = cause.message;
      finished = true;
    },
  });
  await until(() => finished, 5_000, 'the turn to end');
  return { events, error };
}

/** A user message with one text part, as `useChat` builds one. */
function user(text: string, id = 'm1'): StoredMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** A one-pixel PNG as a data URL, as an attachment carries one. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('conversations', () => {
  test('round trips through create, list, get, save, update, delete and clear', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);

    const first = await client.call('ai.threadsCreate', {});
    expect(first.title).toBe('New conversation');
    expect(first.modelId).toBeNull();
    expect(first.messageCount).toBe(0);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    const second = await client.call('ai.threadsCreate', { title: 'Second', modelId: 'fake-1' });
    expect(second.modelId).toBe('fake-1');

    const saved = await client.call('ai.threadsSave', {
      id: first.id,
      messages: [user('hello'), { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
    });
    expect(saved.messageCount).toBe(2);

    // Newest change first: the save bumped `first` past `second`.
    const listed = await client.call('ai.threadsList', undefined);
    expect(listed.threads.map((thread) => thread.id)).toEqual([first.id, second.id]);

    const loaded = await client.call('ai.threadsGet', { id: first.id });
    expect(loaded.messages).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    ]);

    const renamed = await client.call('ai.threadsUpdate', {
      id: second.id,
      title: 'Renamed',
      modelId: null,
    });
    expect(renamed.title).toBe('Renamed');
    expect(renamed.modelId).toBeNull();

    expect(await client.call('ai.threadsDelete', { id: second.id })).toEqual({ deleted: true });
    expect(await client.call('ai.threadsDelete', { id: second.id })).toEqual({ deleted: false });

    expect(await client.call('ai.threadsClear', undefined)).toEqual({ deleted: 1 });
    expect((await client.call('ai.threadsList', undefined)).threads).toEqual([]);
  });

  test('an image is stored as a placeholder, not as a copy of the picture', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);
    const thread = await client.call('ai.threadsCreate', {});

    await client.call('ai.threadsSave', {
      id: thread.id,
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [
            { type: 'text', text: 'what is this' },
            { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: PNG },
          ],
        },
      ],
    });

    const loaded = await client.call('ai.threadsGet', { id: thread.id });
    expect(loaded.messages[0]?.parts).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'text', text: '[image: shot.png]' },
    ]);

    // Not merely absent from the answer: absent from the file.
    const bytes = await readFile(join(started.dataDir, 'ai', 'threads.sqlite'));
    expect(bytes.toString('binary')).not.toContain('iVBORw0KGgo');
  });

  test('a title is derived from the first message, and an explicit one wins', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);

    const derived = await client.call('ai.threadsCreate', {});
    const afterSave = await client.call('ai.threadsSave', {
      id: derived.id,
      messages: [user('  How   many notes\ndo I have? ')],
    });
    expect(afterSave.title).toBe('How many notes do I have?');

    // Derivation happens once: a conversation that has a name keeps it.
    const later = await client.call('ai.threadsSave', {
      id: derived.id,
      messages: [user('something else entirely')],
    });
    expect(later.title).toBe('How many notes do I have?');

    const explicit = await client.call('ai.threadsCreate', {});
    const named = await client.call('ai.threadsSave', {
      id: explicit.id,
      messages: [user('anything')],
      title: 'My title',
    });
    expect(named.title).toBe('My title');

    const renamed = await client.call('ai.threadsUpdate', { id: explicit.id, title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
    const stillRenamed = await client.call('ai.threadsSave', {
      id: explicit.id,
      messages: [user('and again')],
    });
    expect(stillRenamed.title).toBe('Renamed');
  });

  test('an unknown conversation says so in words', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);
    await expect(client.call('ai.threadsGet', { id: 'c'.repeat(32) })).rejects.toMatchObject({
      code: 'not_found',
      message: 'That conversation is gone.',
    });
  });

  test('the routes work with no provider configured', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);
    expect((await client.call('ai.settingsGet', undefined)).configured).toBe(false);

    const thread = await client.call('ai.threadsCreate', { title: 'Kept' });
    await client.call('ai.threadsSave', { id: thread.id, messages: [user('still mine')] });
    const loaded = await client.call('ai.threadsGet', { id: thread.id });
    expect(loaded.thread.title).toBe('Kept');
    expect(loaded.messages).toHaveLength(1);
  });

  test('a stored conversation does not contain the configured key', async () => {
    const started = await start({ adapter: recordingAdapter() });
    const client = await started.harness.connect(merged);
    await client.call('ai.settingsUpdate', {
      provider: 'fake',
      modelId: 'fake-1',
      apiKey: 'sk-test-1234abcd',
    });

    const thread = await client.call('ai.threadsCreate', {});
    await client.call('ai.threadsSave', {
      id: thread.id,
      messages: [user('my key is not in here')],
    });

    const bytes = await readFile(join(started.dataDir, 'ai', 'threads.sqlite'));
    expect(bytes.toString('binary')).not.toContain('sk-test');
  });

  test('a per-turn model reaches the adapter, and without one Settings decides', async () => {
    const adapter = recordingAdapter(['fake-1', 'fake-2']);
    const started = await start({ adapter });
    const client = await started.harness.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });

    await drain(client, { runId: 'run-model-1', message: 'hello', refs: [], history: [] });
    expect(adapter.ids).toEqual(['fake-1']);

    await drain(client, {
      runId: 'run-model-2',
      message: 'hello',
      refs: [],
      history: [],
      modelId: 'fake-2',
    });
    expect(adapter.ids).toEqual(['fake-1', 'fake-2']);

    // The turn's model is not a settings change: the next turn is fake-1 again.
    expect((await client.call('ai.settingsGet', undefined)).modelId).toBe('fake-1');
  });

  test('a per-turn model does not make an unconfigured layer configured', async () => {
    const started = await start();
    const client = await started.harness.connect(merged);
    const events = await drain(client, {
      runId: 'run-model-3',
      message: 'hello',
      refs: [],
      history: [],
      modelId: 'fake-2',
    });
    expect(events.error).toBe('AI is not set up yet. Open Settings to choose a provider.');
  });

  test('the store survives a restart', async () => {
    const first = await start();
    const firstClient = await first.harness.connect(merged);
    const thread = await firstClient.call('ai.threadsCreate', { title: 'Before' });
    await firstClient.call('ai.threadsSave', { id: thread.id, messages: [user('written')] });
    const dataDir = first.dataDir;
    await first.harness.stop();
    live = null;

    const second = await start({ dataDir });
    const secondClient = await second.harness.connect(merged);
    const listed = await secondClient.call('ai.threadsList', undefined);
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]?.title).toBe('Before');
    expect(listed.threads[0]?.messageCount).toBe(1);
    expect((await secondClient.call('ai.threadsGet', { id: thread.id })).messages).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'written' }] },
    ]);
  });
  test('the order of two writes in the same millisecond is the order they happened', async () => {
    // `updated_at` is milliseconds, and three saves fit inside one. Ordering
    // by it left the tie to whichever random id sorted higher, so this ran
    // green and red on the same code (report 07). Thirty rounds, because one
    // round only fails when the clock happens not to tick.
    const started = await start();
    const client = await started.harness.connect(merged);

    for (let round = 0; round < 30; round += 1) {
      const one = await client.call('ai.threadsCreate', { title: 'one' });
      const two = await client.call('ai.threadsCreate', { title: 'two' });
      const three = await client.call('ai.threadsCreate', { title: 'three' });

      // No timer between them: whether the clock ticks is exactly what must
      // not decide the answer.
      await client.call('ai.threadsSave', { id: one.id, messages: [user('1')] });
      await client.call('ai.threadsSave', { id: three.id, messages: [user('3')] });
      await client.call('ai.threadsSave', { id: two.id, messages: [user('2')] });

      const listed = await client.call('ai.threadsList', undefined);
      expect(listed.threads.map((thread) => thread.id)).toEqual([two.id, three.id, one.id]);
      await client.call('ai.threadsClear', undefined);
    }
  }, 30_000);

  test('a store written before the sequence existed opens, keeps its order, and gains one', async () => {
    // `tests/fixtures/threads-v1.sqlite` was written by the code at 46e7a61 —
    // `user_version = 1`, no `seq` column — with three conversations and a
    // save on the oldest, so the order the old query gave is unambiguous.
    const dataDir = await mkdtemp(join(tmpdir(), 'broapp-ai-threads-v1-'));
    await mkdir(join(dataDir, 'ai'), { recursive: true });
    await copyFile(
      join(import.meta.dir, 'fixtures', 'threads-v1.sqlite'),
      join(dataDir, 'ai', 'threads.sqlite'),
    );

    const started = await start({ dataDir });
    const client = await started.harness.connect(merged);

    const listed = await client.call('ai.threadsList', undefined);
    expect(listed.threads.map((thread) => thread.title)).toEqual(['Oldest', 'Newest', 'Middle']);

    // And the new column decides the order from here on: saving the row at
    // the bottom of the list puts it at the top.
    const leastRecent = listed.threads[2];
    expect(leastRecent?.title).toBe('Middle');
    await client.call('ai.threadsSave', { id: leastRecent?.id ?? '', messages: [user('after')] });
    const after = await client.call('ai.threadsList', undefined);
    expect(after.threads.map((thread) => thread.title)).toEqual(['Middle', 'Oldest', 'Newest']);

    await started.harness.stop();
    live = null;
    const db = new Database(join(dataDir, 'ai', 'threads.sqlite'));
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(threads)')
      .all()
      .map((column) => column.name);
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    db.close();
    expect(columns).toContain('seq');
    expect(version?.user_version).toBe(2);
  });
});
