/**
 * The secret store, against a real directory.
 *
 * The properties worth defending are the ones a user would be upset to find
 * broken: the key is only readable by them, turning "remember" off really does
 * forget it, and a damaged file loses the key rather than the application.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileSecretStore, createMemorySecretStore } from 'broapp/ai/host';
import { createSettingsStore } from '../packages/broapp/src/ai/host/settings.ts';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'broapp-ai-'));
});

afterEach(async () => {
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

describe('the file secret store', () => {
  test('round-trips a value', async () => {
    const store = createFileSecretStore(directory);
    expect(await store.get('provider:fake:apiKey')).toBeNull();
    await store.set('provider:fake:apiKey', 'sk-test-1234abcd');
    expect(await store.get('provider:fake:apiKey')).toBe('sk-test-1234abcd');
    await store.delete('provider:fake:apiKey');
    expect(await store.get('provider:fake:apiKey')).toBeNull();
  });

  test('survives a new instance on the same directory', async () => {
    await createFileSecretStore(directory).set('a', 'one');
    expect(await createFileSecretStore(directory).get('a')).toBe('one');
  });

  test.skipIf(process.platform === 'win32')('the file is readable only by its owner', async () => {
    const store = createFileSecretStore(directory);
    await store.set('a', 'one');
    // Not encryption — the same posture as ~/.aws/credentials. What it rules
    // out is another user on the machine and a world-readable backup.
    expect(statSync(join(directory, 'ai', 'secrets.json')).mode & 0o777).toBe(0o600);
  });

  test('a corrupt file yields null instead of throwing', async () => {
    await mkdir(join(directory, 'ai'), { recursive: true });
    await writeFile(join(directory, 'ai', 'secrets.json'), '{ not json', 'utf8');
    const store = createFileSecretStore(directory);
    expect(await store.get('a')).toBeNull();
    // And the damaged file is left alone rather than deleted, so it can be
    // looked at.
    expect(await readFile(join(directory, 'ai', 'secrets.json'), 'utf8')).toBe('{ not json');
  });

  test('deleting the last secret removes the file rather than leaving an empty one', async () => {
    const store = createFileSecretStore(directory);
    await store.set('a', 'one');
    await store.delete('a');
    expect(await readFile(join(directory, 'ai', 'secrets.json'), 'utf8').catch(() => null)).toBeNull();
  });
});

describe('the memory secret store', () => {
  test('forgets everything a new instance did not set', async () => {
    const first = createMemorySecretStore();
    await first.set('a', 'one');
    expect(await createMemorySecretStore().get('a')).toBeNull();
  });
});

describe('the settings store', () => {
  test('a missing file reads as defaults', () => {
    expect(createSettingsStore(directory).read()).toEqual({
      version: 1,
      provider: null,
      modelId: null,
      baseUrl: null,
      remember: true,
    });
  });

  test('never writes a key, whatever else it is given', async () => {
    const store = createSettingsStore(directory);
    store.write({ version: 1, provider: 'fake', modelId: 'fake-1', baseUrl: null, remember: true });
    const raw = await readFile(join(directory, 'ai', 'settings.json'), 'utf8');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-');
  });

  test('an unparsable file reads as defaults and is kept', async () => {
    await mkdir(join(directory, 'ai'), { recursive: true });
    await writeFile(join(directory, 'ai', 'settings.json'), 'nonsense', 'utf8');
    expect(createSettingsStore(directory).read().provider).toBeNull();
    expect(await readFile(join(directory, 'ai', 'settings.json'), 'utf8')).toBe('nonsense');
  });

  test('round-trips what it wrote', () => {
    const store = createSettingsStore(directory);
    store.write({ version: 1, provider: 'fake', modelId: 'fake-1', baseUrl: 'http://x/', remember: false });
    expect(store.read()).toEqual({
      version: 1,
      provider: 'fake',
      modelId: 'fake-1',
      baseUrl: 'http://x/',
      remember: false,
    });
  });
});

describe('isLoopbackUrl', () => {
  test('recognises this machine and nothing else', async () => {
    const { isLoopbackUrl } = await import('broapp/ai/host');
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:1234', 'http://[::1]:80/x']) {
      expect(`${url}: ${String(isLoopbackUrl(url))}`).toBe(`${url}: true`);
    }
    for (const url of ['https://api.anthropic.com/', 'http://127.0.0.1.example.com/', 'not a url', '']) {
      expect(`${url}: ${String(isLoopbackUrl(url))}`).toBe(`${url}: false`);
    }
  });
});
