# Upstream blockers

Facts recorded against real, inspected versions. Each entry says what breaks,
what Broapp does about it, what Broapp gets wrong about it, and what would let
Broapp drop the workaround.

Re-verified 2026-09-05 against the npm registry, the GitHub tags of
`praveenvijayan/brobridge`, the `brobridge` source, and Bun 1.4.0. No upstream
issue is filed for entries 2 and 3.

## 1. `brobridge@0.2.0` publishes an unresolved `workspace:` specifier

**Status:** resolved by `brobridge@0.2.1`, published 2026-09-05 through the
repository's changesets flow. Its manifest declares
`"@brobridgejs/core": "^0.2.1"`, and a fresh Bun 1.4.0 install of `^0.2.1` with
no override succeeds. Broapp's dependency floor is `^0.2.1` and the `overrides`
block is gone from the workspace, the examples, the template and the generator.
The record below is kept because the same mistake is one hand publish away.

`brobridge@0.2.0`'s published manifest declares:

```json
"dependencies": {
  "ws": "^8.21.3",
  "@brobridgejs/core": "workspace:^"
}
```

`workspace:^` is a monorepo-local protocol. It must be rewritten to a real
range before the tarball reaches npm, and for this package it was not. A package
manager reading it outside the Brobridge repository has no workspace to resolve
it against:

```
error: @brobridgejs/core@workspace:^ failed to resolve
```

Only `brobridge` is affected. `@brobridgejs/client@0.2.0` and
`@brobridgejs/adapters@0.2.0` declare the same `workspace:^` in their sources
and both published `^0.2.0` correctly, so the source manifests are not the
problem; the publish of this one package was.

**Root cause, established from the registry and the repository.**

The rewrite is the package manager's job, and the two managers behave
differently:

| Command | Result for `packages/server` |
| --- | --- |
| `npm pack` | emits a tarball with `"@brobridgejs/core": "workspace:^"` verbatim |
| `pnpm pack`, dependency not installed | exits 1, `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`, emits nothing |
| `pnpm pack`, after `pnpm install` | emits `"@brobridgejs/core": "^0.2.0"` |

pnpm never produces a broken tarball. npm passes the specifier straight
through. The registry metadata says which one ran:

| Package | Published (UTC) | `_npmVersion` | GitHub release tag |
| --- | --- | --- | --- |
| `@brobridgejs/core` | 14:13:48 | absent | yes |
| `@brobridgejs/client` | 14:13:51 | absent | yes |
| `@brobridgejs/adapters` | 14:13:51 | absent | yes |
| `brobridge` | 14:21:46 | `10.9.8` | **none** |

Three packages went out together through `changeset publish`, which for a pnpm
workspace runs `pnpm publish` (changesets 3.0.1 `getPublishTool`), and got their
release tags pushed. `brobridge` did not: it was published eight minutes later,
outside that run, with the npm CLI, from a machine whose Node version (22.23.1) differs
from the other three (22.23.2). It has no release tag.

The earlier version of this document blamed `publish-manual.yml`. That was
wrong: both `release.yml` and `publish-manual.yml` run `pnpm changeset publish`,
which uses pnpm and cannot emit this tarball. Whatever went wrong in the
changesets run for `brobridge` (the log is not available), the hand recovery is
what shipped the bad manifest.

The source needs no change. Republishing through pnpm with a completed install
produces a correct manifest as-is. Two upstream weaknesses let it happen, and are
worth an issue alongside the republish:

- `scripts/check-publish.mjs` runs `npm publish --dry-run` and its comment says
  npm "is the tool that will do the real publish". Neither is true for this
  repository, and a dry run lists tarball files, not the rewritten manifest, so
  it cannot catch this defect. A check that packs each package and refuses any
  `workspace:` string in the packed `package.json` would.
- There is no rule that a hand publish must go through pnpm. A `prepublishOnly`
  script that fails under `npm_config_user_agent` starting with `npm/` would
  make the mistake impossible to repeat.

**What Broapp did while 0.2.0 was the only release.** Every project, example
and generated application carried an `overrides` entry supplying the missing
range:

```json
"overrides": { "@brobridgejs/core": "0.2.0" }
```

Bun applied it to the transitive dependency and the install succeeded. Nothing
in Brobridge was patched, forked, or vendored.

That exact pin was itself a hazard, and is why the override was removed the
moment 0.2.1 existed rather than left in place. The four Brobridge packages are
versioned as one (`.changeset/config.json`, `fixed`) and the protocol core must
match the server and client. A project that bumped `brobridge` and
`@brobridgejs/client` to 0.2.1 while keeping the override would run a 0.2.1
server and client on a 0.2.0 core with no install error to say so. A project
generated before 2026-09-05 still carries the pin; `troubleshooting.md` says to
delete it.

**What the 0.2.1 release showed about the pipeline.** The Sep 1 CI run failed
on `brobridge` with `E403` because the repository's npm token covered the
`@brobridgejs` scope and not the unscoped package. The 0.2.1 run needed a
granular token covering both, with 2FA bypass enabled, before `pnpm publish`
would run non-interactively. npm restricts bypass tokens for publishing from
January 2027, so the durable fix upstream is trusted publishing (OIDC) on the
four packages. Separately, no 0.2.1 tarball carries a provenance attestation
although the workflow sets `NPM_CONFIG_PROVENANCE`; that is an open upstream
item.

## 2. Unary operations do not receive a session identifier

**Status:** open, low impact. Not a bug; a gap, and a small one to close.

`bridge.expose(name, service)` calls a service method with the JSON arguments
and nothing else. `bridge.stream(name, handler)` passes a `StreamContext`
carrying `sessionId`. So a stream handler knows which authenticated tab it is
serving and a unary handler does not.

The identifier is present at both places a unary call enters and is dropped
one line later:

- Over the WebSocket, `ServiceRegistry.handleStream(stream, sessionId)` has it
  and calls `this.invoke(stream.name, request)` without it
  (`packages/server/src/services.ts`).
- Over `POST /rpc`, the gateway returns `{ kind: 'rpc', authSessionId }` and
  the runtime calls `handleRpc(body, registry, maxFrameSize)` without it
  (`packages/server/src/rpc.ts`).

Every call has still passed the trust fence and the cookie check before a
handler runs, in that order (`gateway.ts`); the missing piece is only *which*
tab. Broapp's `CallContext` therefore carries the route name and no session id
rather than inventing one. That is the right call: a fabricated id would be
mistaken for an authenticated one.

**Workaround for an application that needs it:** use a stream, which does get
the context.

**How it goes away.** Upstream threads `sessionId` through `invoke` and hands
it to service methods without changing their argument list, for example as a
trailing context object or through a second registration form. Broapp then
adds `sessionId` to `CallContext` and nothing else changes.

## 3. Brobridge sets no `Content-Security-Policy`, and cannot be asked to

**Status:** by design upstream; handled by Broapp. The inert directive
described below has been removed — this is now purely an upstream ask.

Brobridge sets `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` on every response, and lets the host
application supply the body served at `/` but not extra headers
(`IndexDocument` has `body` and `contentType` only). There is therefore no way
to send a CSP header, `X-Frame-Options`, or any other header through
`createBridge`.

Broapp puts the policy in a `<meta http-equiv="Content-Security-Policy">` at
the top of the generated document, with the inline script and stylesheet
pinned by SHA-256 hash. See [security.md](security.md).

**What Broapp used to get wrong.** The policy included `frame-ancestors 'none'`,
and `tests/build.test.ts` asserted it was there. Browsers do not enforce
`frame-ancestors` delivered in a `<meta>` element; the CSP specification lists
it, with `report-uri` and `sandbox`, as header-only, and engines log a console
warning and ignore it. The directive is inert, the test enshrines an inert
directive, and [security.md](security.md) presents it as protection.

What actually stops framing today is Brobridge, not the policy. A frame from
any other origin, including another port on `127.0.0.1`, arrives with
`Sec-Fetch-Site: same-site` or `cross-site`, which the trust fence refuses
before routing (`trust.ts`, step 5). Only a same-origin document can frame the
application, and a same-origin document is the application. So there was no
exploitable gap, but the claim and the test were false.

**Fixed.** `frame-ancestors` is gone from the generated policy; a test now
asserts that no `<meta>`-inert directive (`frame-ancestors`, `report-uri`,
`sandbox`) appears in it; and [security.md](security.md) credits the fence for
anti-framing and states plainly why the directive is absent.

Two smaller points in the same policy, both also fixed:

- `connect-src` named `ws://localhost:*` and `ws://[::1]:*`. Brobridge binds
  `127.0.0.1` only, Broapp never forwards the `host` option, and the trust
  fence refuses any other `Host` — so those entries could never be used by the
  bridge client and only widened what page code was allowed to connect to. The
  policy is now `'self'` plus `ws://127.0.0.1:*`, which is the whole
  requirement.
- `style-src` carried a hash of the empty string when the bundle had no CSS.
  Harmless, but it read as though a stylesheet existed. It is now
  `style-src 'none'` in that case.

**The upstream ask, upgraded.** This was previously filed here as marginal — a
header being slightly stronger than a `<meta>` element. It is not marginal: a
response header is the *only* way to deliver an anti-framing directive at all,
so today a Broapp application has no CSP-level framing defence and depends
entirely on the trust fence for it. Defence in depth argues for both.

Either of two upstream changes, the first preferable:

- Brobridge adds `X-Frame-Options: DENY` (or a header CSP with
  `frame-ancestors 'none'`) to the `/` response itself. Framing a loopback
  bridge is never legitimate, so this needs no option.
- A `headers` field on `IndexDocument`, so a host application can send its
  policy as a real header. A header applies before any markup is parsed and is
  the only delivery that makes `frame-ancestors` effective.

Until one of these ships, the `<meta>` policy is correct for every directive it
can actually carry, carries nothing it cannot, and Broapp keeps it. Framing
remains refused by the fence in the meantime.
