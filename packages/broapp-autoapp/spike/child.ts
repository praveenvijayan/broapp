/**
 * The spike's application child.
 *
 * It is the shape a real application child will have: it announces itself,
 * loads an application artifact that is *not* in its own bundle, says when it
 * is serving, answers health, drains, and exits when told to. Everything it
 * does with the artifact — importing it and calling `start()` — is trusted
 * local code running with the owner's own permissions. The child boundary is
 * there so that a crash takes one application down instead of the launcher,
 * not so that the code inside it is confined.
 */
import { parseMessage } from '../src/ipc/codec.ts';
import { IPC_VERSION, type Message } from '../src/ipc/messages.ts';

/** What an application artifact has to export. */
interface Artifact {
  start(): Promise<{ schemaVersion: number; stop(): Promise<void> }> | { schemaVersion: number; stop(): Promise<void> };
}

/** Deliberate misbehaviour, for the tests that need a child that does the wrong thing. */
type Misbehaviour = 'ignore-shutdown' | 'no-hello' | 'bad-version' | null;

/** The exit code a protocol violation ends the child with. */
const PROTOCOL_EXIT_CODE = 3;

/** Message identifiers only have to be unique within one channel. */
let counter = 0;
function nextId(): string {
  counter += 1;
  return `c${String(counter)}`;
}

/** Run the child. Returns only when it is about to exit. */
export async function main(argv: readonly string[]): Promise<number> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    // Without a channel there is nobody to report to and nothing to supervise
    // this process, so it must not go on to run application code.
    console.error('this binary must be spawned by the launcher, with an IPC channel');
    return 2;
  }

  const [artifactPath, appId, releaseId] = argv;
  const misbehave = (process.env['AUTOAPP_SPIKE_MISBEHAVE'] ?? null) as Misbehaviour;

  const post = (message: Message): void => void send(message);

  if (misbehave !== 'no-hello') {
    const hello = {
      v: misbehave === 'bad-version' ? 2 : IPC_VERSION,
      id: nextId(),
      type: 'hello',
      appId: appId ?? 'unknown',
      releaseId: releaseId ?? 'unknown',
      pid: process.pid,
    };
    send(hello);
  }

  let started: { schemaVersion: number; stop(): Promise<void> };
  try {
    if (artifactPath === undefined) throw new Error('no artifact path was given');
    // The whole point of the spike: an absolute path that no static import
    // reaches, loaded by a compiled binary with no Bun on PATH.
    const artifact = (await import(artifactPath)) as Artifact;
    if (typeof artifact.start !== 'function') {
      throw new Error('the artifact does not export start()');
    }
    started = await artifact.start();
  } catch (cause) {
    // One sentence, no stack: the launcher may put this in a record.
    post({
      v: IPC_VERSION,
      id: nextId(),
      type: 'fatal',
      reason: `the application artifact could not be started: ${String(cause instanceof Error ? cause.message : cause)}`,
    });
    // Same reason as the ordinary exit below: the open channel would otherwise
    // keep this process alive after it has given up.
    process.disconnect?.();
    return 1;
  }

  post({
    v: IPC_VERSION,
    id: nextId(),
    type: 'ready',
    url: 'spike://none',
    schemaVersion: started.schemaVersion,
  });

  let state: 'starting' | 'serving' | 'draining' | 'stopping' = 'serving';

  // Resolved when the child has decided what to exit with. Everything below
  // runs from the message handler, so the function has to wait for it rather
  // than return.
  let finish: (code: number) => void = () => undefined;
  const exiting = new Promise<number>((resolve) => {
    finish = resolve;
  });

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
      finish(PROTOCOL_EXIT_CODE);
      return;
    }

    switch (message.type) {
      case 'health':
        post({ v: IPC_VERSION, id: nextId(), re: message.id, type: 'health', state, activeWork: 0, attached: false });
        break;
      case 'drain':
        state = 'draining';
        // The spike has no work in flight, so draining is immediate. A real
        // child answers when `activeWork` reaches zero or the deadline passes.
        post({ v: IPC_VERSION, id: nextId(), re: message.id, type: 'drain', deadlineMs: message.deadlineMs, drained: true });
        break;
      case 'shutdown':
        if (misbehave === 'ignore-shutdown') return;
        state = 'stopping';
        void started.stop().then(
          () => finish(0),
          () => finish(1),
        );
        break;
      case 'fatal':
        // A `fatal` arriving *from* the launcher is how it refuses a channel it
        // cannot read — a version it does not understand, most of all. There is
        // nothing to negotiate, so the child stops with the protocol code.
        finish(PROTOCOL_EXIT_CODE);
        break;
      default:
        // `hello` and `ready` only ever travel the other way.
        post({
          v: IPC_VERSION,
          id: nextId(),
          type: 'fatal',
          reason: `the launcher sent a ${message.type} message, which only a child sends`,
        });
        finish(PROTOCOL_EXIT_CODE);
        break;
    }
  });

  const code = await exiting;
  // The IPC channel is a live handle: while it is open the event loop has
  // something to wait on and the process will not exit on its own, however
  // done it is. Closing it is what turns "decided to exit" into exiting.
  process.disconnect?.();
  return code;
}
