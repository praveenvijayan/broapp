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
import { join } from 'node:path';

import type { HostLogger } from 'broapp/host';
import { INTERNAL_ERROR_MESSAGE, PublicError } from 'broapp/shared';
import type { PublicErrorCode } from 'broapp/shared';

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
  /**
   * Forward one operation call into the application.
   *
   * The child runs it through its own gate on channel `mcp`, so a write asks
   * the person in the application's tab and is refused when no tab is open. The
   * launcher does not decide anything here; it carries the call.
   */
  invoke(params: {
    route: string;
    input: unknown;
    client: string;
    requestId: string;
    timeoutMs: number;
    /** An acceptance example the launcher runs itself; see `Invoke.as`. */
    as?: 'check';
  }): Promise<unknown>;
  /** Stop admitting writes and wait for work to finish. `false` means the deadline passed first. */
  drain(deadlineMs: number): Promise<boolean>;
  shutdown(deadlineMs: number): Promise<{ exitCode: number | null; killed: boolean }>;
  readonly exited: Promise<number | null>;
}

/** Options for {@link createSupervisor}. */
export interface SupervisorOptions {
  /**
   * The binary to spawn. Defaults to this launcher, run again — which is
   * `process.execPath` when the launcher is compiled, and Bun running the
   * launcher's entry module when it is not. See {@link selfCommand}.
   */
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
  /**
   * Kill every child, now, without waiting for anything.
   *
   * The graceful path is `stopAll`. This exists for `process.on('exit')`, which
   * is synchronous — a promise made there is never settled. It matters most on
   * Windows, where a console process is not delivered `SIGTERM` the way a POSIX
   * one is, so the signal handlers that normally run `stopAll` never fire and
   * this is the last chance to stop a child outliving its launcher.
   */
  killAll(): void;
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
 * Bun names a compiled binary's own modules under a virtual root. This is the
 * one signal that says whether the launcher running now is a single file or a
 * tree of sources; `process.execPath` alone does not, since either way it is a
 * path to something that runs.
 */
const COMPILED_ROOT = /^(\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/;

/** Whether this launcher is running from a compiled binary. */
export function isCompiled(): boolean {
  return COMPILED_ROOT.test(import.meta.path);
}

/**
 * How to run this launcher again, so it can be the child.
 *
 * A compiled launcher is one file and spawning `process.execPath` is spawning
 * it. Run from source — `bun src/launcher/main.ts`, or the `broapp-autoapp` bin
 * that `bun install` links straight to that file — `process.execPath` is Bun
 * itself, and Bun handed `--child <releaseDir> …` reads the release directory
 * as the script to run and stops with "Script not found". So from source the
 * entry module goes in between. It is named from this file's own location
 * rather than from `Bun.main`, so a program that imports the launcher as a
 * library still spawns the launcher and not itself.
 */
export function selfCommand(): readonly string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, join(import.meta.dir, 'main.ts')];
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
  const command = options.execPath === undefined ? selfCommand() : [options.execPath];
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const live = new Set<ChildHandle>();
  /**
   * The subprocess behind each handle, for `killAll`. A handle deliberately
   * exposes no way to kill without waiting, because every other caller should
   * be draining first.
   */
  const processes = new Map<ChildHandle, Subprocess>();

  /** Spawn a child and wrap its IPC channel in something waitable. */
  function launch(
    args: readonly string[],
    dataDir: string,
  ): { process: Subprocess; channel: Channel } {
    const inbox: Message[] = [];
    let arrived: () => void = () => undefined;
    let protocolFault: Error | null = null;
    let gone: Error | null = null;

    const child = spawn({
      cmd: [...command, ...args],
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

    // A child that has died will never answer, and a caller waiting on it would
    // otherwise sit out its whole deadline — up to five minutes for an MCP call
    // waiting on a person. Its exit wakes everybody waiting instead.
    void child.exited.then(
      (code) => {
        gone = new PublicError(
          'unavailable',
          `the application stopped (exit code ${String(code)})`,
        );
        arrived();
      },
      () => {
        gone = new PublicError('unavailable', 'the application stopped');
        arrived();
      },
    );

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
              // Checked after the inbox, so a reply that arrived just before
              // the child exited is still delivered.
              const dead: Error | null = gone;
              if (dead !== null) {
                reject(dead);
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

        async invoke({ route, input, client, requestId, timeoutMs, as }): Promise<unknown> {
          const reply = await request(
            {
              v: IPC_VERSION,
              id: nextId(),
              type: 'invoke',
              route,
              input,
              client,
              requestId,
              ...(as === undefined ? {} : { as }),
            },
            timeoutMs,
            `${route} to answer`,
          );
          if (reply.type !== 'invoke') throw new Error('the child answered invoke with something else');
          if (reply.ok === true) return reply.output;
          throw new PublicError(
            (reply.code ?? 'internal') as PublicErrorCode,
            reply.message ?? INTERNAL_ERROR_MESSAGE,
          );
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
      processes.set(handle, child);
      void child.exited.then(() => {
        live.delete(handle);
        processes.delete(handle);
      });
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

    killAll(): void {
      for (const child of processes.values()) {
        try {
          child.kill();
        } catch {
          // Already gone. There is nothing to report from an exit handler.
        }
      }
    },
  };

  return supervisor;
}
