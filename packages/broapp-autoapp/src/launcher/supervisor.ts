/**
 * One child per application, watched.
 *
 * Every wait here has a deadline. A supervisor that can hang is worse than no
 * supervisor at all: the application it was meant to look after is now held
 * open by the thing that was supposed to be looking after it, and nothing in
 * the system can tell the difference between "starting slowly" and "never
 * going to start".
 *
 * The launcher never imports a release's host bundle. It builds a path, hands
 * it to a child, and reads messages back. That is the crash isolation the child
 * boundary buys — not a permission boundary, which it is not.
 */
import { spawn } from 'bun';
import type { Subprocess } from 'bun';

import type { HostLogger } from 'broapp/host';

import { parseMessage } from '../ipc/codec.ts';
import { IPC_VERSION, type Message } from '../ipc/messages.ts';

/** How a child reports itself when asked. */
export interface HealthReport {
  readonly state: 'starting' | 'serving' | 'draining' | 'stopping';
  readonly activeWork: number;
  readonly attached: boolean;
}

/** One running child. */
export interface ChildHandle {
  readonly appId: string;
  readonly releaseId: string;
  readonly mode: 'live' | 'preview';
  readonly pid: number;
  /** From `ready`. Never written to disk. */
  readonly url: string;
  readonly schemaVersion: number;
  health(): Promise<HealthReport>;
  /** Stop admitting writes and wait for work to finish. `false` means the deadline passed first. */
  drain(deadlineMs: number): Promise<boolean>;
  shutdown(deadlineMs: number): Promise<{ exitCode: number | null; killed: boolean }>;
  readonly exited: Promise<number | null>;
}

/** Options for {@link createSupervisor}. */
export interface SupervisorOptions {
  /** The binary to spawn. Defaults to this process's own executable. */
  readonly execPath?: string;
  readonly helloTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly logger?: HostLogger;
}

/** What a child is started with. */
export interface StartParams {
  readonly appId: string;
  readonly releaseDir: string;
  readonly releaseId: string;
  readonly dataDir: string;
  readonly mode: 'live' | 'preview';
  /** Start with the gate held closed, for an activation's check step. */
  readonly paused?: boolean;
}

/** What a migration is run against. */
export interface MigrateParams {
  readonly appId: string;
  readonly releaseDir: string;
  readonly releaseId: string;
  readonly dataDir: string;
}

/** The thing that starts, watches and stops children. */
export interface Supervisor {
  start(params: StartParams): Promise<ChildHandle>;
  migrate(params: MigrateParams): Promise<{ from: number; to: number }>;
  /** Every child still alive. */
  readonly children: readonly ChildHandle[];
  /** Shut everything down; used at launcher exit. */
  stopAll(deadlineMs: number): Promise<void>;
}

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** How long a migrate child gets before it is assumed stuck. */
const MIGRATE_TIMEOUT_MS = 120_000;

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `l${String(messageCounter)}`;
}

/** A promise that rejects when the deadline passes, without holding the process open. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * The environment a child is given.
 *
 * Deliberately not `process.env`. This is tidiness rather than containment: the
 * child is trusted local code running with the owner's permissions, and a
 * shorter environment does not change that. It exists so a child's behaviour
 * does not depend on whatever happened to be exported in the shell that started
 * the launcher. `PATH` is passed through, because an application is allowed to
 * need tools.
 */
function childEnv(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {
    BROAPP_DATA_DIR: dataDir,
    BROAPP_LIFECYCLE: 'background',
    BROAPP_OPEN_BROWSER: '0',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'NODE_ENV']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** One child's inbox, and a way to wait for something to land in it. */
interface Channel {
  readonly inbox: Message[];
  waitFor(match: (message: Message) => boolean, ms: number, label: string): Promise<Message>;
  /** Set when the child said something this build cannot read. */
  fault(): Error | null;
}

/** Build the supervisor. */
export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const logger: HostLogger = options.logger ?? console;
  const execPath = options.execPath ?? process.execPath;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const live = new Set<ChildHandle>();

  /** Spawn a child and wrap its IPC channel in something waitable. */
  function launch(
    args: readonly string[],
    dataDir: string,
  ): { process: Subprocess; channel: Channel } {
    const inbox: Message[] = [];
    let arrived: () => void = () => undefined;
    let protocolFault: Error | null = null;

    const child = spawn({
      cmd: [execPath, ...args],
      env: childEnv(dataDir),
      // Piped rather than inherited: a child that outlives its parent would
      // otherwise hold the launcher's own stderr open, and anything waiting on
      // the launcher to finish would wait for the child too. Report 02 found
      // that the hard way.
      stdout: 'ignore',
      stderr: 'pipe',
      serialization: 'json',
      ipc: (raw: unknown) => {
        try {
          inbox.push(parseMessage(raw));
        } catch (cause) {
          protocolFault = cause instanceof Error ? cause : new Error(String(cause));
          try {
            child.send({ v: IPC_VERSION, id: nextId(), type: 'fatal', reason: protocolFault.message });
          } catch {
            // The channel may already be gone; the exit code still tells the story.
          }
        }
        arrived();
      },
    });

    // Drained line by line rather than in one read at the end. The pipe must
    // not fill, and — the reason this is not `new Response(...).text()` — a
    // child's diagnostics are wanted *while it is running*, which is exactly
    // when a whole-stream read has not resolved yet.
    void (async () => {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) if (line.trim() !== '') logger.warn(`[child] ${line}`);
        }
        if (pending.trim() !== '') logger.warn(`[child] ${pending}`);
      } catch {
        // The child is gone and took its pipe with it; its exit code is the
        // thing that matters now.
      }
    })();

    const channel: Channel = {
      inbox,
      fault: () => protocolFault,
      waitFor: (match, ms, label) =>
        withDeadline(
          new Promise<Message>((resolve, reject) => {
            const check = (): void => {
              const fault: Error | null = protocolFault;
              if (fault !== null) {
                reject(fault);
                return;
              }
              const found = inbox.find(match);
              if (found !== undefined) {
                resolve(found);
                return;
              }
              // A child that has declared itself lost will never send what is
              // being waited for, and its reason is far more useful than a
              // timeout would be several seconds from now.
              const fatal = inbox.find((message) => message.type === 'fatal');
              if (fatal !== undefined && fatal.type === 'fatal') {
                reject(new Error(fatal.reason));
                return;
              }
              arrived = check;
            };
            check();
          }),
          ms,
          label,
        ),
    };

    return { process: child, channel };
  }

  /** Whatever the child said before it died, or a sentence about the exit code. */
  async function startupFailure(
    child: Subprocess,
    channel: Channel,
    cause: unknown,
  ): Promise<Error> {
    const fatal = channel.inbox.find((message) => message.type === 'fatal');
    if (fatal !== undefined && fatal.type === 'fatal') return new Error(fatal.reason);
    if (child.exitCode !== null) {
      return new Error(`the child exited with code ${String(child.exitCode)} before it was ready`);
    }
    return cause instanceof Error ? cause : new Error(String(cause));
  }

  const supervisor: Supervisor = {
    async start(params: StartParams): Promise<ChildHandle> {
      const { process: child, channel } = launch(
        [
          '--child',
          params.releaseDir,
          params.appId,
          params.releaseId,
          params.mode,
          ...(params.paused === true ? ['paused'] : []),
        ],
        params.dataDir,
      );

      let ready: Message;
      try {
        await channel.waitFor((message) => message.type === 'hello', helloTimeoutMs, 'hello');
        ready = await channel.waitFor((message) => message.type === 'ready', readyTimeoutMs, 'ready');
      } catch (cause) {
        const failure = await startupFailure(child, channel, cause);
        child.kill();
        await child.exited.catch(() => null);
        throw failure;
      }
      if (ready.type !== 'ready') throw new Error('the child did not report itself ready');

      /** Send a request and wait for the reply that names it. */
      async function request(message: Message, ms: number, label: string): Promise<Message> {
        child.send(message);
        return await channel.waitFor((reply) => reply.re === message.id, ms, label);
      }

      const handle: ChildHandle = {
        appId: params.appId,
        releaseId: params.releaseId,
        mode: params.mode,
        pid: child.pid,
        url: ready.url,
        schemaVersion: ready.schemaVersion,
        exited: child.exited.then((code) => code, () => null),

        async health(): Promise<HealthReport> {
          const reply = await request(
            { v: IPC_VERSION, id: nextId(), type: 'health' },
            helloTimeoutMs,
            'a health reply',
          );
          if (reply.type !== 'health') throw new Error('the child answered health with something else');
          return {
            state: reply.state ?? 'starting',
            activeWork: reply.activeWork ?? 0,
            attached: reply.attached ?? false,
          };
        },

        async drain(deadlineMs: number): Promise<boolean> {
          try {
            const reply = await request(
              { v: IPC_VERSION, id: nextId(), type: 'drain', deadlineMs },
              // The child answers at its own deadline, so the launcher waits a
              // little longer than that before deciding the child is not
              // answering at all.
              deadlineMs + helloTimeoutMs,
              'a drain reply',
            );
            return reply.type === 'drain' && reply.drained === true;
          } catch (cause) {
            logger.warn(`[autoapp] ${params.appId} did not answer drain: ${String(cause)}`);
            return false;
          }
        },

        async shutdown(deadlineMs: number): Promise<{ exitCode: number | null; killed: boolean }> {
          try {
            child.send({ v: IPC_VERSION, id: nextId(), type: 'shutdown', deadlineMs });
          } catch {
            // Already gone. `exited` below still reports what happened.
          }
          try {
            const exitCode = await withDeadline(child.exited, deadlineMs, 'the child to exit');
            live.delete(handle);
            return { exitCode, killed: false };
          } catch {
            // A child that will not stop is stopped. This is the whole reason
            // the message carries a deadline rather than a request.
            child.kill();
            const exitCode = await child.exited.catch(() => null);
            live.delete(handle);
            return { exitCode, killed: true };
          }
        },
      };

      live.add(handle);
      void child.exited.then(() => live.delete(handle));
      return handle;
    },

    async migrate(params: MigrateParams): Promise<{ from: number; to: number }> {
      const { process: child, channel } = launch(
        ['--migrate', params.releaseDir, params.appId, params.releaseId],
        params.dataDir,
      );
      try {
        const reply = await channel.waitFor(
          (message) => message.type === 'migrate',
          MIGRATE_TIMEOUT_MS,
          'the migration to finish',
        );
        if (reply.type !== 'migrate') throw new Error('the child answered migrate with something else');
        await withDeadline(child.exited, helloTimeoutMs, 'the migrate child to exit').catch(() => {
          child.kill();
        });
        return { from: reply.from ?? 0, to: reply.to ?? 0 };
      } catch (cause) {
        child.kill();
        await child.exited.catch(() => null);
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
    },

    get children() {
      return [...live];
    },

    async stopAll(deadlineMs: number): Promise<void> {
      await Promise.all([...live].map((handle) => handle.shutdown(deadlineMs)));
    },
  };

  return supervisor;
}
