/**
 * The child runtime: one process, one release, one application.
 *
 * It knows nothing about what the application is. It reads the release's
 * specification, imports the host bundle the manifest names, builds the gate
 * the mode calls for, and serves whatever comes back. That is what makes one
 * compiled launcher able to run any release of any application — and it is why
 * this file never mentions notes, items, or anything an application might be.
 *
 * The child is **trusted local code**. It runs with the owner's own
 * permissions and can do anything they can do. The separate process is for
 * crash isolation — one application falling over does not take the launcher or
 * its siblings with it — and for holding a data directory open exclusively
 * during an activation. It is not a permission boundary, and nothing here
 * should be read as one.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGate, startApp } from 'broapp/host';
import type { Gate, HostLogger, RunningApp } from 'broapp/host';

import { parseMessage } from '../ipc/codec.ts';
import { IPC_VERSION, type Message } from '../ipc/messages.ts';
import { layout, readRelease } from '../spec/index.ts';

import { assertAppModule, type AppInstance } from './module.ts';

/** Exit codes this runtime uses, so a launcher can tell the cases apart. */
const EXIT = {
  /** Nobody is supervising this process. */
  unsupervised: 2,
  /** The launcher said something this build cannot read. */
  protocol: 3,
  /** The release would not start. */
  failedToStart: 4,
} as const;

/** How often a drain re-checks whether the application has gone quiet. */
const DRAIN_POLL_MS = 100;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `c${String(counter)}`;
}

/** Everything the child needs to answer for. */
interface ChildState {
  state: 'starting' | 'serving' | 'draining' | 'stopping';
  running: RunningApp | null;
  instance: AppInstance | null;
  gate: Gate | null;
}

/** A logger that writes to stderr, which the launcher pipes and drains. */
const logger: HostLogger = {
  warn: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
};

/**
 * Load a release's host bundle.
 *
 * The release directory name and the argument have to agree before anything is
 * imported: the launcher tells the child which release it is, the manifest says
 * which release it is, and running code from a directory that disagrees with
 * both is how a release becomes something other than what was approved.
 */
async function loadRelease(
  releaseDir: string,
  root: string,
  appId: string,
  releaseId: string,
): Promise<{ spec: ReturnType<typeof readRelease>; module: ReturnType<typeof assertAppModule> }> {
  const spec = readRelease(layout(root), appId, releaseId);
  if (!releaseDir.endsWith(releaseId)) {
    throw new Error(`the release directory ${releaseDir} is not release ${releaseId}`);
  }
  const entry = join(releaseDir, spec.manifest.entry.host);
  const module = assertAppModule(await import(entry));
  return { spec, module };
}

/**
 * The launcher root a release directory sits under.
 *
 * `<root>/apps/<appId>/releases/<releaseId>` — four levels up. Derived rather
 * than passed so there is one fewer argument that could disagree with the path.
 */
function rootOf(releaseDir: string): string {
  return join(releaseDir, '..', '..', '..', '..');
}

/** Run one migration and exit. Never serves anything. */
export async function runMigrate(argv: readonly string[]): Promise<number> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    console.error('this binary must be spawned by the launcher, with an IPC channel');
    return EXIT.unsupervised;
  }
  const [releaseDir, appId, releaseId] = argv;
  const dataDir = process.env['BROAPP_DATA_DIR'];
  const post = (message: Message): void => void send(message);

  post({ v: IPC_VERSION, id: nextId(), type: 'hello', appId: appId ?? '', releaseId: releaseId ?? '', pid: process.pid });

  try {
    if (releaseDir === undefined || appId === undefined || releaseId === undefined) {
      throw new Error('usage: --migrate <releaseDir> <appId> <releaseId>');
    }
    if (dataDir === undefined || dataDir === '') throw new Error('BROAPP_DATA_DIR is not set');
    // The application is handed a directory, not asked to make one. A migration
    // against a directory that is not there is a confusing way to learn that.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { module } = await loadRelease(releaseDir, rootOf(releaseDir), appId, releaseId);
    const { from, to } = await module.migrate({ dataDir, logger });
    post({ v: IPC_VERSION, id: nextId(), type: 'migrate', dataDir, from, to });
  } catch (cause) {
    post({
      v: IPC_VERSION,
      id: nextId(),
      type: 'fatal',
      reason: `the data could not be migrated: ${String(cause instanceof Error ? cause.message : cause)}`,
    });
    process.disconnect?.();
    return 1;
  }
  process.disconnect?.();
  return 0;
}

/** Run one application, supervised, until told to stop. */
export async function runChild(argv: readonly string[]): Promise<number> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    // Without a channel there is nobody to report to and nothing supervising
    // this process, so it must not go on to run application code.
    console.error('this binary must be spawned by the launcher, with an IPC channel');
    return EXIT.unsupervised;
  }
  const post = (message: Message): void => void send(message);

  const [releaseDir, appId, releaseId, mode = 'live', paused] = argv;
  const dataDir = process.env['BROAPP_DATA_DIR'];

  post({
    v: IPC_VERSION,
    id: nextId(),
    type: 'hello',
    appId: appId ?? '',
    releaseId: releaseId ?? '',
    pid: process.pid,
  });

  const child: ChildState = { state: 'starting', running: null, instance: null, gate: null };

  let finish: (code: number) => void = () => undefined;
  const exiting = new Promise<number>((resolve) => {
    finish = resolve;
  });

  try {
    if (releaseDir === undefined || appId === undefined || releaseId === undefined) {
      throw new Error('usage: --child <releaseDir> <appId> <releaseId> <mode>');
    }
    if (dataDir === undefined || dataDir === '') throw new Error('BROAPP_DATA_DIR is not set');
    const executionMode = mode === 'preview' ? 'preview' : 'live';
    // Created here rather than left to the application: every path that starts
    // one goes through this runtime, and an application that had to make its own
    // data directory would each get it subtly wrong.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { spec, module } = await loadRelease(releaseDir, rootOf(releaseDir), appId, releaseId);

    // Prompt 06 supplies a recorder that writes into `runs.sqlite` inside the
    // data directory — which is how a preview child records into the copy and a
    // live child into the real one, without either of them deciding where.
    const gate = createGate({ appId, releaseId, mode: executionMode, logger });
    child.gate = gate;
    // An activation starts its candidate paused: it has to be checked against
    // the migrated data before anything is allowed to change it.
    if (paused === 'paused') gate.pause('the application is being checked');

    const instance = await module.start({ dataDir, mode: executionMode, gate, logger });
    child.instance = instance;

    const running = await startApp({
      page: readFileSync(join(releaseDir, spec.manifest.entry.page), 'utf8'),
      appName: spec.manifest.name,
      version: releaseId,
      mode: 'background',
      openBrowser: false,
      register: (bridge) => instance.register(bridge),
      isBusy: () => instance.isBusy(),
      onShutdown: (reason) => instance.shutdown(reason),
      // The launch URL is a credential. The launcher gets it over IPC and shows
      // it once; a child that also printed it would put it in whatever captures
      // this process's output.
      stdout: { log: () => undefined },
    });
    child.running = running;
    child.state = 'serving';

    post({
      v: IPC_VERSION,
      id: nextId(),
      type: 'ready',
      url: running.bridge.url,
      schemaVersion: instance.schemaVersion,
    });

    // A host that stops on its own — a signal, a fatal bridge error — must not
    // leave the launcher waiting for a `shutdown` reply that will never come.
    void running.done.then((code) => finish(code));
  } catch (cause) {
    post({
      v: IPC_VERSION,
      id: nextId(),
      type: 'fatal',
      reason: `the release could not be started: ${String(cause instanceof Error ? cause.message : cause)}`,
    });
    process.disconnect?.();
    return EXIT.failedToStart;
  }

  process.on('message', (raw: unknown) => {
    let message: Message;
    try {
      message = parseMessage(raw);
    } catch (cause) {
      post({
        v: IPC_VERSION,
        id: nextId(),
        type: 'fatal',
        reason: `the launcher sent something this build cannot read: ${String(cause instanceof Error ? cause.message : cause)}`,
      });
      finish(EXIT.protocol);
      return;
    }

    switch (message.type) {
      case 'health':
        post({
          v: IPC_VERSION,
          id: nextId(),
          re: message.id,
          type: 'health',
          state: child.state,
          activeWork: child.instance?.isBusy() === true ? 1 : 0,
          attached: child.running?.attached ?? false,
        });
        break;

      case 'drain': {
        // Draining is two things at once: stop admitting anything that changes
        // data, and wait for what is already running to finish. The gate does
        // the first immediately, so the answer to "is it safe to snapshot yet"
        // only depends on the second.
        child.state = 'draining';
        child.gate?.pause('the application is being updated');
        const deadline = Date.now() + message.deadlineMs;
        const check = (): void => {
          const busy = child.instance?.isBusy() ?? false;
          if (!busy || Date.now() >= deadline) {
            post({
              v: IPC_VERSION,
              id: nextId(),
              re: message.id,
              type: 'drain',
              deadlineMs: message.deadlineMs,
              drained: !busy,
            });
            return;
          }
          setTimeout(check, DRAIN_POLL_MS).unref?.();
        };
        check();
        break;
      }

      case 'shutdown':
        child.state = 'stopping';
        void (child.running?.stop('requested') ?? Promise.resolve()).then(
          () => finish(0),
          () => finish(1),
        );
        break;

      case 'fatal':
        // A `fatal` arriving *from* the launcher is how it refuses a channel it
        // cannot read. There is nothing to negotiate.
        finish(EXIT.protocol);
        break;

      default:
        // `hello`, `ready` and `migrate` only ever travel the other way, or
        // belong to the migrate-mode invocation.
        post({
          v: IPC_VERSION,
          id: nextId(),
          type: 'fatal',
          reason: `the launcher sent a ${message.type} message, which this child does not answer`,
        });
        finish(EXIT.protocol);
        break;
    }
  });

  const code = await exiting;
  // The IPC channel is a live handle: while it is open the event loop has
  // something to wait on and the process will not exit on its own.
  process.disconnect?.();
  return code;
}
