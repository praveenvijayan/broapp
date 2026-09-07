/**
 * The view specification, the renderer's bindings, and the host routes behind
 * them.
 *
 * The property under test throughout: an interface is data, and everything that
 * could go wrong with it is caught before a person clicks on it. A table
 * pointing at a route that does not exist, an action that deletes without
 * asking, an override naming a component a new release removed — each of those
 * has a check here rather than a failure at run time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage } from 'broapp/build';
import { createGate, createPendingApprovals, createReservedHostApp } from 'broapp/host';
import type { Envelope } from 'broapp/host';
import { defineContract, mergeContracts, s, ValidationError } from 'broapp/shared';
import { exportContract } from 'broapp-autoapp/spec';
import {
  applyOverrides,
  autoappContract,
  checkViewsAgainstContract,
  parseViews,
} from 'broapp-autoapp/shared';
import type { Overrides, ViewsSpec } from 'broapp-autoapp/shared';
import { createAutoappHost, createRunStore } from 'broapp-autoapp/host';
import { readPath, resolveInput, resolveValue } from 'broapp-autoapp/react';

import { contract as notesContract } from '../examples/notes/src/shared/contract.ts';
import { notesViews } from '../examples/notes/src/shared/views.ts';
import { harness, type Harness } from './harness.ts';

/** A deep copy, so a test that breaks a view specification breaks only its own. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('parseViews', () => {
  test('the Notes specification is valid', () => {
    const parsed = parseViews(copy(notesViews));
    expect(parsed.pages.map((page) => page.id)).toEqual(['notes', 'note', 'status']);
    expect(parsed.home).toBe('notes');
  });

  test('refuses a home page that is not there', () => {
    const broken = { ...copy(notesViews), home: 'nowhere' };
    expect(() => parseViews(broken)).toThrow(/nowhere/);
  });

  test('refuses two pages with the same id', () => {
    const views = copy(notesViews);
    const broken = { ...views, pages: [...views.pages, views.pages[0]] };
    expect(() => parseViews(broken)).toThrow(/used twice/);
  });

  test('refuses two components with the same id', () => {
    const views = copy(notesViews);
    const first = views.pages[0];
    if (first === undefined) throw new Error('the fixture lost its first page');
    const broken = {
      ...views,
      pages: [{ ...first, children: [...first.children, first.children[0]] }, ...views.pages.slice(1)],
    };
    expect(() => parseViews(broken)).toThrow(/component id/);
  });

  test('refuses two sources with the same id on one page', () => {
    const views = copy(notesViews);
    const first = views.pages[0];
    if (first === undefined) throw new Error('the fixture lost its first page');
    const broken = {
      ...views,
      pages: [{ ...first, sources: [...(first.sources ?? []), (first.sources ?? [])[0]] }, ...views.pages.slice(1)],
    };
    expect(() => parseViews(broken)).toThrow(/source id/);
  });

  test('refuses a component reading a source its page does not load', () => {
    const views = copy(notesViews);
    const first = views.pages[0];
    if (first === undefined) throw new Error('the fixture lost its first page');
    const broken = {
      ...views,
      pages: [{ ...first, sources: [] }, ...views.pages.slice(1)],
    };
    expect(() => parseViews(broken)).toThrow(/not loaded by this page/);
  });

  test('refuses a link to a page that is not there, or with the wrong arity', () => {
    const base = copy(notesViews);
    const table = (link: unknown): unknown => ({
      ...base,
      pages: [
        {
          id: 'notes',
          title: 'Notes',
          sources: [{ id: 'all', operation: 'notes.list', input: {} }],
          children: [
            {
              id: 'notes-table',
              kind: 'table',
              source: 'all',
              rows: 'notes',
              columns: [{ id: 'title', header: 'Title', path: 'title', link }],
            },
          ],
        },
        { id: 'note', title: 'Note', params: ['id'], children: [] },
      ],
      home: 'notes',
    });
    expect(() => parseViews(table({ page: 'nowhere', params: ['id'] }))).toThrow(/nowhere/);
    expect(() => parseViews(table({ page: 'note', params: [] }))).toThrow(/parameter/);
    expect(() => parseViews(table({ page: 'note', params: ['id'] }))).not.toThrow();
  });

  test('refuses a component that cannot be drawn at all', () => {
    const shell = (child: unknown): unknown => ({
      specVersion: 1,
      home: 'p',
      pages: [{ id: 'p', title: 'P', children: [child] }],
    });
    expect(() => parseViews(shell({ id: 'a', kind: 'text' }))).toThrow(/template/);
    expect(() => parseViews(shell({ id: 'a', kind: 'button' }))).toThrow(/action/);
    expect(() => parseViews(shell({ id: 'a', kind: 'form' }))).toThrow(/fields/);
    expect(() => parseViews(shell({ id: 'a', kind: 'status' }))).toThrow(/source/);
    expect(() => parseViews(shell({ id: 'a', kind: 'table' }))).toThrow(/source/);
    expect(() => parseViews(shell({ id: 'a', kind: 'section' }))).toThrow(/children/);
  });

  test('refuses a template that is not made only of placeholders and text', () => {
    const withTemplate = (template: string): unknown => ({
      specVersion: 1,
      home: 'p',
      pages: [
        {
          id: 'p',
          title: 'P',
          sources: [{ id: 'one', operation: 'notes.list', input: {} }],
          children: [{ id: 'a', kind: 'text', template }],
        },
      ],
    });
    expect(() => parseViews(withTemplate('You have {{one.notes.0.title}}.'))).not.toThrow();
    // An expression is the thing a view specification must never grow.
    expect(() => parseViews(withTemplate('{{ one.notes.length + 1 }}'))).toThrow(/placeholder/);
    expect(() => parseViews(withTemplate('{{missing.x}}'))).toThrow(/not loaded by this page/);
  });

  test('a failure is a ValidationError, so its issues can be shown', () => {
    try {
      parseViews({ specVersion: 1, home: 'p', pages: [] });
      throw new Error('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ValidationError);
    }
  });
});

describe('checkViewsAgainstContract', () => {
  const exported = exportContract(notesContract);

  test('the Notes specification agrees with the Notes contract', () => {
    expect(checkViewsAgainstContract(notesViews, exported)).toEqual([]);
  });

  test('a source on a route that changes something is refused', () => {
    const views = copy(notesViews) as ViewsSpec;
    const pages = views.pages.map((page) =>
      page.id === 'notes'
        ? { ...page, sources: [{ id: 'all', operation: 'notes.remove', input: { id: 1 } }] }
        : page,
    );
    const problems = checkViewsAgainstContract({ ...views, pages }, exported);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must be read');
  });

  test('a source naming a route that is not there is refused', () => {
    const views = copy(notesViews) as ViewsSpec;
    const pages = views.pages.map((page) =>
      page.id === 'notes' ? { ...page, sources: [{ id: 'all', operation: 'notes.gone' }] } : page,
    );
    const problems = checkViewsAgainstContract({ ...views, pages }, exported);
    expect(problems.some((problem) => problem.includes('notes.gone'))).toBe(true);
  });

  test('an action that changes something without asking is refused', () => {
    const views: ViewsSpec = {
      specVersion: 1,
      home: 'p',
      pages: [
        {
          id: 'p',
          title: 'P',
          children: [
            {
              id: 'wipe',
              kind: 'button',
              action: { id: 'go', label: 'Delete', operation: 'notes.remove', input: { id: 1 } },
            },
          ],
        },
      ],
    };
    const problems = checkViewsAgainstContract(views, exported);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('confirmText');
  });

  test('an input key the operation does not accept is refused', () => {
    const views: ViewsSpec = {
      specVersion: 1,
      home: 'p',
      pages: [
        {
          id: 'p',
          title: 'P',
          children: [
            {
              id: 'make',
              kind: 'button',
              action: {
                id: 'go',
                label: 'Add',
                operation: 'notes.create',
                confirmText: 'Add?',
                input: { title: 'x', body: 'y', colour: 'red' },
              },
            },
          ],
        },
      ],
    };
    const problems = checkViewsAgainstContract(views, exported);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('colour');
  });
});

describe('applyOverrides', () => {
  const views: ViewsSpec = {
    specVersion: 1,
    home: 'p',
    pages: [
      {
        id: 'p',
        title: 'P',
        sources: [{ id: 'all', operation: 'notes.list', input: {} }],
        children: [
          {
            id: 'grid',
            kind: 'table',
            label: 'Original',
            source: 'all',
            rows: 'notes',
            columns: [
              { id: 'title', header: 'Title', path: 'title' },
              { id: 'done', header: 'Done', path: 'done' },
            ],
          },
        ],
      },
    ],
  };

  test('a label and a hidden flag apply, and the input is untouched', () => {
    const overrides: Overrides = {
      version: 1,
      items: [{ componentId: 'grid', label: 'My notes', hidden: true }],
    };
    const before = JSON.stringify(views);
    const result = applyOverrides(views, overrides);
    expect(result.conflicts).toEqual([]);
    expect(result.views.pages[0]?.children[0]?.label).toBe('My notes');
    expect(result.views.pages[0]?.children[0]?.hidden).toBe(true);
    expect(result.views).not.toBe(views);
    expect(JSON.stringify(views)).toBe(before);
  });

  test('a header and a column order apply', () => {
    const result = applyOverrides(views, {
      version: 1,
      items: [{ componentId: 'grid', headers: { title: 'Heading' }, columnOrder: ['done'] }],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.views.pages[0]?.children[0]?.columns?.map((column) => column.id)).toEqual([
      'done',
      'title',
    ]);
    expect(
      result.views.pages[0]?.children[0]?.columns?.find((column) => column.id === 'title')?.header,
    ).toBe('Heading');
  });

  test('a header for a column that is gone is a conflict, not a silent drop', () => {
    const result = applyOverrides(views, {
      version: 1,
      items: [{ componentId: 'grid', headers: { colour: 'Colour' } }],
    });
    expect(result.conflicts).toEqual([{ componentId: 'grid', reason: 'column colour no longer exists' }]);
  });

  test('an override for a component that is gone is a conflict, not a silent drop', () => {
    const result = applyOverrides(views, {
      version: 1,
      items: [{ componentId: 'removed-in-this-release', label: 'Mine' }],
    });
    expect(result.conflicts).toEqual([
      { componentId: 'removed-in-this-release', reason: 'component no longer exists' },
    ]);
  });
});

describe('bindings', () => {
  const scope = {
    params: { id: '12' },
    fields: { title: 'Milk', done: true },
    row: { id: 7, note: { title: 'Bread' } },
    sources: { one: { notes: [{ title: 'First' }, { title: 'Second' }] } },
  };

  test('every reference form resolves', () => {
    expect(resolveValue('$param.id', scope)).toBe('12');
    expect(resolveValue('$field.title', scope)).toBe('Milk');
    expect(resolveValue('$field.done', scope)).toBe(true);
    expect(resolveValue('$row.id', scope)).toBe(7);
    expect(resolveValue('$row.note.title', scope)).toBe('Bread');
    expect(resolveValue('$source.one.notes.1.title', scope)).toBe('Second');
    // A literal is itself, whatever its type.
    expect(resolveValue('plain', scope)).toBe('plain');
    expect(resolveValue(42, scope)).toBe(42);
  });

  test('an unknown reference throws and names itself', () => {
    expect(() => resolveValue('$param.missing', scope)).toThrow(/\$param\.missing/);
    expect(() => resolveValue('$field.missing', scope)).toThrow(/\$field\.missing/);
    expect(() => resolveValue('$source.missing.x', scope)).toThrow(/\$source\.missing\.x/);
    expect(() => resolveValue('$row.id', { params: {} })).toThrow(/row action/);
    expect(() => resolveValue('$nonsense.x', scope)).toThrow(/not a reference/);
  });

  test('a path reads into arrays and stops at the end rather than throwing', () => {
    expect(readPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
    expect(readPath({ a: [] }, 'a.0.b')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath({ a: 1 }, '')).toEqual({ a: 1 });
  });

  test('an action input resolves every value, including nested ones', () => {
    expect(resolveInput({ id: '$row.id', tag: { from: '$param.id' } }, scope)).toEqual({
      id: 7,
      tag: { from: '12' },
    });
  });
});

describe('the autoapp host routes', () => {
  const views: ViewsSpec = {
    specVersion: 1,
    home: 'p',
    pages: [{ id: 'p', title: 'P', children: [{ id: 'note', kind: 'text', template: 'Hello.' }] }],
  };
  const merged = mergeContracts(
    defineContract({ operations: {}, streams: {} }),
    autoappContract,
  );

  let live: Harness | null = null;
  let directory = '';

  afterEach(async () => {
    await live?.stop();
    live = null;
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  async function start(): Promise<Harness> {
    directory = await mkdtemp(join(tmpdir(), 'autoapp-views-'));
    const quiet = { warn: () => undefined, error: () => undefined };
    const app = createReservedHostApp<typeof autoappContract>(autoappContract, { logger: quiet });
    const host = createAutoappHost({
      dataDir: directory,
      views,
      store: createRunStore(directory, quiet),
      contract: { operations: {}, streams: {} },
      app: app as never,
      isAttached: () => true,
      logger: quiet,
    });
    live = await harness((bridge) => host.mount(bridge));
    return live;
  }

  test('viewsGet returns the release views, and overrides come back applied', async () => {
    const test = await start();
    const client = await test.connect(merged);

    const first = await client.call('autoapp.viewsGet', undefined);
    expect(first.views.pages[0]?.children[0]?.label).toBeUndefined();
    expect(first.conflicts).toEqual([]);

    expect(
      await client.call('autoapp.overridesSet', {
        version: 1,
        items: [{ componentId: 'note', label: 'Mine' }],
      }),
    ).toEqual({ ok: true });

    const second = await client.call('autoapp.viewsGet', undefined);
    expect(second.views.pages[0]?.children[0]?.label).toBe('Mine');
    expect(await client.call('autoapp.overridesGet', undefined)).toEqual({
      version: 1,
      items: [{ componentId: 'note', label: 'Mine' }],
    });
    // Written where the next process will find it, not held in memory.
    expect(await readFile(join(directory, 'autoapp', 'overrides.json'), 'utf8')).toContain('Mine');
    await client.close();
  });

  test('an override that no longer applies is reported, not lost', async () => {
    const test = await start();
    const client = await test.connect(merged);
    await client.call('autoapp.overridesSet', {
      version: 1,
      items: [{ componentId: 'gone-in-this-release', label: 'Mine' }],
    });
    const result = await client.call('autoapp.viewsGet', undefined);
    expect(result.conflicts).toEqual([
      { componentId: 'gone-in-this-release', reason: 'component no longer exists' },
    ]);
    // Still on disk: a later release may bring the component back.
    expect(await client.call('autoapp.overridesGet', undefined)).toEqual({
      version: 1,
      items: [{ componentId: 'gone-in-this-release', label: 'Mine' }],
    });
    await client.close();
  });

  test('an agent cannot change a person’s interface without being approved', async () => {
    directory = await mkdtemp(join(tmpdir(), 'autoapp-views-'));
    // `overridesSet` is a write, so channel `ai` with nobody to ask is denied.
    // The route is reached through `invoke` because that is the door an AI tool
    // goes through; the bridge path is always channel `user`.
    // `createReservedHostApp` because `autoapp` is a reserved group: an
    // application may not declare it, and this contract is Broapp's own.
    const app = createReservedHostApp<typeof autoappContract>(autoappContract, {
      gate: createGate({ appId: 'demo', releaseId: 'unreleased', confirmTimeoutMs: 50 }),
      logger: { warn: () => undefined, error: () => undefined },
    });
    let wrote = 0;
    app.operation('autoapp.overridesGet', () => ({ version: 1, items: [] }));
    app.operation('autoapp.overridesSet', () => {
      wrote += 1;
      return { ok: true };
    });
    app.operation('autoapp.viewsGet', () => ({ views, conflicts: [] }));

    const asAgent: Envelope = { requestId: 'r1', channel: 'ai', caller: 'ai:test' };
    await expect(
      app.invoke('autoapp.overridesSet', { version: 1, items: [] }, asAgent),
    ).rejects.toThrow(/rejected/);
    expect(wrote).toBe(0);

    // With somebody to ask, and an answer, it runs.
    const approvals = createPendingApprovals({ warn: () => undefined, error: () => undefined });
    const asked: Envelope = { requestId: 'r2', channel: 'ai', caller: 'ai:test', approver: approvals };
    const running = app.invoke('autoapp.overridesSet', { version: 1, items: [] }, asked);
    while (approvals.pending.length === 0) await Bun.sleep(5);
    approvals.answer({ requestId: 'r2', approved: true });
    expect(await running).toEqual({ ok: true });
    expect(wrote).toBe(1);
  });
});

describe('the browser boundary', () => {
  let root = '';
  const template = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><!--BROAPP_HEAD--></head><body><div id="root"></div><!--BROAPP_BODY--></body></html>`;

  beforeAll(async () => {
    // Inside the repository, so module resolution can walk up to a
    // node_modules that has the workspace packages.
    root = join(import.meta.dir, '.views-fixture');
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.html'), template, 'utf8');
  });

  afterAll(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  async function build(name: string, source: string): Promise<string> {
    await writeFile(join(root, 'src', name), source, 'utf8');
    await buildPage({ root, entry: `src/${name}`, template: 'src/index.html', outFile: 'dist/out.html' });
    return readFile(join(root, 'dist', 'out.html'), 'utf8');
  }

  test('the shared layer carries no host symbols into a page', async () => {
    const html = await build(
      'shared.ts',
      `import { autoappContract } from 'broapp-autoapp/shared';
       document.title = autoappContract.routes.operations.join(',');`,
    );
    expect(html).toContain('autoapp.viewsGet');
    for (const symbol of ['node:fs', 'node:os', 'bun:sqlite', 'Bun.spawn', 'ensureDataDir']) {
      expect(html).not.toContain(symbol);
    }
  });

  test('the renderer carries no host symbols into a page', async () => {
    const html = await build(
      'renderer.tsx',
      `import { AutoappView } from 'broapp-autoapp/react';
       import 'broapp-autoapp/react/view.css';
       document.title = String(typeof AutoappView);`,
    );
    expect(html).toContain('autoapp-page');
    for (const symbol of ['node:fs', 'node:os', 'bun:sqlite', 'Bun.spawn', 'createAutoappHost']) {
      expect(html).not.toContain(symbol);
    }
  });

  test('a page that imports the Autoapp host fails to build', async () => {
    await writeFile(
      join(root, 'src', 'leak.ts'),
      `import { createAutoappHost } from 'broapp-autoapp/host';\nconsole.log(createAutoappHost);`,
      'utf8',
    );
    await expect(
      buildPage({ root, entry: 'src/leak.ts', template: 'src/index.html', outFile: 'dist/leak.html' }),
    ).rejects.toThrow();
  });
});
