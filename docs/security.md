# Security model

## What is actually protecting this

Everything in this section is [Brobridge](https://github.com/praveenvijayan/brobridge),
used unchanged. Broapp does not implement any of it and does not weaken any of
it. Brobridge's own [THREAT-MODEL.md](https://github.com/praveenvijayan/brobridge/blob/main/THREAT-MODEL.md)
is the authoritative document; this page says how a Broapp application sits
inside it.

![One loop of a Broapp application: the tab redeems a one-time token at the trust fence and gets a session cookie, fetches the single embedded document, calls a typed operation and gets its result; a request from another origin is refused at the fence with 403.](../diagrams/broapp-loop.svg)

Over one loop: the tab redeems the one-time launch token at the trust fence and
gets a session cookie; it fetches the single embedded document; it calls a typed
operation, which the fence admits and the host validates and runs. A request
from any other origin, including another port on `127.0.0.1`, meets the same
fence and is refused before routing.

**Loopback binding.** The host binds `127.0.0.1` on an ephemeral port. Broapp
does not forward Brobridge's `allowNonLoopback` option at all, so a Broapp
application cannot grow LAN exposure through a configuration change. There is a
test asserting the bound host is loopback.

**A one-time launch token.** The URL the host prints carries a token that is
valid once, for two minutes. Redeeming it sets an HMAC-signed session cookie and
redirects to `/` without the token, so the token-bearing URL leaves browser
history. A second use of the same token is refused. There is a test.

**A trust fence.** Every request is checked for a `Host` and `Origin` the host
recognises before anything else runs — before routing, before a body is read,
before an allocation proportional to the request. A page on another origin
cannot reach the bridge. There is a test with a foreign `Origin`.

**A session cookie.** `HttpOnly; SameSite=Strict; Path=/`. Without it, every
route answers `403`.

**A closed route table.** `/`, `/ws`, `/rpc`, and nothing else. No path reaches
the filesystem, so there is no traversal to defend against — an unrouted path is
a `404` that never touched a disk.

**Refusal of framing and other cross-document loads.** The fence allows only
`Sec-Fetch-Site: same-origin` or `none`. A page on another origin that puts the
application in an `<iframe>` sends `cross-site` (or `same-site`), so the request
is refused with a `403` and no frame is rendered. Browsers set `Sec-Fetch-Site`
themselves and a page cannot forge it. This — not a CSP directive — is what
stops the application being framed.

**Rate-limited authentication failures.** Twenty per minute per remote address.

## What Broapp adds

**A restrictive Content-Security-Policy.** Brobridge sets `Referrer-Policy`,
`Cache-Control: no-store` and `X-Content-Type-Options` but no CSP, and only lets
a host application supply a body — so Broapp puts the policy in a
`<meta http-equiv>` at the top of the generated document:

```
default-src 'none';
script-src 'sha256-…';
style-src  'sha256-…';      (or 'none' when the application ships no CSS)
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self' ws://127.0.0.1:*;
base-uri 'none'; form-action 'none'; object-src 'none'
```

`default-src 'none'` means a directive nobody thought about fails closed. The
inline script is pinned by **hash**, not permitted by `'unsafe-inline'`, and the
hash is computed from the exact bytes the browser will execute — there is a test
that recomputes it from the served document. `connect-src` names the one host
the bridge can bind rather than allowing a bare `ws:`, which would allow any
host on the network.

**What is deliberately not in it.** No `frame-ancestors`. It is one of three
directives — with `report-uri` and `sandbox` — that the CSP specification
requires user agents to **ignore** when a policy arrives in a `<meta>` element,
and a `<meta>` element is the only way a host application can express a policy
here, because Brobridge writes the response headers and offers no hook for
adding one. Declaring it would put an inert directive in the document and invite
a reader to count it as protection.

Framing is refused anyway, one layer down, and by something that does work: see
below.

**An off-origin build check.** `broapp build` fails if the produced document
loads anything from another origin — a `src`, an `href`, a CSS `url()`, an
`@import`. A local application that pulls a font from a CDN stops working
offline and tells a third party when the user runs it. (A URL that is only a
*string* in JavaScript is allowed: React embeds documentation URLs in its error
messages, and a string fetches nothing. The CSP is what enforces this at
runtime; the build check is so the failure happens where a developer can see
it.)

**Host-side validation of every operation.** Input is checked against the
contract before a handler runs. The browser checks too, but only as a
convenience — a test bypasses the client entirely and proves the host still
refuses.

**A public/internal error boundary.** A `PublicError` a handler raises
deliberately keeps its message. Anything else is logged on the host with its
stack and reaches the browser as a fixed sentence. There is a test that throws
an error containing a filesystem path and a credential-shaped string and asserts
neither reaches the browser.

**Launch credentials stay out of files.** The launch URL is written to the
terminal, deliberately, because a user whose browser did not open needs it.
Nothing in Broapp writes it to a log file, and Brobridge's `no-referrer` and
`no-store` headers keep the browser from persisting it.

## What this does not protect against

Say this plainly to your users, because it is easy to assume otherwise.

**Loopback HTTP is not encryption.** Traffic does not leave the machine, but it
is not TLS. Anything with permission to inspect local network traffic on the
machine can read it.

**Authentication is not a sandbox.** The host process runs with the invoking
user's permissions and can do anything that user can do. The session cookie
decides *who may call your operations*; it does not constrain what those
operations are allowed to do once called.

**A compromised frontend has your session.** Code running in the page can invoke
every operation the page can invoke. That is why the CSP is hash-pinned and why
the build refuses off-origin scripts — but it means the security of your
application is bounded by the security of the operations you expose. Do not
expose an operation you would be uncomfortable with arbitrary page code calling.

**Local malware is out of scope.** Another process running as the same user can
read the data directory, read the process's memory, and attach a debugger. No
local application defends against this, and one that claims to is lying.

**AI providers see what you send them.** The AI layer is off until a user
configures it, and a local provider keeps everything on the machine. A remote
one is given the message, the conversation history, the full text of every
document the application resolved for that turn, search snippets, the tool
descriptions, and each tool call's input and output — that is what generating an
answer requires. `<AiSettings/>` states this on screen, worded for the provider
chosen; an application must not hide the notice. Whether a provider counts as
local is decided by its address, so a loopback proxy that forwards elsewhere
would be reported as local.

**The API key is a file, not a vault.** It is written to
`<dataDir>/ai/secrets.json` with mode `0600` — the posture of
`~/.aws/credentials`, not of a keychain. That rules out another *user* on the
machine and a world-readable backup. It does not rule out another process
running as the same user, for the reason in the paragraph above. A user who
does not want the key on disk can turn "Remember key on this computer" off, and
it is held in memory for the life of the process instead. See
[the AI layer](ai.md).

**Neither Broapp nor Brobridge has been independently audited.** Brobridge's
threat model is written down and its invariants have tests. That is not the same
as an audit, and this project does not claim it is.

## Rules for operations you add

These are the ones that matter.

**Never expose a shell.** An operation that runs a command string turns a local
application into remote code execution the moment anything else goes wrong. No
amount of escaping fixes this; do not add the operation.

**Never expose unrestricted filesystem access.** An operation taking an
arbitrary path can read the user's SSH keys and browser profile. If your
application needs files, give the *host* an explicit root and let the browser
name files relative to it — see the
[file-processor example](../examples/file-processor/README.md), which enforces
containment on the resolved path so that `..`, absolute paths, and symlinks are
all caught by the same check.

**Validate at the boundary, then again for your own rules.** The contract
enforces types and bounds. It does not know that a title of only whitespace is
not a title, or that this identifier must belong to the current user.

**Keep paths and driver messages out of `PublicError`.** Its message is shown to
the browser verbatim. That is the point of it, and the reason to be careful.

**Bound everything.** Array lengths, string lengths, file sizes, listing counts.
The contract's schemas are where to do it.

**Do not retry a mutating operation automatically.** A call that was in flight
when the socket dropped may have run. Broapp does not retry it, and neither
should you without idempotency you can point at.

## Reporting a problem

Security issues in the transport, the trust fence, or the authentication flow
belong to [Brobridge](https://github.com/praveenvijayan/brobridge/security).
Issues in the generator, the build, the contract layer, or the lifecycle belong
here — open a private security advisory on this repository rather than a public
issue.
