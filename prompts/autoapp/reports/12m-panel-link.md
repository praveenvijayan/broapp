# 12m — A way back to the panel: report

## Step 0 — Brobridge

Done on 2026-09-13 in `/Users/pv/works/brobridge/code`, branch
`feat/mint-launch-tokens` off `origin/main` (6098179, the 0.2.1 release),
commit `6cce47f` "feat(server): let a bridge mint more than one launch address".
Pushed as praveenvijayan/brobridge#3, CI green on Node 20/22/24 and Bun,
squash-merged as `aab4232`; the Version Packages PR #4 merged as `3f26627`, and
the Release workflow published `brobridge`, `@brobridgejs/core`, `client` and
`adapters` 0.2.2 on 2026-09-13.

### What changed

- `packages/server/src/auth.ts`: `AuthGuard` holds a list of live launch tokens,
  oldest first, each `{ bytes, issuedAt }`. `mintLaunchToken()` adds one
  (32 CSPRNG bytes, base64url, its own `issuedAt`); past
  `MAX_LIVE_LAUNCH_TOKENS = 8` the oldest is zeroed and dropped.
  `redeemToken` compares the presentation against every live token with
  `timingSafeEqual` (no early exit), burns exactly the match, and on the same
  call drops every expired token. A matched but expired token answers `expired`
  and is burnt, as before. With no live token the decoy compare runs and the
  answer is `spent`, as before. `launchToken` still names the token minted at
  start; `tokenSpent` says whether that one has left the live set (burnt,
  expired or dropped). `clear()` zeroes every token and makes a later
  `mintLaunchToken()` throw.
- `packages/server/src/index.ts`: `Bridge.launchUrl(): string` returns
  `${origin}/?bt=${auth.mintLaunchToken()}`; `url` is unchanged.
  `MAX_LIVE_LAUNCH_TOKENS` is exported.
- Tests: `auth.test.ts` gains "more than one launch token" (distinct tokens
  each redeem once and independently; per-token TTL; expired tokens swept on
  the next redeem; the ninth token drops the first, which then fails `spent`;
  cleared guard refuses to mint). `launchToken`/`tokenSpent` meaning is covered
  by the same cases and by the unchanged original tests. `integration.test.ts`
  gains one socket-level case: `launchUrl()` answers 303 with a cookie once and
  403 after, other addresses and `url` stay usable, `url` does not change. The
  existing "works exactly once", expiry and constant-time structural tests are
  unchanged and pass.
- `.changeset/mint-launch-tokens.md` (`brobridge: patch`), the `SECURITY.md`
  paragraph "Launch addresses" with the sentence the prompt fixes, and a bullet
  in `THREAT-MODEL.md` §5.6.

### Verification

`pnpm build`, `pnpm typecheck`: clean. `pnpm test`: 24 files, 327 tests passed
(was 322). `packages/server` `pnpm test:bun`: 5 passed. `pnpm publint`: clean.
`pnpm size`: 12 265 bytes, unchanged by this (the client is not touched).

### Resolved before publishing

The local checkout was on `fix/port-scoped-session-cookie` (e986f7f, pushed,
no PR, not on `main`). That branch carries a changeset marked **`minor`**
("Name the session cookie for the port"). If it is merged before this release,
changesets will version `brobridge` **0.3.0**, not 0.2.2, and broapp's planned
`^0.2.2` range would not accept it. Step 0 was therefore built off `main` so
that releasing it alone gives 0.2.2 as the prompt fixes. It was released on its
own; the cookie branch is still unmerged and its `minor` changeset will version
the next release 0.3.0.

### Publishing note

For a few minutes after the workflow finished, npm's `latest` for
`@brobridgejs/core` still read 0.2.1 and `bun install` refused
`@brobridgejs/core@^0.2.2`; Bun's cached manifest kept refusing after npm had
caught up, and `bun install --no-cache` resolved it.

## Steps 1 to 5

Built in the same session as Step 0, against a local Brobridge build copied
into `node_modules` while the release was pending. Final verification ran after
`bun install` picked up the published 0.2.2 (see "Verification").

### Two departures from the fixed decisions, both agreed in session

1. **The mark does not navigate the tab; the launcher opens the panel.** The
   prompt fixed `window.location.assign(url)` in the same tab. Brobridge's fence
   admits a document request only with `Sec-Fetch-Site: same-origin` or `none`
   (`packages/server/src/trust.ts`), and two loopback ports are the same site,
   so a navigation from `127.0.0.1:<app>` to `127.0.0.1:<panel>` arrives
   `same-site` and is refused with 403 — the reason `launcher/app.ts` already
   opens applications through the operating system's opener. The prompt's
   tests would have passed anyway, because `fetch` sends no `Sec-Fetch-Site`.
   The person chose the OS opener over loosening the fence. So:
   `autoapp.panel` answers `{ available: boolean, opened: boolean | null }`
   (not `url`); the IPC `answer` carries `available`, `opened` and `reason`,
   never an address; the supervisor's source is
   `panel: () => { available: true, open(): Promise<{ opened }> } | { available: false }`,
   and `main.ts` implements `open` as `RunningApp.launchUrl()` handed to the
   opener, printing the address to the launcher's terminal when no browser
   opens. The address never reaches the application's page. "Opening the panel
   in a new tab" was out of scope; the browser now decides tab or window.
2. **`autoapp.panel` is folded into the application's `autoapp` group.**
   Applications built on Autoapp's host already expose the `autoapp` service,
   and Brobridge throws on a second `expose` of the same name. The child hands
   the application a bridge wrapper (`child/panel.ts`, `withPanel`) that adds
   `panel` to that group when it is exposed, and exposes it alone when the
   application never does; an application that declares `autoapp.panel`
   itself fails to start. The renderer calls the route on `client.bridge`,
   because the Broapp client refuses a route its contract does not name.

One addition: under `NODE_ENV=test`, `AUTOAPP_TEST_NO_BROWSER=1` makes the
compiled launcher's opener report failure (beside `AUTOAPP_TEST_NO_NETWORK`),
so the new tests and the smoke read addresses from its terminal instead of
opening browser windows.

### What changed

- Core: `RunningApp.launchUrl()`; `brobridge` `^0.2.2` in `packages/broapp`
  and the root.
- IPC: `ask { what: 'panel', mint }` and `answer`; `IPC_TIMEOUT_MS = 5000`;
  the codec validates both.
- Child: `child/panel.ts` (`createPanelRoute`, `withPanel`), wired in
  `run-child.ts` through the application's own gate, answered by id, timing out
  `unavailable`. Off channel `user` the handler throws `rejected` before asking
  anything.
- Supervisor: `panel` option and `setPanel`; an `ask` is answered from the IPC
  callback, not queued; `NO_PANEL_REASON` is the `serve` sentence.
- Renderer: `Page.tsx` probes once per page load and draws an
  `autoapp-page__panel` button beside the title only on `available: true`; a
  failed click shows the route's message as `autoapp-message--error`. Tokens
  used: `--autoapp-text-muted`, `--autoapp-text`, and the existing
  `--autoapp-space-6` and `--autoapp-font-size-small`; none new.
- Control: `panel` request, one answer per two seconds, one `log` event per
  issued address; `ControlClient.panel()`.
- `main.ts`: `open`, the bare command and `serve` with no application ask a
  running launcher first (before opening the journal or knowledge), with a
  five-second deadline, removing a `launcher.json` nobody answers;
  `--no-restore`; the panel source is set once the tab runs and cleared on
  shutdown.
- Restart survival: `launcher/serving.ts`; `recover.ts` `restoreServing`
  (awaited before the tab starts, so a first click cannot race it into a second
  child over one data directory); `appOpen` adds, `appStop` and
  `removeApplication` remove; `serve` adds on first start and removes when it
  exits 0. The prompt named `keepalive.ts` for `serve`; it lives in `serve()`
  in `main.ts`, where the other `onStart` work already is.
- Docs: `security.md` ("Opening a tab", "The control connection", "MCP"),
  `design.md` "Between an application and the panel", the package README, the
  backlog's "Multiple launcher instances".
- Tests: `tests/autoapp-panel-link.test.ts` (7 cases, below);
  `tests/autoapp-mcp.test.ts`'s fake `ControlClient` gains `panel`; the smoke
  gains "panel link".

### The new tests, against the prompt's list

1. A served child's probe answers `available: true`; a mint opens an address on
   the stand-in panel tab's origin that answers 303 with a session cookie once
   and 403 after. (Brobridge's bootstrap answers 303, not 200.) The address is
   caught from a stubbed opener, since it is never returned.
2. `ai`, `mcp` and `workflow` envelopes are `rejected`, the launcher is never
   asked, and the gate records each as `failed` on `autoapp.panel`; `user` is
   answered.
3. A supervisor with no panel: probe `available: false`, a click fails with
   the `serve` sentence.
4. Two mints, two addresses, each usable once, in either order.
5. `open --no-open` against a running compiled launcher prints a panel address
   and exits 0; `launcher.json` is unchanged; the address loads once; a second
   `open` within two seconds exits 1 with `unavailable`.
6. `appOpen` adds, `appStop` removes, `removeApplication` removes; a compiled
   launcher over a file listing `items` and `ghost` prints `restored: items`,
   logs and drops `ghost`, serves `items` (over the control connection) and
   opens no browser; the file survives SIGTERM; `--no-restore` serves nothing.
7. Smoke: open `items` from the compiled panel, ask its child for the panel,
   load the address once.

### Asked for in the report

- **Live tokens after a day's use:** not measured. Nothing on this machine has
  run the new launcher for a day, and the guard exposes no count. By
  construction the panel's guard holds one token per click or `open` not yet
  redeemed and not older than the TTL (two minutes for the panel), capped at
  eight; a person who clicks the mark and lands on the panel leaves zero.
- **Bytes the mark adds to the renderer's stylesheet:** 525 bytes of source in
  `view.css` (two rules and a hover rule).
- **Did restart survival surprise the existing tests:** no. The full suite
  passed with no change to an existing assertion; the only existing file that
  changed is `tests/autoapp-mcp.test.ts`, whose fake control client had to
  implement the new `panel` method. No existing test starts `open` over a root
  with `serving.json`, and `serve` removes its own entry on a clean exit.

### Verification

Against the published 0.2.2, after `bun install`:

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun test tests/autoapp-panel-link.test.ts` | 7 pass |
| `bun test tests/autoapp-activation.test.ts tests/autoapp-remove.test.ts` | exit 0 |
| `bun test tests` | 807 pass, 0 fail |
| `bun run --cwd packages/broapp-autoapp build:launcher` | exit 0 |
| `bun run scripts/autoapp-smoke.ts` | every step, "panel link" and "outside" included |
| `bun run dryrun` | exit 0 |
| `bun run dryrun:autoapp` | exit 0 |
| `bun run check` | exit 0 |

`tests/ai-chat.test.ts` is unchanged.

Two things the first pass after the publish found. The prompt fixed only the
`brobridge` range, but `tests` holds every installed Brobridge package to one
version, so `@brobridgejs/core` and `@brobridgejs/client` moved to `^0.2.2`
beside it in `packages/broapp/package.json` and the root. And the dry runs'
fresh installs read Bun's cached npm manifests from before the publish and
refused `^0.2.2`; removing the four cached Brobridge manifests from
`~/.bun/install/cache` fixed it. Neither is a code change.

### Release

Not done in this session. The prompt's plan: `broapp` 0.4.3, `broapp-autoapp`
0.3.11 on `broapp ^0.4.3`, root 0.4.12, with the notes naming restart survival
as the one change in behaviour.
