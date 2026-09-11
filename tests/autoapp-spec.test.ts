/**
 * The application specification, the release store and the capability diff.
 *
 * The thread running through all of it: a release can be described, written,
 * read back and pointed at without ever running the application it describes.
 * So every test here works on data and directories, and none of them starts a
 * process or mounts a bridge.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError, defineContract, s } from 'broapp/shared';
import {
  capabilityKey,
  diffCapabilities,
  exportContract,
  isGranted,
  layout,
  listReleases,
  parseSpec,
  readCurrent,
  readGrants,
  readRelease,
  canonicalJson,
  releaseId,
  stripIdentity,
  setCurrent,
  writeGrants,
  writeRelease,
} from 'broapp-autoapp/spec';
import type { AppSpec, Capability } from 'broapp-autoapp/spec';

import { contract as notesContract } from '../examples/notes/src/shared/contract.ts';

let directory = '';

afterEach(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** A fresh launcher root for one test. */
function root(): ReturnType<typeof layout> {
  directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  return layout(directory);
}

const page = new TextEncoder().encode('<!doctype html><title>notes</title>');

/** The smallest view specification that is valid: one page, reading one source. */
const minimalViews = {
  specVersion: 1 as const,
  home: 'notes',
  pages: [
    {
      id: 'notes',
      title: 'Notes',
      sources: [{ id: 'all', operation: 'notes.list', input: {} }],
      children: [
        { id: 'all-notes', kind: 'text' as const, template: 'Notes: {{all.notes}}' },
      ],
    },
  ],
};
const host = new TextEncoder().encode('export const start = () => undefined;\n');

/** A checksum-shaped string, so the migration schema is satisfied. */
function checksum(of: string): string {
  return createHash('sha256').update(of).digest('hex');
}

/** The smallest specification that is actually valid. */
function minimalSpec(overrides: Partial<AppSpec> = {}): AppSpec {
  const contract = {
    operations: {
      'notes.list': {
        effect: 'read' as const,
        summary: 'Every note.',
        input: { type: 'object', properties: {} },
        output: { type: 'object', properties: {} },
      },
    },
    streams: {},
  };
  const spec: AppSpec = {
    manifest: {
      specVersion: 1,
      appId: 'notes',
      name: 'Notes',
      // Replaced by `resealed` below. The identity covers the whole
      // specification, so it cannot be computed until the rest of it exists.
      releaseId: '0'.repeat(32),
      createdAt: 1_700_000_000_000,
      runtime: { broapp: '0.2.1', autoapp: '0.1.0', bun: '1.4.0' },
      entry: { host: 'host.js', page: 'page.html' },
      schemaVersion: 0,
      capabilities: [],
    },
    contract,
    views: minimalViews,
    workflows: [],
    migrations: [],
    acceptance: [],
    ...overrides,
  };
  return resealed(spec);
}

/** The same specification, with its release identity brought back into line. */
function resealed(spec: AppSpec): AppSpec {
  return {
    ...spec,
    manifest: {
      ...spec.manifest,
      releaseId: releaseId({ page, host, spec }),
    },
  };
}

describe('parseSpec', () => {
  test('keeps a step’s match beside its expect', () => {
    const step = { route: 'notes.list', input: {}, expect: { notes: [] }, match: { notes: [] } };
    const spec = minimalSpec({ acceptance: [{ id: 'lists', title: 'Lists the notes.', steps: [step] }] });
    const parsed = parseSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.acceptance[0]?.steps[0]).toEqual(step);
  });

  test('a minimal specification round-trips', () => {
    const spec = minimalSpec();
    const parsed = parseSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed).toEqual(spec);
  });

  test('refuses an application id that could become a path', () => {
    const spec = minimalSpec();
    for (const appId of ['../escape', 'Notes', 'no', 'a/b']) {
      const broken = { ...spec, manifest: { ...spec.manifest, appId } };
      expect(() => parseSpec(broken)).toThrow(/appId/);
    }
  });

  test('refuses a release id that is not a truncated digest', () => {
    const spec = minimalSpec();
    const broken = { ...spec, manifest: { ...spec.manifest, releaseId: 'NOTHEX' } };
    expect(() => parseSpec(broken)).toThrow(/releaseId/);
  });

  test('refuses an entry that points outside the release', () => {
    const spec = minimalSpec();
    const absolute = { ...spec, manifest: { ...spec.manifest, entry: { host: '/etc/passwd', page: 'page.html' } } };
    expect(() => parseSpec(absolute)).toThrow(/relative/);
    const climbing = { ...spec, manifest: { ...spec.manifest, entry: { host: 'host.js', page: '../page.html' } } };
    expect(() => parseSpec(climbing)).toThrow(/\.\./);
  });

  test('refuses a route name Brobridge could not resolve', () => {
    const spec = minimalSpec();
    const broken = {
      ...spec,
      contract: {
        operations: { 'notes.deeply.nested': spec.contract.operations['notes.list'] },
        streams: {},
      },
    };
    expect(() => parseSpec(broken)).toThrow(/group\.member/);
  });

  test('refuses a route that does not say what it does', () => {
    const spec = minimalSpec();
    const { effect: _dropped, ...rest } = spec.contract.operations['notes.list'] as unknown as Record<
      string,
      unknown
    >;
    const broken = { ...spec, contract: { operations: { 'notes.list': rest }, streams: {} } };
    expect(() => parseSpec(broken)).toThrow(/effect/);
  });

  test('refuses a migration chain with a gap, a jump or the wrong end', () => {
    const base = minimalSpec();
    const step = (id: string, from: number, to: number) => ({
      id,
      fromSchemaVersion: from,
      toSchemaVersion: to,
      checksum: checksum(id),
      description: `step ${id}`,
    });

    const good = resealed({
      ...base,
      manifest: { ...base.manifest, schemaVersion: 2 },
      migrations: [step('001-first', 0, 1), step('002-second', 1, 2)],
    });
    expect(parseSpec(JSON.parse(JSON.stringify(good))).migrations).toHaveLength(2);

    const gap = { ...good, migrations: [step('001-first', 0, 1), step('003-third', 2, 3)] };
    expect(() => parseSpec(gap)).toThrow(/fromSchemaVersion/);

    const jump = { ...good, migrations: [step('001-first', 0, 2)] };
    expect(() => parseSpec(jump)).toThrow(/toSchemaVersion/);

    const unsorted = { ...good, migrations: [step('002-second', 0, 1), step('001-first', 1, 2)] };
    expect(() => parseSpec(unsorted)).toThrow(/sorted/);

    const wrongEnd = { ...good, manifest: { ...good.manifest, schemaVersion: 5 } };
    expect(() => parseSpec(wrongEnd)).toThrow(/schemaVersion/);

    const emptyButVersioned = { ...base, manifest: { ...base.manifest, schemaVersion: 1 } };
    expect(() => parseSpec(emptyButVersioned)).toThrow(/schemaVersion/);
  });

  test('refuses an acceptance example naming a route that is not there', () => {
    const spec = minimalSpec({
      acceptance: [
        { id: 'a1', title: 'List them', steps: [{ route: 'notes.missing', input: undefined }] },
      ],
    });
    expect(() => parseSpec(spec)).toThrow(/notes\.missing/);
  });

  test('refuses a capability that does not carry what its kind needs', () => {
    const withCapabilities = (capabilities: readonly Capability[]): unknown => {
      const spec = minimalSpec();
      return { ...spec, manifest: { ...spec.manifest, capabilities } };
    };
    expect(() => parseSpec(withCapabilities([{ kind: 'files', reason: 'To read notes.' }]))).toThrow(
      /at least one path/,
    );
    expect(() =>
      parseSpec(withCapabilities([{ kind: 'network', hosts: [], reason: 'To sync.' }])),
    ).toThrow(/at least one host/);
    expect(() =>
      parseSpec(withCapabilities([{ kind: 'spawn', paths: ['/bin/ls'], reason: 'To run.' }])),
    ).toThrow(/no paths/);
    expect(() =>
      parseSpec(withCapabilities([{ kind: 'network', hosts: ['https://x.example'], reason: 'To sync.' }])),
    ).toThrow(/format/);
  });

  test('refuses a field nobody would read', () => {
    const spec = minimalSpec();
    const smuggled = {
      ...spec,
      manifest: {
        ...spec.manifest,
        capabilities: [{ kind: 'spawn', reason: 'To run.', allowEverything: true }],
      },
    };
    expect(() => parseSpec(smuggled)).toThrow(/allowEverything/);
  });

  test('a failure is a ValidationError, so its issues can be shown', () => {
    try {
      parseSpec({});
      throw new Error('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ValidationError);
      expect((cause as ValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('exportContract', () => {
  test('exports the notes contract with the effects it declares', () => {
    const exported = exportContract(notesContract);
    expect(Object.keys(exported.operations).sort()).toEqual([
      'notes.backup',
      'notes.create',
      'notes.get',
      'notes.list',
      'notes.remove',
      'notes.status',
      'notes.update',
    ]);
    for (const route of ['notes.list', 'notes.get', 'notes.status']) {
      expect(exported.operations[route]?.effect).toBe('read');
    }
    for (const route of ['notes.create', 'notes.update', 'notes.remove', 'notes.backup']) {
      expect(exported.operations[route]?.effect).toBe('write');
    }
    for (const route of Object.values(exported.operations)) {
      expect(typeof route.input).toBe('object');
      expect(typeof route.output).toBe('object');
      expect(route.summary.length).toBeGreaterThan(0);
    }
    expect(exported.streams).toEqual({});
  });

  test('refuses a route that does not declare an effect', () => {
    const silent = defineContract({
      operations: {
        'demo.echo': { input: s.void(), output: s.void(), summary: 'Echoes.' },
      },
      streams: {},
    });
    expect(() => exportContract(silent)).toThrow(/demo\.echo/);
    expect(() => exportContract(silent)).toThrow(/effect/);
  });

  test('refuses a route with no summary', () => {
    const mute = defineContract({
      operations: { 'demo.echo': { effect: 'read', input: s.void(), output: s.void() } },
      streams: {},
    });
    expect(() => exportContract(mute)).toThrow(/summary/);
  });

  test('exports the params and event of a stream as input and output', () => {
    const streaming = defineContract({
      operations: {},
      streams: {
        'demo.ticks': {
          effect: 'read',
          summary: 'Counts.',
          params: s.object({ count: s.number({ int: true }) }),
          event: s.object({ n: s.number() }),
        },
      },
    });
    const exported = exportContract(streaming);
    expect(exported.streams['demo.ticks']?.input['properties']).toHaveProperty('count');
    expect(exported.streams['demo.ticks']?.output['properties']).toHaveProperty('n');
  });
});

describe('releaseId', () => {
  test('is a deterministic truncated digest of the three parts', () => {
    const spec = minimalSpec();
    const first = releaseId({ page, host, spec });
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(releaseId({ page, host, spec })).toBe(first);
  });

  test('changes when one byte of the page changes', () => {
    const spec = minimalSpec();
    const other = new Uint8Array(page);
    other[0] = (other[0] ?? 0) ^ 1;
    expect(releaseId({ page: other, host, spec })).not.toBe(releaseId({ page, host, spec }));
  });

  test('is unaffected by the order keys were written in', () => {
    const straight = minimalSpec({
      contract: {
        operations: {
          'a.one': { effect: 'read' as const, summary: 'One.', input: { type: 'object' }, output: { type: 'object' } },
        },
        streams: {},
      },
    });
    const shuffled = minimalSpec({
      contract: {
        streams: {},
        operations: {
          'a.one': { output: { type: 'object' }, input: { type: 'object' }, summary: 'One.', effect: 'read' as const },
        },
      } as AppSpec['contract'],
    });
    expect(releaseId({ page, host, spec: shuffled })).toBe(releaseId({ page, host, spec: straight }));
  });

  test('separates the parts, so moving the boundary changes the identity', () => {
    const spec = minimalSpec();
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(releaseId({ page: bytes('ab'), host: bytes('c'), spec })).not.toBe(
      releaseId({ page: bytes('a'), host: bytes('bc'), spec }),
    );
  });

  /**
   * The reason prompt 08b exists. Under the old rule these four all hashed to
   * the release they came from, and `activate` runs the acceptance examples as
   * its check — so somebody could add a check that could never reach a release.
   */
  test('covers acceptance, views, migrations and capabilities', () => {
    const base = minimalSpec();
    const identity = (spec: AppSpec): string => releaseId({ page, host, spec });

    const acceptance = minimalSpec({
      acceptance: [
        { id: 'lists', title: 'Lists the notes.', steps: [{ route: 'notes.list', input: {} }] },
      ],
    });
    expect(identity(acceptance)).not.toBe(identity(base));

    const views = minimalSpec({
      views: {
        ...minimalViews,
        pages: [{ ...minimalViews.pages[0]!, title: 'Notes, renamed' }],
      },
    });
    expect(identity(views)).not.toBe(identity(base));

    const migrations = minimalSpec({
      migrations: [
        {
          id: '001-create',
          fromSchemaVersion: 0,
          toSchemaVersion: 1,
          checksum: checksum('create'),
          description: 'Create the table.',
        },
      ],
    });
    expect(identity(migrations)).not.toBe(identity(base));

    const capabilities = minimalSpec({
      manifest: {
        ...base.manifest,
        capabilities: [{ kind: 'network' as const, hosts: ['example.com'], reason: 'To fetch.' }],
      },
    });
    expect(identity(capabilities)).not.toBe(identity(base));
  });

  test('is unaffected by when the build ran', () => {
    const base = minimalSpec();
    const later = { ...base, manifest: { ...base.manifest, createdAt: base.manifest.createdAt + 9_000 } };
    expect(releaseId({ page, host, spec: later })).toBe(releaseId({ page, host, spec: base }));
  });

  test('stripIdentity deletes the two build fields rather than blanking them', () => {
    const spec = minimalSpec();
    const stripped = stripIdentity(spec) as { manifest: Record<string, unknown> };
    expect('releaseId' in stripped.manifest).toBe(false);
    expect('createdAt' in stripped.manifest).toBe(false);
    expect(stripped.manifest['appId']).toBe('notes');
  });
});

describe('the release store', () => {
  test('writes a release and reads it back', () => {
    const store = root();
    const spec = minimalSpec();
    const written = writeRelease(store, spec, { page, host });
    expect(existsSync(join(written, 'spec.json'))).toBe(true);
    expect(readFileSync(join(written, 'page.html'))).toEqual(Buffer.from(page));
    expect(readRelease(store, 'notes', spec.manifest.releaseId)).toEqual(spec);
    expect(listReleases(store, 'notes')).toEqual([
      {
        releaseId: spec.manifest.releaseId,
        createdAt: spec.manifest.createdAt,
        schemaVersion: spec.manifest.schemaVersion,
        stale: false,
      },
    ]);
  });

  test('refuses to write the same release twice', () => {
    const store = root();
    const spec = minimalSpec();
    writeRelease(store, spec, { page, host });
    expect(() => writeRelease(store, spec, { page, host })).toThrow(/already exists/);
  });

  test('refuses a manifest whose identity is not the hash of its files', () => {
    const store = root();
    const spec = minimalSpec();
    const lying = { ...spec, manifest: { ...spec.manifest, releaseId: '0'.repeat(32) } };
    expect(() => writeRelease(store, lying, { page, host })).toThrow(/hash to/);
  });

  test('a staging directory left by a crash does not block a fresh write', () => {
    const store = root();
    const spec = minimalSpec();
    const app = store.app('notes');
    // Exactly what a crash between mkdir and rename would leave: a staging
    // directory with some of the files in it.
    const staging = `${app.release(spec.manifest.releaseId)}.incomplete`;
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'page.html'), 'half a page');

    const written = writeRelease(store, spec, { page, host });
    expect(existsSync(staging)).toBe(false);
    expect(readRelease(store, 'notes', spec.manifest.releaseId).manifest.name).toBe('Notes');
    expect(written.endsWith(spec.manifest.releaseId)).toBe(true);
  });

  test('a release whose directory was renamed is refused rather than trusted', () => {
    const store = root();
    const spec = minimalSpec();
    writeRelease(store, spec, { page, host });
    const app = store.app('notes');
    const impostor = app.release('f'.repeat(32));
    mkdirSync(impostor, { recursive: true });
    writeFileSync(
      join(impostor, 'spec.json'),
      readFileSync(join(app.release(spec.manifest.releaseId), 'spec.json')),
    );
    expect(() => readRelease(store, 'notes', 'f'.repeat(32))).toThrow(/says it is/);
    // And it is not listed, because listing reads each one back.
    expect(listReleases(store, 'notes').map((entry) => entry.releaseId)).toEqual([
      spec.manifest.releaseId,
    ]);
  });

  test('a release named the way the old rule named it is refused, not misread', () => {
    const store = root();
    const app = store.app('notes');
    const spec = minimalSpec({
      acceptance: [
        { id: 'lists', title: 'Lists the notes.', steps: [{ route: 'notes.list', input: {} }] },
      ],
    });

    // The identity as it was computed before prompt 08b: page, host bundle and
    // the exported contract, with nothing else in the digest. Built here rather
    // than imported, because the old function is gone and the point is that a
    // directory somebody already has on disk still reads correctly.
    const old = createHash('sha256');
    old.update(page);
    old.update(new Uint8Array([0]));
    old.update(host);
    old.update(new Uint8Array([0]));
    old.update(canonicalJson(spec.contract), 'utf8');
    const oldId = old.digest('hex').slice(0, 32);
    expect(oldId).not.toBe(spec.manifest.releaseId);

    const directory = app.release(oldId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'page.html'), page);
    writeFileSync(join(directory, 'host.js'), host);
    writeFileSync(
      join(directory, 'spec.json'),
      `${JSON.stringify({ ...spec, manifest: { ...spec.manifest, releaseId: oldId } }, null, 2)}\n`,
    );

    expect(() => readRelease(store, 'notes', oldId)).toThrow(
      /built by an earlier version of broapp-autoapp/,
    );
    // Listed and labelled rather than hidden: somebody whose `current` will not
    // start needs to see the release that is the reason.
    expect(listReleases(store, 'notes')).toEqual([
      { releaseId: oldId, createdAt: spec.manifest.createdAt, schemaVersion: 0, stale: true },
    ]);
  });

  test('the current pointer refuses an unknown release and survives a stale temporary', () => {
    const store = root();
    const spec = minimalSpec();
    expect(readCurrent(store, 'notes')).toBeNull();
    expect(() => setCurrent(store, 'notes', 'a'.repeat(32))).toThrow(/not there/);

    writeRelease(store, spec, { page, host });
    setCurrent(store, 'notes', spec.manifest.releaseId);
    expect(readCurrent(store, 'notes')).toBe(spec.manifest.releaseId);

    // What a crash between the write and the rename leaves behind.
    writeFileSync(`${store.app('notes').current}.tmp`, 'nonsense');
    setCurrent(store, 'notes', spec.manifest.releaseId);
    expect(readCurrent(store, 'notes')).toBe(spec.manifest.releaseId);

    // Moving the pointer to a different release replaces the existing file.
    // `renameSync` over one is atomic on POSIX; on Windows it goes through
    // `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which replaces but can
    // fail against a reader holding the file open. This case runs in the
    // Windows matrix job for exactly that reason.
    const next = minimalSpec({ manifest: { ...spec.manifest, name: 'Notes, later' } });
    expect(next.manifest.releaseId).not.toBe(spec.manifest.releaseId);
    writeRelease(store, next, { page, host });
    setCurrent(store, 'notes', next.manifest.releaseId);
    expect(readCurrent(store, 'notes')).toBe(next.manifest.releaseId);
  });

  test('listing an application that has never been written is empty, not an error', () => {
    const store = root();
    expect(listReleases(store, 'notes')).toEqual([]);
    expect(readCurrent(store, 'notes')).toBeNull();
  });
});

describe('layout', () => {
  test('refuses an application id that is not one', () => {
    const store = root();
    expect(() => store.app('bad id')).toThrow(TypeError);
    expect(() => store.app('../escape')).toThrow(TypeError);
    expect(() => store.app('no')).toThrow(TypeError);
  });

  test('refuses a release id that is not a truncated digest', () => {
    const store = root();
    expect(() => store.app('notes').release('../elsewhere')).toThrow(TypeError);
  });

  test('every application path is under the application directory', () => {
    const store = root();
    const app = store.app('notes');
    for (const path of [
      app.releases,
      app.release('a'.repeat(32)),
      app.source,
      app.data,
      app.dataNext,
      app.dataPrev(1),
      app.snapshots,
      app.current,
      app.grants,
    ]) {
      expect(path.startsWith(app.dir)).toBe(true);
    }
  });
});

describe('capabilities', () => {
  const read: Capability = { kind: 'files', paths: ['/b', '/a'], access: 'read', reason: 'To read.' };
  const readAgain: Capability = {
    kind: 'files',
    paths: ['/a', '/b'],
    access: 'read',
    reason: 'A different sentence entirely.',
  };
  const write: Capability = { kind: 'files', paths: ['/a'], access: 'write', reason: 'To write.' };
  const network: Capability = { kind: 'network', hosts: ['*.example.com'], reason: 'To sync.' };

  test('the key ignores path order and the reason', () => {
    expect(capabilityKey(read)).toBe(capabilityKey(readAgain));
    expect(capabilityKey(read)).not.toBe(capabilityKey(write));
    expect(capabilityKey({ kind: 'spawn', reason: 'To run.' })).toBe('spawn');
  });

  test('a rewording is unchanged, and a wider access is added', () => {
    const diff = diffCapabilities([readAgain, write], [read]);
    expect(diff.unchanged.map(capabilityKey)).toEqual([capabilityKey(read)]);
    expect(diff.added.map(capabilityKey)).toEqual([capabilityKey(write)]);
    expect(diff.removed).toEqual([]);
    expect(isGranted(diff)).toBe(false);
  });

  test('asking for less needs nobody', () => {
    const diff = diffCapabilities([read], [read, network]);
    expect(diff.added).toEqual([]);
    expect(diff.removed.map(capabilityKey)).toEqual([capabilityKey(network)]);
    expect(isGranted(diff)).toBe(true);
  });

  test('grants round-trip through the store', () => {
    const store = root();
    expect(readGrants(store, 'notes')).toBeNull();
    const grants = {
      appId: 'notes',
      releaseId: 'a'.repeat(32),
      grantedAt: 1_700_000_000_000,
      capabilities: [read, network],
    };
    writeGrants(store, 'notes', grants);
    expect(readGrants(store, 'notes')).toEqual(grants);
    expect(() => writeGrants(store, 'other-app', grants)).toThrow(/not other-app/);
  });
});

describe('view steps', () => {
  const example = (steps: unknown[]): Partial<AppSpec> => ({
    acceptance: [{ id: 'v1', title: 'Declares the notes text', steps: steps as never }],
  });

  test('a view step round-trips and needs no route', () => {
    const step = { view: { page: 'notes', component: 'all-notes', match: { kind: 'text' } } };
    const parsed = parseSpec(JSON.parse(JSON.stringify(minimalSpec(example([step])))));
    expect(parsed.acceptance[0]?.steps[0]).toEqual(step);
  });

  test('refuses a step that names both a route and a view, or neither', () => {
    expect(() =>
      parseSpec(minimalSpec(example([{ route: 'notes.list', input: {}, view: { page: 'notes' } }]))),
    ).toThrow(/not both and not neither/);
    expect(() => parseSpec(minimalSpec(example([{ input: {} }])))).toThrow(/not both and not neither/);
  });

  test('refuses a view step about a page the specification does not have', () => {
    expect(() => parseSpec(minimalSpec(example([{ view: { page: 'archive' } }])))).toThrow(
      /page "archive" is not in the view specification/,
    );
    // Unless the step says the page must not be there, which is what it is for.
    expect(() => parseSpec(minimalSpec(example([{ view: { page: 'archive', exists: false } }])))).not.toThrow();
  });
});
