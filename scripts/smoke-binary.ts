#!/usr/bin/env bun
/**
 * Native smoke test for a compiled executable.
 *
 * Launches the binary, completes the authenticated bootstrap the way a browser
 * does, calls an operation over the HTTP fallback, and shuts it down. It is
 * deliberately not a browser test: it runs on any CI runner, needs no display,
 * and covers the part most likely to break in packaging — that the binary
 * starts, serves its embedded page, and answers.
 *
 * Only ever run against a binary built for the machine running it. A
 * cross-compiled binary cannot be smoke-tested here, and pretending otherwise
 * is the failure this script exists to avoid.
 *
 *   bun run scripts/smoke-binary.ts ./release/my-app [--call notes.status]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [binary, ...rest] = process.argv.slice(2);
if (binary === undefined) {
  console.error('usage: bun run scripts/smoke-binary.ts <path-to-binary> [--call <route>]');
  process.exit(2);
}

const callIndex = rest.indexOf('--call');
const route = callIndex >= 0 ? rest[callIndex + 1] : undefined;

const dataDir = await mkdtemp(join(tmpdir(), 'broapp-smoke-'));
// Run from a directory unrelated to the binary and to any source tree, so a
// hidden dependency on either shows up as a failure here.
const cwd = await mkdtemp(join(tmpdir(), 'broapp-cwd-'));

let child: ReturnType<typeof Bun.spawn> | null = null;
const failures: string[] = [];

/**
 * A timeout that does not hold the process open.
 *
 * `Bun.sleep` gives no handle to clear, so a race that resolves early leaves
 * its loser's timer running and the process sits there until it fires. That is
 * invisible in a test that then exits — and very visible in CI, where every
 * smoke test would take the full timeout.
 */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    failures.push(label);
  }
}

try {
  console.log(`smoke: ${binary}`);

  // Resolved before the cwd changes underneath it: the binary is deliberately
  // run from an unrelated directory, so a relative path would not survive.
  const executable = resolve(binary);
  child = Bun.spawn([executable, '--no-open', '--background'], {
    cwd,
    env: { ...process.env, BROAPP_DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // The launch URL is printed on stdout. Read until it appears or time runs out.
  const url = await readLaunchUrl(child.stdout, 30_000);
  check('the binary starts and prints a launch URL', url !== null);
  if (url === null) throw new Error('no launch URL');

  const origin = url.slice(0, url.indexOf('/?'));

  const unauthenticated = await fetch(`${origin}/`, { redirect: 'manual' });
  check('an unauthenticated request is refused', unauthenticated.status === 403, `got ${String(unauthenticated.status)}`);

  const foreign = await fetch(url, { headers: { origin: 'http://evil.example' }, redirect: 'manual' });
  check('a foreign Origin is refused', foreign.status === 403, `got ${String(foreign.status)}`);

  const bootstrap = await fetch(url, { redirect: 'manual' });
  check('the launch token bootstraps a session', bootstrap.status === 303, `got ${String(bootstrap.status)}`);
  const cookie = bootstrap.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
  check('a session cookie is set', cookie !== '');

  const replay = await fetch(url, { redirect: 'manual' });
  check('the launch token is single use', replay.status === 403, `got ${String(replay.status)}`);

  const page = await fetch(`${origin}/`, { headers: { cookie }, redirect: 'manual' });
  const html = await page.text();
  check('the embedded page is served', page.status === 200 && html.includes('<!doctype html'));
  check('the page carries a Content-Security-Policy', html.includes('Content-Security-Policy'));
  check('the policy has no unsafe-inline', !html.includes('unsafe-inline'));
  check('the page has an inline script', html.includes('<script type="module">'));
  check('the page loads no off-origin script', !/<script[^>]+src=/.test(html));

  if (route !== undefined) {
    const answered = await callOverBridge(origin, cookie, route);
    check(`the operation ${route} answers`, answered);
  }

  // A clean SIGTERM must actually stop it.
  child.kill('SIGTERM');
  const exited = await Promise.race([child.exited, after(10_000, 'timeout' as const)]);
  check('SIGTERM stops the process', exited !== 'timeout', 'still running after 10s');
  child = null;
} catch (cause) {
  console.log(`  FAIL  ${String(cause instanceof Error ? cause.message : cause)}`);
  failures.push('unexpected failure');
} finally {
  child?.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');

/** Read stdout until a launch URL appears. */
async function readLaunchUrl(
  stream: ReadableStream<Uint8Array> | number | undefined,
  timeoutMs: number,
): Promise<string | null> {
  if (typeof stream !== 'object' || stream === null) return null;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        after(Math.max(0, deadline - Date.now()), null),
      ]);
      if (next === null) return null;
      if (next.done) return null;
      buffer += decoder.decode(next.value, { stream: true });
      process.stdout.write(`  | ${next.value.length > 0 ? decoder.decode(next.value) : ''}`);
      const match = /https?:\/\/[^\s]+\?bt=[A-Za-z0-9_-]+/.exec(buffer);
      if (match !== null) return match[0];
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

/**
 * Make a real, authenticated call.
 *
 * A full Brobridge client over a real WebSocket, with the cookie the bootstrap
 * just issued. Framing a request by hand would duplicate protocol code and
 * would not prove the same thing; this exercises the path a browser uses.
 */
async function callOverBridge(origin: string, cookie: string, route: string): Promise<boolean> {
  const { connect } = await import('@brobridgejs/client');
  const { WebSocket: NodeWebSocket } = await import('ws');

  const bridge = await connect(origin, {
    reconnect: false,
    socket: (url) =>
      new NodeWebSocket(url, {
        headers: { cookie, origin },
      }) as unknown as ReturnType<NonNullable<Parameters<typeof connect>[1]>['socket'] & object>,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      return fetch(input, { ...init, headers });
    },
  });

  try {
    // A route that exists answers; one that does not rejects with NOT_FOUND.
    // Either way the host routed the call, which is what is being checked —
    // but the caller passes a real route, so this should resolve.
    await bridge.call(route, undefined);
    return true;
  } catch {
    return false;
  } finally {
    await bridge.close();
  }
}
