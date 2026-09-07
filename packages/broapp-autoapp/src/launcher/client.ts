/**
 * Talking to a child the way a browser would.
 *
 * Brobridge authenticates a connection the way a web application does: the
 * launch URL carries a one-time token, `GET /` redeems it and answers `303`
 * with a session cookie, and the WebSocket upgrade has to carry that cookie and
 * a same-origin `Origin` header past the trust fence. A browser does all of
 * that for free. A process does not, so this supplies the two pieces it is
 * missing — a cookie jar, and a socket factory that sets the headers.
 *
 * Nothing here weakens the fence: the connection satisfies exactly the same
 * checks a tab does. The launcher is allowed to make one because it is the
 * process that started the child and therefore already holds its launch URL.
 * That URL is a credential and is never written down.
 */
import { connect } from '@brobridgejs/client';
import type { Bridge } from '@brobridgejs/client';

/** The slice of `fetch` the Brobridge client actually calls. */
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

/** A cookie jar for one connection: one origin, whatever the host set. */
function jar(): { fetch: FetchLike; header: () => string } {
  const cookies = new Map<string, string>();
  const header = (): string => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

  const wrapped: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const current = header();
    if (current !== '') headers.set('cookie', current);
    // `redirect: "manual"` matters: the bootstrap answers 303 and sets the
    // session cookie on *that* response, which following the redirect
    // automatically would hide.
    const response = await fetch(input as RequestInfo, { ...init, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };

  return { fetch: wrapped, header };
}

/** Connect to a child's bridge at its launch URL. */
export async function connectToChild(url: string): Promise<Bridge> {
  const cookies = jar();
  const origin = new URL(url).origin;
  return await connect(url, {
    // One attempt: every caller here is doing something with a deadline of its
    // own, and a client quietly retrying underneath it would hide a child that
    // has died.
    reconnect: false,
    fetch: cookies.fetch as never,
    socket: ((target: string) =>
      // Bun's `WebSocket` takes headers, which the standard one does not. This
      // is the only thing in the file that is not plain web platform.
      new WebSocket(target, { headers: { cookie: cookies.header(), origin } } as never)) as never,
  });
}
