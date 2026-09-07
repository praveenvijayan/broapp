/**
 * The spike's launcher.
 *
 * One compiled binary is both roles: run with `--child` it is the child, and
 * otherwise it is the launcher that spawns `process.execPath` — itself — with
 * that flag. That is how the real launcher will start applications too, and it
 * is why the spike compiles: `bun run` would prove nothing about a binary with
 * no Bun installation to fall back on.
 *
 * Everything here has a deadline. A supervisor that can hang is worse than no
 * supervisor, because the application it was meant to look after is now held
 * open by it.
 */
import { main as childMain } from './child.ts';
import { parseMessage } from '../src/ipc/codec.ts';
import { IPC_VERSION, type Message } from '../src/ipc/messages.ts';

/** How long each stage may take. */
const HELLO_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
const DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_DEADLINE_MS = 2_000;
/** How long a child gets to exit after being told its protocol was refused. */
const PROTOCOL_EXIT_TIMEOUT_MS = 3_000;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `l${String(counter)}`;
}

/** A promise that rejects when the deadline passes, and does not hold the process open. */
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
 * Deliberately not `process.env`. A `PATH` that leads nowhere is the
 * interesting part: if anything in the chain quietly shells out to a `bun` on
 * the path, the spike fails instead of passing on a machine that happens to
 * have one. The child still starts, because it is spawned by absolute path
 * from `process.execPath`.
 *
 * On Windows the value is empty rather than `/nonexistent`. A path entry that
 * is not a valid Windows path is not merely unhelpful — process creation
 * consults `PATH` for the DLL search as well, and giving it nonsense has been
 * seen to fail the spawn itself rather than the lookup it was meant to break.
 * Empty says the same thing in a way Windows understands.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.platform === 'win32' ? '' : '/nonexistent' };
  for (const name of ['HOME', 'TMPDIR', 'TEMP', 'BROAPP_DATA_DIR', 'AUTOAPP_SPIKE_MISBEHAVE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** What one supervised run produced. */
interface Result {
  hello: boolean;
  ready: boolean;
  schemaVersion: number | null;
  health: string | null;
  drained: boolean;
  exitCode: number | null;
  killed: boolean;
  elapsedMs: number;
}

/** Supervise one child from spawn to exit. */
async function supervise(artifact: string, appId: string, releaseId: string): Promise<Result> {
  const startedAt = Date.now();
  const inbox: Message[] = [];
  /** Called when a message arrives, so a waiter can re-check its predicate. */
  let arrived: () => void = () => undefined;
  /** Set when the child said something this build cannot read. */
  let protocolFault: Error | null = null;

  const child = Bun.spawn({
    cmd: [process.execPath, '--child', artifact, appId, releaseId],
    env: childEnv(),
    stdout: 'ignore',
    stderr: 'inherit',
    serialization: 'json',
    ipc: (raw: unknown) => {
      try {
        inbox.push(parseMessage(raw));
      } catch (cause) {
        // A message this build cannot read ends the channel. The child is told
        // so with `fatal`, which is how it learns to exit with the protocol
        // code rather than sit there waiting for an answer.
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

  /** Wait until one message in the inbox satisfies `match`. */
  function waitFor(match: (message: Message) => boolean, ms: number, label: string): Promise<Message> {
    return withDeadline(
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
          // A child that has declared itself lost is not going to send what is
          // being waited for. Reporting its reason now is far more useful than
          // reporting a timeout in ten seconds' time.
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
    );
  }

  /** Send a request and wait for the reply that names it. */
  async function request(message: Message, ms: number, label: string): Promise<Message> {
    child.send(message);
    return await waitFor((reply) => reply.re === message.id, ms, label);
  }

  try {
    const hello = await waitFor((message) => message.type === 'hello', HELLO_TIMEOUT_MS, 'hello');
    if (hello.type !== 'hello') throw new Error('the first message was not hello');

    const ready = await waitFor((message) => message.type === 'ready', READY_TIMEOUT_MS, 'ready');
    if (ready.type !== 'ready') throw new Error('the second message was not ready');

    const health = await request(
      { v: IPC_VERSION, id: nextId(), type: 'health' },
      HEALTH_TIMEOUT_MS,
      'a health reply',
    );
    const drain = await request(
      { v: IPC_VERSION, id: nextId(), type: 'drain', deadlineMs: DRAIN_TIMEOUT_MS },
      DRAIN_TIMEOUT_MS,
      'a drain reply',
    );

    child.send({ v: IPC_VERSION, id: nextId(), type: 'shutdown', deadlineMs: SHUTDOWN_DEADLINE_MS });
    let killed = false;
    let exitCode: number | null;
    try {
      exitCode = await withDeadline(child.exited, SHUTDOWN_DEADLINE_MS, 'the child to exit');
    } catch {
      // A child that will not stop is stopped. This is the whole reason the
      // shutdown message carries a deadline rather than a request.
      child.kill();
      killed = true;
      exitCode = await withDeadline(child.exited, SHUTDOWN_DEADLINE_MS, 'the killed child to exit');
    }

    return {
      hello: true,
      ready: true,
      schemaVersion: ready.type === 'ready' ? ready.schemaVersion : null,
      health: health.type === 'health' ? (health.state ?? null) : null,
      drained: drain.type === 'drain' && drain.drained === true,
      exitCode,
      killed,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (cause) {
    // Whatever went wrong, the child does not outlive the launcher. It is given
    // a moment to exit on its own — a protocol refusal it has just been sent is
    // the usual reason — and killed if it does not.
    let exitCode: number | null = null;
    try {
      exitCode = await withDeadline(child.exited, PROTOCOL_EXIT_TIMEOUT_MS, 'the child to exit');
    } catch {
      child.kill();
      exitCode = await child.exited.catch(() => null);
    }
    const error = new Error(cause instanceof Error ? cause.message : String(cause));
    Object.assign(error, { pid: child.pid, childExit: exitCode });
    throw error;
  }
}

/** Run the launcher, or the child when `--child` is the first argument. */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child') return await childMain(argv.slice(1));

  const [artifact, appId, releaseId] = argv;
  if (artifact === undefined || appId === undefined || releaseId === undefined) {
    console.log(JSON.stringify({ error: 'usage: launcher <artifact> <appId> <releaseId>' }));
    return 1;
  }
  try {
    console.log(JSON.stringify(await supervise(artifact, appId, releaseId)));
    return 0;
  } catch (cause) {
    const detail = cause as Error & { pid?: number; childExit?: number | null };
    console.log(
      JSON.stringify({
        error: detail.message,
        pid: detail.pid ?? null,
        childExit: detail.childExit ?? null,
      }),
    );
    return 1;
  }
}

// `bun build --compile --bytecode` rejects top-level await, so the entry point
// keeps every await inside a function and ends with a plain `.then`.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    console.log(JSON.stringify({ error: String(cause instanceof Error ? cause.message : cause) }));
    process.exitCode = 1;
  },
);
