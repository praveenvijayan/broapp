/**
 * Stopping the launcher, and a child that does not outlive it.
 *
 * Most cases drive the compiled launcher, because what is being tested is a
 * process ending: the control connection's `stop`, the `stop` and `status`
 * commands, Quit over the panel's own bridge, and a launcher killed outright
 * while its child serves. Every launcher and child started here is stopped in
 * `afterEach`, and a case that expects one gone looks for its pid.
 *
 * On the platform question: signals and process probes differ on Windows,
 * where a console process is not sent `SIGTERM` and a hard kill is
 * `taskkill /F`, so this file runs on every platform in CI.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeAdapter } from 'broapp/ai/host';
import { createGate } from 'broapp/host';
import type { Envelope, HostLogger } from 'broapp/host';
import { fromTransportError } from 'broapp/shared';
import { LAUNCHER_PID_ENV, LAUNCHER_WATCH_MS, processAlive } from 'broapp-autoapp/child';
import { createCandidateStates, engineerTools, intentTools } from 'broapp-autoapp/engineer';
import { createRunStore } from 'broapp-autoapp/host';
import { openIntents } from 'broapp-autoapp/intent';
import {
  addServing,
  buildCandidate,
  connectToChild,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  QUIT_AFTER_MS,
  type ControlFile,
} from 'broapp-autoapp/launcher';
import { connectControl } from 'broapp-autoapp/mcp';
import { layout, setCurrent, writeGrants, type Layout } from 'broapp-autoapp/spec';

import { LauncherStopped, QUIT_CONFIRMATION, QUIT_DONE, QuitControl } from '../packages/broapp-autoapp/src/launcher/ui/QuitControl.tsx';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const failure = await ensureLauncher();
if (failure !== null) console.warn(`[autoapp-stop] skipped: the launcher would not build\n${failure}`);
const available = failure === null;

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');
const windows = process.platform === 'win32';

const scratch: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
/** Pids a case saw, killed in `afterEach` if they are somehow still alive. */
const pids: number[] = [];
const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Carry on.
    }
  }
  for (const running of processes.splice(0)) {
    if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
    await running.exited;
  }
  for (const pid of pids.splice(0)) {
    if (processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone between the question and the kill.
      }
    }
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
});

interface Where {
  readonly directory: string;
  readonly root: Layout;
  readonly releaseId: string;
}

/** A launcher root with `items` built and current, as an import leaves it. */
async function makeRoot(): Promise<Where> {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'stop-'));
  scratch.push(directory);
  const root = layout(join(directory, 'autoapp'));
  mkdirSync(root.app('items').dir, { recursive: true });
  cpSync(fixture, root.app('items').source, { recursive: true });
  const built = await buildCandidate({ layout: root, appId: 'items', logger: quiet });
  if (!built.ok) throw new Error(built.problems.map((one) => `${one.stage}: ${one.message}`).join('; '));
  setCurrent(root, 'items', built.releaseId);
  writeGrants(root, 'items', { appId: 'items', releaseId: built.releaseId, grantedAt: Date.now(), capabilities: [] });
  return { directory, root, releaseId: built.releaseId };
}

function environment(where: Where, network = false): Record<string, string | undefined> {
  return {
    ...process.env,
    BROAPP_DATA_DIR: where.directory,
    NODE_ENV: 'test',
    AUTOAPP_TEST_NO_BROWSER: '1',
    ...(network ? {} : { AUTOAPP_TEST_NO_NETWORK: '1' }),
  };
}

/** Run the compiled launcher once. */
async function command(where: Where, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const running = Bun.spawn({ cmd: [LAUNCHER, ...args], env: environment(where), stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    running.exited,
    new Response(running.stdout as ReadableStream<Uint8Array>).text(),
    new Response(running.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return { code, stdout, stderr };
}

interface Launcher {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly url: string;
  output(): string;
}

/** Start the compiled launcher's panel; resolves once it has printed its address. */
async function startLauncher(where: Where, args: readonly string[] = [], network = false): Promise<Launcher> {
  const running = Bun.spawn({
    cmd: [LAUNCHER, 'open', '--no-open', ...args],
    env: environment(where, network),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push(running);
  pids.push(running.pid);
  let text = '';
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  };
  void drain(running.stdout as ReadableStream<Uint8Array>);
  void drain(running.stderr as ReadableStream<Uint8Array>);
  await until(() => text.includes('Open this address if your browser does not:'), 60_000);
  const match = /http:\/\/127\.0\.0\.1:\d+\/\?bt=[A-Za-z0-9_-]+/.exec(text.slice(text.indexOf('Open this address if your browser does not:')));
  if (match === null) throw new Error(`no address in:\n${text}`);
  return { process: running, url: match[0], output: () => text };
}

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms)}ms`);
    await Bun.sleep(50);
  }
}

/** The panel's own bridge, as a browser tab would reach it. */
async function panel(launcher: Launcher): Promise<Panel> {
  const client = await connectToChild(launcher.url);
  closers.push(() => client.close().catch(() => undefined));
  return client;
}

type Panel = Awaited<ReturnType<typeof connectToChild>>;

/** The pid of the child serving `items`, once the launcher has restored it, and the panel connection that asked. */
async function servingPid(launcher: Launcher): Promise<{ pid: number; client: Panel }> {
  // The launch address is single-use: this is the one panel connection a case gets.
  const client = await panel(launcher);
  let pid: number | null = null;
  await until(async () => {
    const listed = (await client.call('launcher.appsList', undefined)) as { apps: { appId: string; pid: number | null }[] };
    pid = listed.apps.find((row) => row.appId === 'items')?.pid ?? null;
    return pid !== null;
  }, 60_000);
  if (pid === null) throw new Error('no child');
  pids.push(pid);
  return { pid, client };
}

/** The launcher over a root that serves `items`, restored from the list it keeps. */
async function serving(): Promise<{ where: Where; launcher: Launcher; child: number; client: Panel }> {
  const where = await makeRoot();
  addServing(where.root, 'items');
  const launcher = await startLauncher(where);
  const { pid, client } = await servingPid(launcher);
  return { where, launcher, child: pid, client };
}

/** Wait for a pid to be gone, and say how long it took. */
async function gone(pid: number, ms: number): Promise<number> {
  const started = Date.now();
  await until(() => !processAlive(pid), ms);
  return Date.now() - started;
}

// ── 9. The control request ─────────────────────────────────────────────────

describe.skipIf(!available)('the stop request', () => {
  test('a wrong secret is refused; the right one is answered, then the children, the control file and the launcher go', async () => {
    const { where, launcher, child } = await serving();
    const file = JSON.parse(readFileSync(where.root.control, 'utf8')) as ControlFile;

    // A wrong secret: the connection is closed, and nothing stops.
    let answered = '';
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: file.port,
      socket: {
        data(_socket, chunk) {
          answered += new TextDecoder().decode(chunk);
        },
      },
    });
    socket.write(`${JSON.stringify({ v: 1, type: 'auth', secret: '0'.repeat(64) })}\n${JSON.stringify({ v: 1, id: 'm1', type: 'stop' })}\n`);
    await Bun.sleep(500);
    socket.end();
    expect(answered).toBe('');
    expect(processAlive(launcher.process.pid)).toBe(true);
    expect(processAlive(child)).toBe(true);

    const control = await connectControl(where.root.control);
    const reply = await control.stop();
    control.close();
    expect(reply).toEqual({ serving: ['items'], run: null });
    expect(await launcher.process.exited).toBe(0);
    await gone(child, 10_000);
    expect(existsSync(where.root.control)).toBe(false);
  }, 120_000);
});

// ── 10 and 11. The commands ────────────────────────────────────────────────

describe.skipIf(!available)('broapp-autoapp stop and status', () => {
  test('no launcher: stop and status say so and exit 0', async () => {
    const where = await makeRoot();
    const stopped = await command(where, ['stop']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('No launcher is running over this root.');
    const status = await command(where, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout.trim()).toBe('No launcher is running over this root.');
  }, 60_000);

  test('a control file naming a pid that is not alive is stale, removed, and exit 0', async () => {
    const where = await makeRoot();
    const done = Bun.spawn({ cmd: [process.execPath, '--version'], stdout: 'ignore' });
    await done.exited;
    mkdirSync(where.root.root, { recursive: true });
    writeFileSync(where.root.control, JSON.stringify({ v: 1, port: 1, secret: 'a'.repeat(64), pid: done.pid }));
    const stopped = await command(where, ['stop']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('stale');
    expect(stopped.stdout).toContain('No launcher is running over this root.');
    expect(existsSync(where.root.control)).toBe(false);
  }, 60_000);

  test('a live launcher: status says what it serves; stop names it, waits for it, and exits 0', async () => {
    const { where, launcher, child } = await serving();
    const status = await command(where, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`A launcher is running over this root: pid ${String(launcher.process.pid)}, for `);
    expect(status.stdout).toContain('Serving: items.');
    expect(status.stdout).toContain('Backlog: no run.');
    // `status <appId>` is unchanged.
    expect((await command(where, ['status', 'items'])).stdout).toContain(`current: ${where.releaseId}`);

    const stopped = await command(where, ['stop']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout.trim()).toBe('Stopped. It was serving: items.');
    expect(processAlive(launcher.process.pid)).toBe(false);
    await gone(child, 10_000);
    expect((await command(where, ['status'])).stdout.trim()).toBe('No launcher is running over this root.');
  }, 120_000);
});

describe.skipIf(!available)('a closed panel', () => {
  test('is followed by one line saying the launcher still runs, and how to stop it', async () => {
    const { launcher, client } = await serving();
    const line = 'Still running, serving items. `broapp-autoapp stop` ends it.';
    expect(launcher.output()).not.toContain(line);
    // Open as a person has it open: the launcher looks once a second, and a
    // panel it never saw open is not one it saw close.
    await Bun.sleep(1_500);
    await client.close();
    await until(() => launcher.output().includes(line), 15_000);
    // Once per closure, not once a second.
    await Bun.sleep(3_000);
    expect(launcher.output().split(line).length - 1).toBe(1);
    // And nothing stopped: the launcher is still there.
    expect(processAlive(launcher.process.pid)).toBe(true);
  }, 120_000);
});

// ── 12. Quit ────────────────────────────────────────────────────────────────

describe('launcher.quit', () => {
  test('refused on channel ai and on channel mcp; on user it answers, then the stop begins; the engineer has no quit', async () => {
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'stop-quit-'));
    scratch.push(directory);
    const root = layout(directory);
    const dataDir = join(directory, 'launcher');
    const runs = createRunStore(dataDir, quiet);
    const journal = openJournal(root.journal);
    const intents = openIntents(dataDir);
    const supervisor = createSupervisor({ logger: quiet });
    const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: runs.recorder(), logger: quiet });
    let quits = 0;
    const tab = createLauncherTab({
      layout: root,
      supervisor,
      journal,
      gate,
      dataDir,
      store: runs,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      providers: [createFakeAdapter({})],
      logger: quiet,
      intents,
      quit: () => {
        quits += 1;
      },
    });
    closers.push(
      () => supervisor.stopAll(5_000),
      () => journal.close(),
      () => runs.close(),
      () => intents.close(),
      () => tab.ai.close(),
    );
    const yes = { ask: () => Promise.resolve(true) };
    const as = (channel: Envelope['channel']): Envelope => ({ requestId: `quit-${channel}`, channel, caller: `${channel}:test`, approver: yes });
    for (const channel of ['ai', 'mcp'] as const) {
      const refused = await tab.app.invoke('launcher.quit', undefined, as(channel)).then(
        () => null,
        (cause: unknown) => fromTransportError(cause),
      );
      expect(refused?.code).toBe('rejected');
      expect(refused?.message).toBe('Only a person stops the launcher, from its panel.');
    }
    expect(await tab.app.invoke('launcher.quit', undefined, as('user'))).toEqual({ stopping: true });
    // The reply came first; the stop begins after it.
    expect(quits).toBe(0);
    await Bun.sleep(QUIT_AFTER_MS + 100);
    expect(quits).toBe(1);

    // No engineer tool, backlog tool included, can stop anything.
    const tools = {
      ...engineerTools({
        layout: root,
        supervisor,
        journal,
        gate,
        states: createCandidateStates(root),
        templates: TEMPLATES,
        versions: STARTER_VERSIONS,
        logger: quiet,
      }),
      ...intentTools({ layout: root, gate, intents, logger: quiet }).tools,
    };
    expect(Object.keys(tools).filter((name) => /quit|stop.*launcher|launcher/i.test(name))).toEqual([]);
    // Nor is it an application's route, the only kind MCP offers.
    expect(launcherContract.operations['launcher.quit'].effect).toBe('write');
  }, 60_000);

  test('the panel draws the confirmation and the stopped page', () => {
    const asking = renderToString(createElement(QuitControl, { onQuit: () => undefined, pending: false, error: null, initiallyAsking: true }));
    expect(asking).toContain(QUIT_CONFIRMATION);
    expect(asking).toContain('aria-label="Quit the launcher"');
    expect(renderToString(createElement(LauncherStopped))).toContain(QUIT_DONE);
  });

  test.skipIf(!available)('over the panel’s own bridge, Quit answers and then the launcher stops', async () => {
    const { where, launcher, child, client } = await serving();
    expect((await client.call('launcher.quit', undefined)) as unknown).toEqual({ stopping: true });
    expect(await launcher.process.exited).toBe(0);
    await gone(child, 10_000);
    // An MCP client reaches applications through the control file, and there is none now.
    expect(existsSync(where.root.control)).toBe(false);
  }, 120_000);
});

// ── 13 and 14. A child and its launcher ────────────────────────────────────

describe.skipIf(!available)('a child does not outlive its launcher', () => {
  test('a launcher killed outright while serving: its child is gone within ten seconds', async () => {
    const { launcher, child } = await serving();
    if (windows) {
      const killed = Bun.spawn({ cmd: ['taskkill', '/F', '/PID', String(launcher.process.pid)], stdout: 'ignore', stderr: 'ignore' });
      await killed.exited;
    } else {
      launcher.process.kill('SIGKILL');
    }
    await launcher.process.exited;
    expect(await gone(child, 10_000)).toBeLessThanOrEqual(10_000);
  }, 120_000);

  test('a --child started with no launcher pid has no watch and does not exit on its own', async () => {
    const where = await makeRoot();
    const app = where.root.app('items');
    let ready = false;
    const env: Record<string, string | undefined> = { ...environment(where), BROAPP_DATA_DIR: app.data };
    delete env[LAUNCHER_PID_ENV];
    const running = Bun.spawn({
      cmd: [LAUNCHER, '--child', app.release(where.releaseId), 'items', where.releaseId, 'live'],
      env,
      stdout: 'ignore',
      stderr: 'ignore',
      serialization: 'json',
      ipc(message) {
        if ((message as { type?: unknown }).type === 'ready') ready = true;
      },
    });
    processes.push(running);
    pids.push(running.pid);
    await until(() => ready, 60_000);
    await Bun.sleep(LAUNCHER_WATCH_MS + 1_500);
    expect(running.exitCode).toBeNull();
    expect(processAlive(running.pid)).toBe(true);
    running.send({ v: 1, id: 'l1', type: 'shutdown', deadlineMs: 5_000 });
    expect(await running.exited).toBe(0);
  }, 120_000);
});

// ── 15. A backlog run when stop arrives ─────────────────────────────────────

describe.skipIf(!available)('a backlog run when stop arrives', () => {
  test('the task is interrupted, the intent stopped, and no attempt is spent', async () => {
    const where = await makeRoot();
    // A model server that takes the turn's request and never answers it, so
    // the turn is in hand when the launcher is asked to stop.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'slow', object: 'model' }] });
        return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    closers.push(() => server.stop(true));
    const dataDir = join(where.root.root, 'launcher');
    mkdirSync(join(dataDir, 'ai'), { recursive: true });
    writeFileSync(
      join(dataDir, 'ai', 'settings.json'),
      JSON.stringify({ version: 1, provider: 'openai-compatible', modelId: 'slow', baseUrl: `http://127.0.0.1:${String(server.port)}/v1`, remember: true }),
    );
    const seeded = openIntents(dataDir);
    const intent = seeded.createIntent({ appId: 'items', request: 'Show the items.' });
    seeded.replaceAnalysis(intent.id, {
      restated: 'Show the items, as the list does now.',
      fits: 'Builds on items.list.',
      conflicts: [],
      outOfReach: [],
      assumptions: [],
      questions: [],
    });
    seeded.addTask(
      intent.id,
      {
        title: 'Build the only part',
        words: 'only-part',
        priority: 'medium',
        labels: ['acceptance'],
        blockedBy: [],
        estimatedLines: 20,
        locks: [],
        risk: 'normal',
        stub: false,
        summary: 'A part of the request that a person can accept or reject on its own.',
        criteria: [
          { text: 'items.list returns the items', failure: false },
          { text: 'An empty list reads as empty, never as an error', failure: true },
        ],
        reasoning: 'low',
      },
      { deferReferences: true },
    );
    expect(seeded.submit(intent.id)).toEqual([]);
    seeded.close();

    const launcher = await startLauncher(where, ['--no-restore'], true);
    const client = await panel(launcher);
    await client.call('launcher.intentRun', { id: intent.id });
    await until(async () => {
      const got = (await client.call('launcher.intentGet', { id: intent.id })) as { tasks: { stored: string }[] };
      return got.tasks[0]?.stored === 'in-progress';
    }, 60_000);
    const status = await command(where, ['status']);
    expect(status.stdout).toContain(`Backlog: intent ${String(intent.id)} on items is running, on 0001-only-part.`);

    const stopped = await command(where, ['stop']);
    expect(stopped.code).toBe(0);
    expect(await launcher.process.exited).toBe(0);

    const after = openIntents(dataDir);
    closers.push(() => after.close());
    const detail = after.get(intent.id);
    expect(detail?.intent.status).toBe('stopped');
    const task = detail?.tasks[0];
    expect(task?.stored).toBe('interrupted');
    expect(task?.attempts).toBe(0);
  }, 180_000);
});
