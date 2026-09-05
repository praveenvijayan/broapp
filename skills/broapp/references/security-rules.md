# Security model, in short

Everything protecting the connection is Brobridge, used unchanged. Broapp
does not implement any of it and does not weaken any of it. Brobridge's
THREAT-MODEL.md is the authoritative document.

## What Brobridge provides

- **Loopback only.** `127.0.0.1`, ephemeral port. `allowNonLoopback` is not
  forwarded by Broapp, so no config change can expose the app to a LAN.
- **One-time launch token.** Valid once, for two minutes. Redeeming it sets
  the session cookie and redirects to `/` without the token.
- **Trust fence.** `Host` and `Origin` checked before routing, before a body
  is read. Another origin, including another port on `127.0.0.1`, gets 403.
- **Session cookie.** `HttpOnly; SameSite=Strict`. Without it, every route
  is 403.
- **Closed route table.** `/`, `/ws`, `/rpc`. No static files, so no
  traversal surface.
- **Framing refused** via `Sec-Fetch-Site` (only `same-origin` or `none`).
- **Rate-limited auth failures.** Twenty per minute per address.

## What Broapp adds

- A `<meta>` Content-Security-Policy with `default-src 'none'`, script and
  style pinned by hash, `connect-src 'self' ws://127.0.0.1:*`. No
  `'unsafe-inline'`. Extra sources go in `broapp.config.ts` under `csp`.
- A build-time check that fails on any off-origin `src`, `href`, `url()`
  or `@import`.
- Host-side validation of every operation input.
- A public/internal error boundary. Only `PublicError` messages cross.
- The launch URL goes to the terminal only, never a file.

## What none of this protects against

Tell the user plainly when it is relevant.

- Loopback HTTP is not TLS. Anything that can sniff local traffic can read it.
- Authentication is not a sandbox. The host runs with the user's
  permissions and can do what they can do.
- A compromised frontend has the session. Page code can call every exposed
  operation. The app is only as safe as its operations.
- Local malware is out of scope. Another process as the same user can read
  the data directory and the process memory.
- Neither Broapp nor Brobridge is independently audited. Do not say
  otherwise.

## Rules for operations

1. **Never expose a shell.** No operation that runs a command string, ever.
   No escaping fixes it.
2. **Never expose unrestricted filesystem access.** One host-side root,
   relative names, containment on the resolved path.
3. **Validate at the boundary, then for your own rules.** Types and bounds
   in the contract; business rules in the handler.
4. **Keep paths and driver messages out of `PublicError`.**
5. **Bound everything.** Strings, arrays, file sizes, listing counts.
6. **Do not auto-retry mutations** after a dropped socket.
7. **Do not log secrets.** Not the launch URL, not the cookie, not input
   that might contain a credential.
8. **Expose only what the page needs.** Every operation is callable by any
   code that runs in the page.

## Where to report

Transport, fence or auth issues: the Brobridge repository's security
advisories. Generator, build, contract or lifecycle issues: a private
security advisory on the Broapp repository.
