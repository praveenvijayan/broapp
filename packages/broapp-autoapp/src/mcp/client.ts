/**
 * The MCP server's end of the launcher's control connection.
 *
 * A small newline-delimited JSON client. It is separate from the server itself
 * so a test can drive the control protocol without an MCP client, and so the
 * one place that holds the secret is one short file.
 */
import { readFileSync } from 'node:fs';
import type { Socket } from 'bun';

import type { ContractExport } from '../spec/types.ts';
import type { ControlFile } from '../launcher/control.ts';

/** What an application looks like from outside it. */
export interface Described {
  readonly releaseId: string;
  readonly name: string;
  readonly contract: ContractExport;
}

/** A connection to a running launcher. */
export interface ControlClient {
  describe(appId: string): Promise<Described>;
  /** Whether the launcher on the other end has a live child for this application. */
  serving(appId: string): Promise<boolean>;
  invoke(params: {
    appId: string;
    route: string;
    input: unknown;
    client: string;
  }): Promise<{ ok: true; output: unknown } | { ok: false; code: string; message: string }>;
  close(): void;
}

/** Raised when the launcher is not running. */
export class LauncherNotRunning extends Error {
  constructor() {
    super('the launcher is not running; start it with `broapp-autoapp serve`');
    this.name = 'LauncherNotRunning';
  }
}

/** How long to wait for one reply. Generous: a write waits for a person. */
const REPLY_TIMEOUT_MS = 300_000;

/** Read `launcher.json`, or say the launcher is not running. */
export function readControlFile(path: string): ControlFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new LauncherNotRunning();
  }
  try {
    const parsed = JSON.parse(raw) as ControlFile;
    if (parsed.v !== 1 || typeof parsed.port !== 'number' || typeof parsed.secret !== 'string') {
      throw new LauncherNotRunning();
    }
    return parsed;
  } catch {
    throw new LauncherNotRunning();
  }
}

/** Connect to a running launcher and authenticate. */
export async function connectControl(controlPath: string): Promise<ControlClient> {
  const file = readControlFile(controlPath);

  const waiting = new Map<string, (reply: Record<string, unknown>) => void>();
  let authenticated: (() => void) | null = null;
  let buffer = '';
  let counter = 0;

  const authDone = new Promise<void>((resolve) => {
    authenticated = resolve;
  });

  let socket: Socket<undefined>;
  try {
    socket = await Bun.connect<undefined>({
      hostname: '127.0.0.1',
      port: file.port,
      socket: {
        data(_socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() === '') continue;
            let message: Record<string, unknown>;
            try {
              message = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (message['type'] === 'auth') {
              authenticated?.();
              continue;
            }
            const re = message['re'];
            if (typeof re === 'string') waiting.get(re)?.(message);
          }
        },
        close() {
          // Anything still waiting will never be answered; failing them now is
          // better than a deadline several minutes away.
          for (const [, settle] of waiting) {
            settle({ ok: false, code: 'unavailable', message: 'the launcher closed the connection' });
          }
          waiting.clear();
        },
      },
    });
  } catch {
    throw new LauncherNotRunning();
  }

  socket.write(`${JSON.stringify({ v: 1, type: 'auth', secret: file.secret })}\n`);
  await authDone;

  /** Send one request and wait for its reply. */
  function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    counter += 1;
    const id = `m${String(counter)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`timed out waiting for ${String(body['type'])}`));
      }, REPLY_TIMEOUT_MS);
      timer.unref?.();
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(reply);
      });
      socket.write(`${JSON.stringify({ v: 1, id, ...body })}\n`);
    });
  }

  return {
    async describe(appId) {
      const reply = await request({ type: 'describe', appId });
      if (reply['ok'] !== true) {
        throw new Error(String(reply['message'] ?? 'the application could not be described'));
      }
      return reply['output'] as Described;
    },

    async serving(appId) {
      const reply = await request({ type: 'serving', appId });
      if (reply['ok'] !== true) {
        throw new Error(String(reply['message'] ?? 'the launcher would not say'));
      }
      return (reply['output'] as { serving?: unknown }).serving === true;
    },

    async invoke({ appId, route, input, client }) {
      const reply = await request({
        type: 'invoke',
        appId,
        route,
        input,
        client,
        requestId: crypto.randomUUID(),
      });
      return reply['ok'] === true
        ? { ok: true, output: reply['output'] }
        : {
            ok: false,
            code: String(reply['code'] ?? 'internal'),
            message: String(reply['message'] ?? 'the call failed'),
          };
    },

    close() {
      socket.end();
    },
  };
}
