/**
 * Choosing where an application lives from the form (19b).
 *
 * Numbered as 19b's verification list is, so a failure names the item. None
 * of these opens a window: the route's chooser is given a spawn that answers
 * as a dialog would, the form and Locate… are driven through the controllers
 * `AppsTable` draws, and what they draw is rendered to a string.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';

import { createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, HostLogger } from 'broapp/host';
import { BroappProvider } from 'broapp/react';
import { createCandidateStates } from 'broapp-autoapp/engineer';
import {
  chooserCommand,
  createFolderChooser,
  createLauncherApp,
  createSupervisor,
  launcherContract,
  LOCATION_WORDS,
  openJournal,
  trimChosen,
  usableStart,
  workspaceSentence,
  type ChooserCommand,
  type ChooserProcess,
  type Journal,
  type LauncherApp,
  type SpawnChooser,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout } from 'broapp-autoapp/spec';

import {
  AppsTable,
  CreationFailure,
  RemovalWords,
  RemovedNotice,
  WhereItLives,
  WorkspaceLine,
  type AppRow,
} from '../packages/broapp-autoapp/src/launcher/ui/AppsTable.tsx';
import {
  createInput,
  createLocateControl,
  createNewApplicationForm,
  parentOf,
  type CheckOutput,
  type ChooseOutput,
  type CreateInput,
  type CreateOutput,
  type LastLocation,
  type NewApplicationForm,
  type Timers,
} from '../packages/broapp-autoapp/src/launcher/ui/new-application.ts';
import { onReturn } from '../packages/broapp-autoapp/src/launcher/ui/on-return.ts';
import { remember, rememberedText } from '../packages/broapp-autoapp/src/launcher/ui/storage.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined, info: () => undefined } as HostLogger;
const asPerson: Envelope = { requestId: 'r-1', channel: 'user', caller: 'user' };

// ── The route's world ───────────────────────────────────────────────────────

interface World {
  readonly directory: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
}
const worlds: World[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.supervisor.stopAll(2_000).catch(() => undefined);
    world.journal.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  return directory;
}

/** A launcher's routes over an empty root, with the folder window replaced. */
function launcher(chooser: Parameters<typeof createLauncherApp>[0]['folderChooser'], logger: HostLogger = quiet): LauncherApp {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  const root = layout(join(directory, 'root'));
  mkdirSync(root.root, { recursive: true });
  const world: World = {
    directory,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({ execPath: process.execPath, logger: quiet }),
  };
  worlds.push(world);
  return createLauncherApp({
    layout: root,
    supervisor: world.supervisor,
    journal: world.journal,
    states: createCandidateStates(root, quiet),
    gate: createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, logger: quiet }),
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    install: () => Promise.resolve({ ok: true, detail: '' }),
    initGit: () => false,
    logger,
    openBrowser: () => Promise.resolve(true),
    ...(chooser === undefined ? {} : { folderChooser: chooser }),
  });
}

/** A dialog that answers at once. */
function answering(exitCode: number, stdout: string, stderr = ''): { spawn: SpawnChooser; calls: ChooserCommand[] } {
  const calls: ChooserCommand[] = [];
  return {
    calls,
    spawn: (command) => {
      calls.push(command);
      return { done: Promise.resolve({ exitCode, stdout, stderr }), kill: () => undefined };
    },
  };
}

/** A dialog that answers when told to, or when it is killed. */
function held(): {
  spawn: SpawnChooser;
  calls: ChooserCommand[];
  kills: () => number;
  answer(stdout: string, exitCode?: number): void;
} {
  const calls: ChooserCommand[] = [];
  let kills = 0;
  let settle: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | null = null;
  return {
    calls,
    kills: () => kills,
    answer: (stdout, exitCode = 0) => settle?.({ exitCode, stdout, stderr: '' }),
    spawn: (command): ChooserProcess => {
      calls.push(command);
      const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => (settle = resolve));
      return {
        done,
        kill: () => {
          kills += 1;
          settle?.({ exitCode: 143, stdout: '', stderr: '' });
        },
      };
    },
  };
}

async function choose(app: LauncherApp, input: { startAt?: string } = {}, envelope: Envelope = asPerson): Promise<ChooseOutput> {
  return (await app.invoke('launcher.folderChoose', input, envelope)) as ChooseOutput;
}

// ── The route ───────────────────────────────────────────────────────────────

describe('launcher.folderChoose', () => {
  test('1. trims a path, keeps /, reads cancel, and says unavailable for no program or a failure (logged)', async () => {
    const mac = { platform: 'darwin' as const };
    expect(await choose(launcher({ ...mac, spawn: answering(0, '/Users/you/My Projects/\n').spawn }))).toEqual({
      available: true,
      chosen: '/Users/you/My Projects',
    });
    expect(await choose(launcher({ ...mac, spawn: answering(0, '/\n').spawn }))).toEqual({ available: true, chosen: '/' });
    expect(trimChosen('C:\\\r\n')).toBe('C:\\');
    expect(trimChosen('C:\\Users\\you\\Projects\\\r\n')).toBe('C:\\Users\\you\\Projects');
    expect(
      await choose(launcher({ ...mac, spawn: answering(1, '', '0:37: execution error: User canceled. (-128)\n').spawn })),
    ).toEqual({ available: true, chosen: null });
    expect(await choose(launcher({ platform: 'win32', spawn: answering(0, '').spawn }))).toEqual({ available: true, chosen: null });
    const linux = { platform: 'linux' as const, env: { DISPLAY: ':0' }, which: (program: string) => (program === 'zenity' ? '/usr/bin/zenity' : null) };
    expect(await choose(launcher({ ...linux, spawn: answering(1, '').spawn }))).toEqual({ available: true, chosen: null });

    const missing: SpawnChooser = () => {
      throw Object.assign(new Error('Executable not found in $PATH: "osascript"'), { code: 'ENOENT' });
    };
    expect(await choose(launcher({ ...mac, spawn: missing }))).toEqual({ available: false, chosen: null });
    expect(await choose(launcher({ platform: 'linux', env: { DISPLAY: ':0' }, which: () => null }))).toEqual({ available: false, chosen: null });
    expect(await choose(launcher({ platform: 'linux', env: {}, which: () => '/usr/bin/zenity' }))).toEqual({ available: false, chosen: null });

    // Any other ending is unavailable, and its last line is logged, not shown.
    const warnings: string[] = [];
    const logger = { ...quiet, warn: (line: string) => warnings.push(line) } as HostLogger;
    const failing = answering(2, '', 'something\nthe last line of it\n\n');
    const answer = await choose(launcher({ platform: 'darwin', spawn: failing.spawn }, logger));
    expect(answer).toEqual({ available: false, chosen: null });
    expect(warnings.some((line) => line.endsWith('the last line of it'))).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('last line');
  });

  test('2. a second window while one is open is a conflict; after it answers, a third works', async () => {
    const dialog = held();
    const app = launcher({ platform: 'darwin', spawn: dialog.spawn });
    const first = choose(app);
    await Bun.sleep(1);
    let refused: unknown = null;
    try {
      await choose(app);
    } catch (cause) {
      refused = cause;
    }
    expect(String(refused)).toContain(LOCATION_WORDS.folderWindowOpen());
    expect(String(refused)).toContain('conflict');
    dialog.answer('/tmp/one/\n');
    expect(await first).toEqual({ available: true, chosen: '/tmp/one' });
    const third = choose(app);
    await Bun.sleep(1);
    dialog.answer('/tmp/three\n');
    expect(await third).toEqual({ available: true, chosen: '/tmp/three' });
    expect(dialog.calls).toHaveLength(2);
  });

  test('3. a window nobody answers is killed at the deadline, once; stopping the launcher kills one that is open', async () => {
    const dialog = held();
    const app = launcher({ platform: 'darwin', spawn: dialog.spawn, deadlineMs: 40 });
    expect(await choose(app)).toEqual({ available: true, chosen: null });
    expect(dialog.kills()).toBe(1);

    const other = held();
    const stopping = launcher({ platform: 'darwin', spawn: other.spawn, deadlineMs: 60_000 });
    const open = choose(stopping);
    await Bun.sleep(1);
    stopping.shutdown();
    expect(await open).toEqual({ available: true, chosen: null });
    expect(other.kills()).toBe(1);
    // Harmless with nothing open.
    stopping.shutdown();
    expect(other.kills()).toBe(1);
  });

  test('4. a starting folder is one whole argv element or one environment value, and the script never changes', () => {
    const hostile = ['"; rm -rf ~ #', '$(id)', '`id`', "' & calc & '", '/tmp/a\nb'];
    const zenity = { env: { DISPLAY: ':0' }, which: (program: string) => (program === 'zenity' ? '/usr/bin/zenity' : null) };
    const kdialog = { env: { WAYLAND_DISPLAY: 'wayland-0' }, which: (program: string) => (program === 'kdialog' ? '/usr/bin/kdialog' : null) };
    const cases: [string, NodeJS.Platform, Parameters<typeof chooserCommand>[2]][] = [
      ['darwin', 'darwin', {}],
      ['win32', 'win32', {}],
      ['zenity', 'linux', zenity],
      ['kdialog', 'linux', kdialog],
    ];
    for (const [label, platform, host] of cases) {
      const plain = chooserCommand(platform, { startAt: '/tmp' }, host);
      if (plain === null) throw new Error(`${label}: no command`);
      for (const value of hostile) {
        const built = chooserCommand(platform, { startAt: value }, host);
        if (built === null) throw new Error(`${label}: no command`);
        expect(built.cmd).toHaveLength(plain.cmd.length);
        const carrying = built.cmd.filter((element) => element.includes(value));
        const inEnv = Object.values(built.env).filter((element) => element.includes(value));
        // Exactly one place, and that place is the value whole.
        expect(`${label} ${value}: ${String(carrying.length + inEnv.length)}`).toBe(`${label} ${value}: 1`);
        const whole = [...carrying, ...inEnv][0] ?? '';
        expect([value, `--filename=${value}/`]).toContain(whole);
        // Every other element — the script text included — is byte for byte the one built for /tmp.
        built.cmd.forEach((element, index) => {
          if (element.includes(value)) expect(plain.cmd[index]).toContain('/tmp');
          else expect(element).toBe(plain.cmd[index] ?? '');
        });
        for (const [key, element] of Object.entries(built.env)) {
          if (!element.includes(value)) expect(element).toBe(plain.env[key] ?? '');
        }
      }
    }
    const mac = chooserCommand('darwin', {}, {});
    expect(mac?.cmd[0]).toBe('osascript');
    expect(mac?.cmd.join('\n')).toContain('POSIX path of');
    const windows = chooserCommand('win32', { startAt: 'C:\\Users' }, {});
    expect(windows?.cmd.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-STA', '-Command']);
    expect(windows?.env['AUTOAPP_FOLDER_START']).toBe('C:\\Users');
  });

  test('5. a starting folder that does not exist, or is a file, is dropped', async () => {
    const places = temporary();
    const file = join(places, 'a-file');
    writeFileSync(file, 'x');
    expect(usableStart(join(places, 'nope'))).toBeUndefined();
    expect(usableStart(file)).toBeUndefined();
    expect(usableStart('relative/path')).toBeUndefined();
    expect(usableStart(places)).toBe(places);

    const dialog = answering(0, `${places}/\n`);
    const chooser = createFolderChooser({ platform: 'darwin', spawn: dialog.spawn, logger: quiet });
    expect(await chooser.choose(join(places, 'nope'))).toEqual({ available: true, chosen: places });
    expect(await chooser.choose(file)).toEqual({ available: true, chosen: places });
    await chooser.choose(places);
    const plain = chooserCommand('darwin', {}, {});
    expect(dialog.calls[0]?.cmd).toEqual(plain?.cmd ?? []);
    expect(dialog.calls[1]?.cmd).toEqual(plain?.cmd ?? []);
    expect(dialog.calls[2]?.cmd.at(-1)).toBe(places);
  });

  test('6. on channel ai the route is asked about, and a refusal opens no window', async () => {
    const dialog = answering(0, '/tmp\n');
    const app = launcher({ platform: 'darwin', spawn: dialog.spawn });
    const approvals = createPendingApprovals(quiet);
    const asking = app.invoke('launcher.folderChoose', {}, { requestId: 'ai-1', channel: 'ai', caller: 'mcp:test', approver: approvals });
    while (approvals.pending.length === 0) await Bun.sleep(2);
    const question = approvals.pending[0];
    expect(question?.route).toBe('launcher.folderChoose');
    expect(question?.effect).toBe('write');
    expect(dialog.calls).toHaveLength(0);
    if (question !== undefined) {
      approvals.answer({ requestId: question.requestId, approved: false, releaseId: question.releaseId, argumentsHash: question.argumentsHash });
    }
    await expect(asking).rejects.toThrow();
    expect(dialog.calls).toHaveLength(0);
  });
});

// ── The form ────────────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A refusal as the bridge client throws one: a code and a sentence. */
function refusedWith(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A clock the test moves. */
function manualTimers(): Timers & { flush(): void; readonly waiting: number } {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    set: (run) => {
      next += 1;
      queue.set(next, run);
      return next;
    },
    clear: (handle) => {
      queue.delete(handle as number);
    },
    flush: () => {
      const runs = [...queue.values()];
      queue.clear();
      for (const run of runs) run();
    },
    get waiting() {
      return queue.size;
    },
  };
}

interface Harness {
  readonly form: NewApplicationForm;
  readonly timers: ReturnType<typeof manualTimers>;
  readonly creates: CreateInput[];
  readonly checks: { appId: string; location: string }[];
  readonly chooses: { startAt?: string }[];
  readonly written: string[];
  /** What each route answers next, in order. */
  readonly next: {
    create: (Deferred<CreateOutput> | CreateOutput | Error)[];
    check: (Deferred<CheckOutput> | CheckOutput | Error)[];
    choose: (Deferred<ChooseOutput> | ChooseOutput | Error)[];
  };
}

function settle<T>(queued: Deferred<T> | T | Error | undefined): Promise<T> {
  if (queued === undefined) return Promise.reject(new Error('nothing queued'));
  if (queued instanceof Error) return Promise.reject(queued);
  if (typeof queued === 'object' && queued !== null && 'promise' in queued) return queued.promise;
  return Promise.resolve(queued);
}

function harness(last: LastLocation = { read: () => null, write: () => undefined }): Harness {
  const timers = manualTimers();
  const creates: CreateInput[] = [];
  const checks: { appId: string; location: string }[] = [];
  const chooses: { startAt?: string }[] = [];
  const written: string[] = [];
  const next: Harness['next'] = { create: [], check: [], choose: [] };
  const form = createNewApplicationForm({
    ops: {
      create: (input) => {
        creates.push(input);
        return settle(next.create.shift());
      },
      check: (input) => {
        checks.push(input);
        return settle(next.check.shift());
      },
      choose: (input) => {
        chooses.push(input);
        return settle(next.choose.shift());
      },
    },
    last: {
      read: () => last.read(),
      write: (value) => {
        written.push(value);
        last.write(value);
      },
    },
    timers,
  });
  return { form, timers, creates, checks, chooses, written, next };
}

/** Let every settled promise run its continuation. */
const tick = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const noop = (): void => undefined;
function drawWhere(h: Harness, windows = false): string {
  const state = h.form.get();
  return renderToString(
    createElement(WhereItLives, {
      where: state.where,
      appId: state.appId,
      windows,
      onChoose: noop,
      onShowTyping: noop,
      onType: noop,
      onUseDefault: noop,
    }),
  );
}

const made: CreateOutput = { ok: true, releaseId: 'a'.repeat(32), installed: true, problems: [], notes: [], opened: true };
const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

describe('the form', () => {
  test('7. untouched, it draws no path and posts exactly what it posted before', async () => {
    const h = harness();
    h.form.setName('Recipe tracker');
    h.form.setDescription('  what we cook  ');
    const html = drawWhere(h);
    expect(html).toContain(escapeHtml(LOCATION_WORDS.defaultPlace()));
    expect(html).toContain('Choose a folder…');
    expect(html).not.toContain('<code');
    expect(html).not.toMatch(/\/(Users|home|tmp|var)\//);
    h.next.create.push(made);
    await h.form.submit();
    expect(h.creates).toHaveLength(1);
    const posted = h.creates[0] ?? ({} as CreateInput);
    // Today's four keys, no `location` key at all.
    expect(Object.keys(posted).sort()).toEqual(['appId', 'description', 'name', 'template']);
    expect('location' in posted).toBe(false);
    expect(posted).toEqual({ appId: 'recipe-tracker', name: 'Recipe tracker', template: 'starter', description: 'what we cook' });
    expect(h.checks).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  test('8. choosing: the button waits, the status says where the window is, the target follows the id, and Use the default clears it', async () => {
    const h = harness();
    h.form.setName('Recipes');
    const dialog = deferred<ChooseOutput>();
    h.next.choose.push(dialog);
    const choosing = h.form.choose();
    expect(h.form.get().where.choosing).toBe(true);
    let html = drawWhere(h);
    expect(html).toMatch(/<button class="launcher__button launcher__button--small" disabled="" type="button"[^>]*>Choose a folder…/);
    expect(html).toContain(`aria-live="polite"`);
    expect(html).toContain(escapeHtml(LOCATION_WORDS.folderWindowStatus()));

    h.next.check.push({ ok: true, target: '/Users/you/My Projects/recipes', problem: null });
    dialog.resolve({ available: true, chosen: '/Users/you/My Projects' });
    await choosing;
    await tick();
    expect(h.checks).toEqual([{ appId: 'recipes', location: '/Users/you/My Projects' }]);
    expect(h.form.get().focus?.on).toBe('choose');
    html = drawWhere(h).replaceAll('<!-- -->', '');
    expect(html).toContain(`${escapeHtml(LOCATION_WORDS.willBeMadeAt())} <code class="launcher__path">/Users/you/My Projects/recipes</code>`);
    expect(html).not.toContain(escapeHtml(LOCATION_WORDS.folderWindowStatus()));

    // The id changes: asked again once the typing stops, and the line follows.
    h.form.setAppId('recipe-book');
    expect(h.checks).toHaveLength(1);
    h.next.check.push({ ok: true, target: '/Users/you/My Projects/recipe-book', problem: null });
    h.timers.flush();
    await tick();
    expect(h.checks.at(-1)).toEqual({ appId: 'recipe-book', location: '/Users/you/My Projects' });
    expect(drawWhere(h)).toContain('/Users/you/My Projects/recipe-book</code>');

    h.form.useDefault();
    expect(h.form.get().focus?.on).toBe('choose');
    expect(drawWhere(h)).toContain(escapeHtml(LOCATION_WORDS.defaultPlace()));
    expect('location' in createInput(h.form.get())).toBe(false);
    h.next.create.push(made);
    await h.form.submit();
    expect('location' in (h.creates[0] ?? {})).toBe(false);
  });

  test('9. cancel changes nothing; no window swaps in the typed field for good; Type a path instead; quotes are taken off', async () => {
    const h = harness();
    h.form.setName('Recipes');
    const before = h.form.get().where;
    h.next.choose.push({ available: true, chosen: null });
    await h.form.choose();
    expect(h.form.get().where).toEqual(before);
    expect(h.form.get().focus?.on).toBe('choose');
    expect(drawWhere(h)).not.toContain('role="alert"');
    expect(h.checks).toHaveLength(0);

    // Type a path instead, while a window is available.
    h.form.showTyping();
    let html = drawWhere(h);
    expect(html).toContain('Choose a folder…');
    expect(html).toContain('<span>Folder</span>');
    expect(html).toContain(escapeHtml(LOCATION_WORDS.typedHint(false)));
    expect(drawWhere(h, true)).toContain(escapeHtml(LOCATION_WORDS.typedHint(true)));
    expect(LOCATION_WORDS.typedHint(true)).toContain('C:\\Users\\you\\Projects');

    h.form.type('  "/a b/c"  ');
    expect(createInput(h.form.get()).location).toBe('/a b/c');
    h.form.type("'/a b/c'");
    expect(createInput(h.form.get()).location).toBe('/a b/c');

    // No window on this computer: the field, for the life of the form.
    const none = harness();
    none.next.choose.push({ available: false, chosen: null });
    await none.form.choose();
    expect(none.form.get().where.dialog).toBe('unavailable');
    expect(none.form.get().focus?.on).toBe('field');
    html = drawWhere(none);
    expect(html).not.toContain('Choose a folder…');
    expect(html).not.toContain('Type a path instead');
    expect(html).toContain('<span>Folder</span>');
    await none.form.choose();
    expect(none.chooses).toHaveLength(1);
    none.form.reset();
    expect(none.form.get().where.dialog).toBe('unavailable');
    expect(drawWhere(none)).toContain('<span>Folder</span>');
    // A second press while a window is open: the host's sentence, and the button back.
    const twice = harness();
    twice.next.choose.push(refusedWith('conflict', LOCATION_WORDS.folderWindowOpen()));
    await twice.form.choose();
    expect(twice.form.get().where.choosing).toBe(false);
    expect(drawWhere(twice)).toContain(LOCATION_WORDS.folderWindowOpen());
  });

  test('10. a problem is under the field as an alert tied to it, never disables Create; an older answer is dropped; a failed check says nothing', async () => {
    const h = harness();
    h.form.setName('Recipes');
    h.form.showTyping();
    h.form.type('/Volumes/Gone');
    const problem = LOCATION_WORDS.doesNotExist('/Volumes/Gone');
    h.next.check.push({ ok: false, target: null, problem });
    h.timers.flush();
    await tick();
    const html = drawWhere(h);
    expect(html).toMatch(new RegExp(`<p class="launcher__message launcher__message--error" id="new-app-where-problem" role="alert">${escapeHtml(problem)}</p>`));
    expect(html).toMatch(/<input aria-describedby="new-app-where-hint new-app-where-problem"/);
    expect(h.form.get().pending).toBe(false);
    h.next.create.push(made);
    await h.form.submit();
    expect(h.creates).toHaveLength(1);

    // Two checks answered out of order: the newer one stands.
    const o = harness();
    o.form.setName('Recipes');
    o.form.showTyping();
    const older = deferred<CheckOutput>();
    const newer = deferred<CheckOutput>();
    o.next.check.push(older, newer);
    o.form.type('/a');
    o.timers.flush();
    o.form.type('/b');
    o.timers.flush();
    expect(o.checks.map((one) => one.location)).toEqual(['/a', '/b']);
    newer.resolve({ ok: true, target: '/b/recipes', problem: null });
    await tick();
    older.resolve({ ok: false, target: null, problem: 'about /a' });
    await tick();
    expect(o.form.get().where.target).toBe('/b/recipes');
    expect(o.form.get().where.problem).toBeNull();

    // A check that throws draws nothing.
    const t = harness();
    t.form.setName('Recipes');
    t.form.showTyping();
    t.next.check.push(new Error('the connection dropped'));
    t.form.type('/somewhere');
    t.timers.flush();
    await tick();
    expect(t.form.get().where.problem).toBeNull();
    expect(drawWhere(t)).not.toContain('role="alert"');
    expect(drawWhere(t)).not.toContain('connection dropped');
  });

  test('11. a refusal: asked again, placed under the folder when it is the folder’s, and everything kept as typed', async () => {
    const h = harness();
    h.form.setTemplate('blank');
    h.form.setName('Recipes');
    h.form.setAppId('recipe-book');
    h.form.setDescription('what we cook');
    h.form.showTyping();
    h.form.type('/Users/you/Projects');
    h.next.check.push({ ok: true, target: '/Users/you/Projects/recipe-book', problem: null });
    h.timers.flush();
    await tick();
    const taken = LOCATION_WORDS.targetExists('/Users/you/Projects/recipe-book');
    h.next.create.push(refusedWith('conflict', taken));
    h.next.check.push({ ok: false, target: null, problem: taken });
    await h.form.submit();
    const after = h.form.get();
    expect(h.checks).toHaveLength(2);
    expect(after.errorAbout).toBe('location');
    expect(after.where.problem).toBe(taken);
    expect(after.focus?.on).toBe('field');
    expect([after.name, after.appId, after.description, after.template, after.where.value]).toEqual([
      'Recipes',
      'recipe-book',
      'what we cook',
      'blank',
      '/Users/you/Projects',
    ]);
    expect(drawWhere(h)).toContain(escapeHtml(taken));

    // The id exists: the folder is fine, so the sentence is not under it.
    const id = harness();
    id.form.setName('Recipes');
    id.form.showTyping();
    id.form.type('/Users/you/Projects');
    id.next.create.push(refusedWith('conflict', 'recipes already exists.'));
    id.next.check.push({ ok: true, target: '/Users/you/Projects/recipes', problem: null });
    await id.form.submit();
    expect(id.form.get().errorAbout).toBe('id');
    expect(id.form.get().where.problem).toBeNull();
    expect(drawWhere(id)).not.toContain('recipes already exists.');

    // Nothing chosen: nothing to ask.
    const plain = harness();
    plain.form.setName('Recipes');
    plain.next.create.push(refusedWith('invalid_input', 'The id must start with a letter.'));
    await plain.form.submit();
    expect(plain.checks).toHaveLength(0);
    expect(plain.form.get().errorAbout).toBe('id');
  });

  test('12. a creation that could not finish shows its problems with where the workspace is; a second Create while one runs is not sent', async () => {
    const h = harness();
    h.form.setName('Recipes');
    h.form.showTyping();
    h.form.type('/Users/you/Projects');
    const running = deferred<CreateOutput>();
    h.next.create.push(running);
    const first = h.form.submit();
    expect(h.form.get().pending).toBe(true);
    await h.form.submit();
    expect(h.creates).toHaveLength(1);
    const note = LOCATION_WORDS.created('/Users/you/Projects/recipes');
    running.resolve({
      ok: false,
      releaseId: null,
      installed: false,
      problems: [{ stage: 'page', message: 'Bundle failed' }],
      notes: [note],
      opened: false,
    });
    await first;
    const failure = h.form.get().failure;
    if (failure === null) throw new Error('no failure');
    const html = renderToString(createElement(CreationFailure, { failure }));
    expect(html).toContain(escapeHtml(note));
    expect(html).toContain('Bundle failed');
    expect(html).toContain('role="alert"');
  });

  test('13. success remembers the folder for the next window, never for the field; storage that throws or holds a number is ignored', async () => {
    let stored: unknown = null;
    const h = harness({ read: () => stored, write: (value) => (stored = value) });
    h.form.setName('Recipes');
    h.next.choose.push({ available: true, chosen: '/Users/you/Projects' });
    h.next.check.push({ ok: true, target: '/Users/you/Projects/recipes', problem: null });
    await h.form.choose();
    await tick();
    expect(h.chooses[0]).toEqual({});
    h.next.create.push(made);
    await h.form.submit();
    expect(h.written).toEqual(['/Users/you/Projects']);
    expect(h.form.get().done?.located).toBe(true);
    h.form.reset();
    expect(h.form.get().where.value).toBe('');
    expect(drawWhere(h)).toContain(escapeHtml(LOCATION_WORDS.defaultPlace()));
    h.next.choose.push({ available: true, chosen: null });
    await h.form.choose();
    expect(h.chooses[1]).toEqual({ startAt: '/Users/you/Projects' });
    expect(h.form.get().where.value).toBe('');

    // A number, and a string too long, are not a folder.
    stored = 42;
    h.next.choose.push({ available: true, chosen: null });
    await h.form.choose();
    expect(h.chooses[2]).toEqual({});
    stored = `/${'x'.repeat(1_024)}`;
    h.next.choose.push({ available: true, chosen: null });
    await h.form.choose();
    expect(h.chooses[3]).toEqual({});

    // The page's own storage helpers, over a storage that refuses and one that holds a number.
    const saved = (globalThis as { window?: unknown }).window;
    try {
      (globalThis as { window?: unknown }).window = {
        localStorage: {
          getItem: () => {
            throw new Error('denied');
          },
          setItem: () => {
            throw new Error('denied');
          },
        },
      };
      expect(rememberedText('broapp-autoapp:last-location', 1_024)).toBeNull();
      expect(() => remember('broapp-autoapp:last-location', '/x')).not.toThrow();
      (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => 42, setItem: () => undefined } };
      expect(rememberedText('broapp-autoapp:last-location', 1_024)).toBeNull();
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
    // And a remembered folder that throws on read does not stop the window.
    const throwing = harness({
      read: () => {
        throw new Error('denied');
      },
      write: () => {
        throw new Error('denied');
      },
    });
    throwing.form.setName('Recipes');
    throwing.next.choose.push({ available: true, chosen: '/p' });
    throwing.next.check.push({ ok: true, target: '/p/recipes', problem: null });
    await throwing.form.choose();
    await tick();
    throwing.next.create.push(made);
    await throwing.form.submit();
    expect(throwing.form.get().done?.appId).toBe('recipes');
  });

  test('14. with an id that cannot name a folder, the line says so and nothing is asked', async () => {
    const h = harness();
    h.form.setAppId('ab');
    h.next.choose.push({ available: true, chosen: '/Users/you/Projects' });
    await h.form.choose();
    h.timers.flush();
    await tick();
    expect(h.checks).toHaveLength(0);
    expect(drawWhere(h)).toContain(escapeHtml(LOCATION_WORDS.willBeMadeInside('/Users/you/Projects')));
    h.form.setAppId('Not An Id');
    h.timers.flush();
    await tick();
    expect(h.checks).toHaveLength(0);
  });
});

// ── The row and removal ─────────────────────────────────────────────────────

function table(apps: readonly AppRow[]): string {
  return renderToString(
    createElement(BroappProvider, {
      contract: launcherContract,
      children: createElement(AppsTable, {
        apps,
        selected: apps[0]?.appId ?? null,
        onSelect: noop,
        onOpen: noop,
        onStop: noop,
        onCreated: noop,
        onRemoved: noop,
      }),
    }),
  );
}

const row = (workspace: AppRow['workspace'], extra: Partial<AppRow> = {}): AppRow => ({
  appId: 'recipes',
  name: 'Recipe tracker',
  currentRelease: 'a'.repeat(32),
  serving: false,
  pid: null,
  schemaVersion: 2,
  activationPending: false,
  ...(workspace === undefined ? {} : { workspace }),
  ...extra,
});

/** The applications card as `AppsTable` drew it before 19b, for two rows in the launcher's own folder. */
const BEFORE_19B =
  '<section class="launcher__card" aria-labelledby="apps-heading"><div class="launcher__card-header"><h2 class="launcher__card-title" id="apps-heading">Applications</h2><button aria-expanded="false" class="launcher__button launcher__button--small" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg> New application</button></div><table class="launcher__table"><thead><tr><th>Name</th><th>Release</th><th>Running</th><th></th></tr></thead><tbody><tr class="launcher__row launcher__row--selected"><td>Recipe tracker</td><td><code>aaaaaaaa</code> · schema 2</td><td>yes (pid 42)</td><td class="launcher__row-actions"><button class="launcher__button" type="button">Open</button><button class="launcher__button launcher__button--small" type="button">Stop</button><button aria-expanded="false" class="launcher__button launcher__button--small" type="button" disabled="" title="Stop it first"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash lucide-trash-2" aria-hidden="true"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Remove</button></td></tr><tr class="launcher__row"><td>Notes<span class="launcher__badge" title="An update was interrupted">unfinished update</span></td><td><code>none</code></td><td>no</td><td class="launcher__row-actions"><button class="launcher__button" type="button" disabled="">Open</button><button class="launcher__button launcher__button--small" type="button" disabled="">Stop</button><button aria-expanded="false" class="launcher__button launcher__button--small" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash lucide-trash-2" aria-hidden="true"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Remove</button></td></tr></tbody></table></section>';

const inLauncher = { chosen: false, dir: null, state: 'present' as const };
const locateIdle = createLocateControl({ choose: () => Promise.reject(new Error('unused')), locate: () => Promise.reject(new Error('unused')) }, noop).get();

function line(app: AppRow, locate = locateIdle): string {
  const drawn: ReactElement | null = WorkspaceLine({ app, locate, onLocate: noop, onType: noop, onSet: noop, onCancel: noop, windows: false });
  return drawn === null ? '' : renderToString(drawn);
}

describe('the row', () => {
  test('15. a workspace in the launcher’s own folder draws the row exactly as before', () => {
    const html = table([
      row(inLauncher, { serving: true, pid: 42 }),
      row(inLauncher, { appId: 'notes', name: 'Notes', currentRelease: null, schemaVersion: null, activationPending: true }),
    ]);
    expect(html).toBe(BEFORE_19B);
    // A list read before 19a, with no workspace at all, is the same.
    const old = table([
      row(undefined, { serving: true, pid: 42 }),
      row(undefined, { appId: 'notes', name: 'Notes', currentRelease: null, schemaVersion: null, activationPending: true }),
    ]);
    expect(old).toBe(BEFORE_19B);
  });

  test('16. present: the path, muted; every other state: its sentence, Locate…, and Open still enabled', () => {
    const dir = '/Users/you/My Projects/recipes';
    const present = table([row({ chosen: true, dir, state: 'present' })]);
    expect(present).toContain(`<p class="launcher__lede launcher__path" title="${dir}">${dir}</p>`);
    expect(present).not.toContain('Locate…');
    for (const state of ['missing', 'not-a-directory', 'denied', 'unreadable'] as const) {
      const app = row({ chosen: true, dir: state === 'unreadable' ? null : dir, state });
      const html = table([app]);
      const sentence = workspaceSentence({ state, appId: app.appId, name: app.name, dir: app.workspace?.dir ?? null }) ?? '';
      expect(sentence).not.toBe('');
      expect(html).toContain(`<p class="launcher__message launcher__message--warn launcher__path">${escapeHtml(sentence)}</p>`);
      expect(html).toContain('Locate…');
      expect(html).toContain('<button class="launcher__button" type="button">Open</button>');
      // The name's own cell is untouched: the line is a row of its own under it.
      expect(html).toContain('<td>Recipe tracker</td>');
    }
  });

  test('17. Locate…: the window’s answer is posted, success refreshes, a refusal stays on the row, and without a window the inline field comes and goes', async () => {
    const posted: { appId: string; sourceDir: string }[] = [];
    const started: { startAt?: string }[] = [];
    const located: string[] = [];
    const answers: (ChooseOutput | Error)[] = [];
    const refusals: (Error | null)[] = [];
    const control = createLocateControl(
      {
        choose: (input) => {
          started.push(input);
          const next = answers.shift();
          return next instanceof Error || next === undefined ? Promise.reject(next ?? new Error('none')) : Promise.resolve(next);
        },
        locate: (input) => {
          posted.push(input);
          const refusal = refusals.shift() ?? null;
          return refusal === null ? Promise.resolve({ dir: input.sourceDir }) : Promise.reject(refusal);
        },
      },
      (appId) => located.push(appId),
    );
    const app = row({ chosen: true, dir: '/Users/you/Projects/recipes', state: 'missing' });
    expect(parentOf('/Users/you/Projects/recipes')).toBe('/Users/you/Projects');
    expect(parentOf('/recipes')).toBe('/');
    expect(parentOf('C:\\recipes')).toBe('C:\\');

    answers.push({ available: true, chosen: '/Users/you/Moved/recipes' });
    await control.start('recipes', '/Users/you/Projects/recipes');
    expect(started[0]).toEqual({ startAt: '/Users/you/Projects' });
    expect(posted).toEqual([{ appId: 'recipes', sourceDir: '/Users/you/Moved/recipes' }]);
    expect(located).toEqual(['recipes']);
    expect(control.get().appId).toBeNull();

    const wrong = LOCATION_WORDS.locateWrong('/Users/you/Elsewhere', 'recipes');
    answers.push({ available: true, chosen: '/Users/you/Elsewhere' });
    refusals.push(refusedWith('invalid_input', wrong));
    await control.start('recipes', '/Users/you/Projects/recipes');
    expect(located).toEqual(['recipes']);
    expect(line(app, control.get())).toContain(`role="alert">${escapeHtml(wrong)}</p>`);
    expect(line(app, control.get())).toContain(escapeHtml(workspaceSentence({ state: 'missing', appId: 'recipes', name: app.name, dir: '/Users/you/Projects/recipes' }) ?? ''));

    // No window here: the inline field, Set and Cancel; Cancel takes it away.
    answers.push({ available: false, chosen: null });
    await control.start('recipes', '/Users/you/Projects/recipes');
    let html = line(app, control.get());
    expect(html).toContain('<span>Folder</span>');
    expect(html).toContain('>Set</button>');
    expect(html).toContain('>Cancel</button>');
    control.cancel();
    html = line(app, control.get());
    expect(html).not.toContain('<span>Folder</span>');
    expect(html).toContain('Locate…');
    // Pressed again, it goes straight to the field; Set posts what was typed.
    await control.start('recipes', '/Users/you/Projects/recipes');
    expect(started).toHaveLength(3);
    control.type('  "/Users/you/Moved/recipes"  ');
    await control.submit();
    expect(posted.at(-1)).toEqual({ appId: 'recipes', sourceDir: '/Users/you/Moved/recipes' });
    expect(located).toEqual(['recipes', 'recipes']);
  });

  test('18. the list is read again when the window regains focus or the tab is shown, and not while it is hidden', () => {
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    let reads = 0;
    const stop = onReturn({ window: windowTarget, document: documentTarget }, () => (reads += 1));
    windowTarget.dispatchEvent(new Event('focus'));
    expect(reads).toBe(1);
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(1);
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(2);
    // Focus is a person looking, even where the document reports itself hidden.
    documentTarget.visibilityState = 'hidden';
    windowTarget.dispatchEvent(new Event('focus'));
    expect(reads).toBe(3);
    stop();
    windowTarget.dispatchEvent(new Event('focus'));
    expect(reads).toBe(3);
  });

  test('19. the confirmation and the line after it, for a chosen, a missing and a default workspace', () => {
    const dir = '/Users/you/Projects/recipes';
    const chosen = renderToString(createElement(RemovalWords, { app: row({ chosen: true, dir, state: 'present' }) }));
    expect(chosen).toContain(escapeHtml(LOCATION_WORDS.removalWillLeave(dir)));
    expect(chosen).not.toContain('its source workspace');
    const missing = renderToString(createElement(RemovalWords, { app: row({ chosen: true, dir, state: 'missing' }) }));
    expect(missing).toContain(escapeHtml(LOCATION_WORDS.removalCannotFind(dir)));
    const standard = renderToString(createElement(RemovalWords, { app: row(inLauncher) }));
    expect(standard).toBe(
      '<p class="launcher__lede">Everything belonging to <strong>Recipe tracker</strong> — its releases, its source workspace, its data and its snapshots — moves to the launcher’s trash. Nothing is deleted, and the launcher never empties the trash. A running preview is stopped.</p>',
    );

    const trashPath = 'trash/recipes-2026-09-21T00-00-00.000Z';
    const left = renderToString(createElement(RemovedNotice, { removed: { appId: 'recipes', trashPath, hadSource: true, workspaceLeftAt: dir } }));
    expect(left).toContain(escapeHtml(LOCATION_WORDS.removalLeft(dir)));
    const gone = renderToString(createElement(RemovedNotice, { removed: { appId: 'recipes', trashPath, hadSource: false, workspaceLeftAt: dir } }));
    expect(gone).toContain(escapeHtml(LOCATION_WORDS.removalMissing(dir)));
    const plain = renderToString(createElement(RemovedNotice, { removed: { appId: 'recipes', trashPath, hadSource: true, workspaceLeftAt: null } }));
    expect(plain).toBe(
      `<p class="launcher__message" role="status">recipes<!-- --> was moved to <code>${trashPath}</code> inside the launcher’s directory. Nothing was deleted.</p>`,
    );
  });

  test('20. no sentence about a folder is written out in AppsTable.tsx: they are imported', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'launcher', 'ui', 'AppsTable.tsx'), 'utf8');
    const marker = '\u0001';
    let fragments = 0;
    for (const [name, words] of Object.entries(LOCATION_WORDS)) {
      const sentences =
        name === 'typedHint'
          ? [LOCATION_WORDS.typedHint(true), LOCATION_WORDS.typedHint(false)]
          : name === 'notWritable'
            ? [LOCATION_WORDS.notWritable(marker, 'darwin')]
            : [(words as (...args: string[]) => string)(marker, marker, marker)];
      for (const sentence of sentences) {
        for (const fragment of sentence.split(marker).map((part) => part.trim())) {
          if (fragment.length < 12) continue;
          fragments += 1;
          expect(`${name}: ${String(source.includes(fragment))}`).toBe(`${name}: false`);
        }
      }
    }
    expect(fragments).toBeGreaterThan(30);
    expect(source).toContain("from '../location-words.ts'");
  });
});
