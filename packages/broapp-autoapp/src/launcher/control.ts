/**
 * How a separate process reaches a running application.
 *
 * An MCP server is its own process — the client starts it, not the launcher —
 * so it needs a way in. That way is a loopback socket the launcher listens on,
 * named in `<root>/launcher.json` with a secret beside it.
 *
 * What the secret is and is not for. A process running as this user is already
 * trusted local code: it can read `launcher.json`, whose mode is `0600`, and it
 * could just as easily read the application's database directly. So the secret
 * is not a permission boundary between programs — it is there so that something
 * which merely reached the port, a local scanner or a page in a browser that
 * guessed it, cannot call tools. The listener also refuses any connection whose
 * remote address is not `127.0.0.1`. Together those are a same-user check, and
 * the real boundary is the gate on the other side of it.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'bun';

import { INTERNAL_ERROR_MESSAGE, isPublicError } from 'broapp/shared';
import type { HostLogger } from 'broapp/host';

import { readCurrent, readRelease, type Layout } from '../spec/index.ts';

import type { Supervisor } from './supervisor.ts';

/** What `launcher.json` holds. */
export interface ControlFile {
  readonly v: 1;
  readonly port: number;
  readonly secret: string;
  readonly pid: number;
}

/** A running control listener. */
export interface Control {
  readonly port: number;
  readonly hostname: string;
  readonly secret: string;
  stop(): void;
}

/** Options for {@link startControl}. */
export interface StartControlOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly logger?: HostLogger;
  /** How long one forwarded call may take. Default 300_000, to allow for a person. */
  readonly invokeTimeoutMs?: number;
}

/** The one address anything may connect from. */
const LOOPBACK = '127.0.0.1';
/** How long an unauthenticated connection is tolerated. */
const AUTH_DEADLINE_MS = 2_000;
/** The most one line may be. A control message is small; a megabyte is generous. */
const MAX_LINE_BYTES = 1_000_000;
/** How long a forwarded call may take, allowing for somebody to answer a question. */
const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

/** Per-connection state. */
interface Session {
  authenticated: boolean;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Write `launcher.json` without ever leaving a half-written one behind. */
function writeControlFile(path: string, contents: ControlFile): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  // Set explicitly as well: `writeFileSync`'s mode is subject to the umask,
  // and this file's whole job is to be readable by nobody else.
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Start the launcher's control listener. */
export function startControl(options: StartControlOptions): Control {
  const { layout: root, supervisor } = options;
  const logger: HostLogger = options.logger ?? console;
  const invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const secret = randomBytes(32).toString('hex');
  const sessions = new WeakMap<Socket<undefined>, Session>();

  /** Answer one request. */
  async function handle(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = request['id'];
    const reply = (body: Record<string, unknown>): Record<string, unknown> => ({ v: 1, re: id, ...body });

    if (request['type'] === 'describe') {
      const appId = String(request['appId'] ?? '');
      const releaseId = readCurrent(root, appId);
      if (releaseId === null) {
        return reply({ ok: false, code: 'not_found', message: `${appId} has no current release.` });
      }
      // Read from the store: describing an application needs no child, and a
      // client asking what is available should not start a process.
      const spec = readRelease(root, appId, releaseId);
      return reply({ ok: true, output: { releaseId, name: spec.manifest.name, contract: spec.contract } });
    }

    if (request['type'] === 'serving') {
      // Asked by `broapp-autoapp remove`, which runs in its own process and so
      // has a supervisor with no children in it. Only whether, never where: an
      // answer carrying a launch URL would put a credential on this socket for
      // a question that does not need one.
      const appId = String(request['appId'] ?? '');
      const child = supervisor.children.find(
        (candidate) => candidate.appId === appId && candidate.mode === 'live',
      );
      return reply({ ok: true, output: { serving: child !== undefined } });
    }

    if (request['type'] === 'invoke') {
      const appId = String(request['appId'] ?? '');
      const child = supervisor.children.find(
        (candidate) => candidate.appId === appId && candidate.mode === 'live',
      );
      if (child === undefined) {
        return reply({
          ok: false,
          code: 'unavailable',
          message: `${appId} is not running. Open it from the launcher first.`,
        });
      }
      try {
        const output = await child.invoke({
          route: String(request['route'] ?? ''),
          input: request['input'],
          client: String(request['client'] ?? 'unknown'),
          requestId: String(request['requestId'] ?? crypto.randomUUID()),
          timeoutMs: invokeTimeoutMs,
        });
        return reply({ ok: true, output });
      } catch (cause) {
        // The same boundary the bridge draws: a deliberate message crosses, a
        // host failure does not.
        return reply({
          ok: false,
          code: isPublicError(cause) ? cause.code : 'internal',
          message: isPublicError(cause) ? cause.message : INTERNAL_ERROR_MESSAGE,
        });
      }
    }

    return reply({ ok: false, code: 'invalid_input', message: 'unknown request type' });
  }

  const server = Bun.listen<undefined>({
    hostname: LOOPBACK,
    port: 0,
    socket: {
      open(socket) {
        // A connection from anywhere but this machine is not something to
        // answer. Binding to loopback already prevents it; this is the second
        // lock on the same door.
        if (socket.remoteAddress !== LOOPBACK && socket.remoteAddress !== '::1') {
          socket.end();
          return;
        }
        const session: Session = {
          authenticated: false,
          buffer: '',
          timer: setTimeout(() => {
            if (!session.authenticated) socket.end();
          }, AUTH_DEADLINE_MS),
        };
        session.timer?.unref?.();
        sessions.set(socket, session);
      },

      data(socket, chunk) {
        const session = sessions.get(socket);
        if (session === undefined) {
          socket.end();
          return;
        }
        session.buffer += new TextDecoder().decode(chunk);
        if (session.buffer.length > MAX_LINE_BYTES) {
          logger.warn('[autoapp] a control connection sent an oversized line; closing it');
          socket.end();
          return;
        }

        for (;;) {
          const newline = session.buffer.indexOf('\n');
          if (newline < 0) break;
          const line = session.buffer.slice(0, newline);
          session.buffer = session.buffer.slice(newline + 1);
          if (line.trim() === '') continue;

          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            socket.end();
            return;
          }

          if (!session.authenticated) {
            // The first line must be the authentication, and must be right.
            // Anything else closes the connection rather than answering it.
            const looksRight =
              message['v'] === 1 &&
              message['type'] === 'auth' &&
              typeof message['secret'] === 'string' &&
              timingSafeEquals(message['secret'], secret);
            if (!looksRight) {
              socket.end();
              return;
            }
            session.authenticated = true;
            if (session.timer !== null) clearTimeout(session.timer);
            socket.write(`${JSON.stringify({ v: 1, type: 'auth', ok: true })}\n`);
            continue;
          }

          void handle(message).then(
            (reply) => socket.write(`${JSON.stringify(reply)}\n`),
            (cause: unknown) => {
              logger.error(`[autoapp] a control request failed: ${String(cause)}`);
              socket.write(
                `${JSON.stringify({ v: 1, re: message['id'], ok: false, code: 'internal', message: INTERNAL_ERROR_MESSAGE })}\n`,
              );
            },
          );
        }
      },

      close(socket) {
        const session = sessions.get(socket);
        if (session?.timer != null) clearTimeout(session.timer);
      },

      error(socket, error) {
        logger.warn(`[autoapp] a control connection failed: ${error.message}`);
        socket.end();
      },
    },
  });

  mkdirSync(root.root, { recursive: true, mode: 0o700 });
  writeControlFile(root.control, { v: 1, port: server.port, secret, pid: process.pid });

  return {
    port: server.port,
    hostname: LOOPBACK,
    secret,
    stop() {
      server.stop(true);
      // The file names a port nothing is listening on any more; leaving it
      // would send the next MCP server somewhere that does not answer.
      rmSync(root.control, { force: true });
    },
  };
}

/**
 * Compare two secrets without leaking their length through timing.
 *
 * Both are hex of a known length, so this is close to ceremonial — but a
 * comparison that returns early on the first differing character is the sort of
 * thing that gets copied somewhere it matters.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
