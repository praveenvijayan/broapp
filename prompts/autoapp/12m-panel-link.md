# 12m — A way back to the panel

## Goal

The panel opens an application; nothing opens the panel from an application.
Every tab is its own Brobridge with one launch token, burnt on first load and
never minted again, so a person who closes the panel's tab has no way back but
Ctrl+C, and Ctrl+C stops their applications. On 2026-09-13 a person closed the
panel while their application ran on `127.0.0.1:65470`, tried the launcher's
ports by hand, got a 403, and restarted.

After this prompt: a small **Autoapp** mark in every launcher-served
application's page takes the person to the panel, minting a fresh one-time
address at the click; `broapp-autoapp open` against a running launcher hands out
a fresh panel address instead of starting a second launcher; and applications
that were serving come back when the launcher starts again. Each address is
still single-use, still loopback, and still minted only on a person's action or
for a local process that holds the control secret.

This prompt has a stop in it. Step 0 changes Brobridge, in its own repository,
and ends with a report; the person publishes `brobridge` 0.2.2; Steps 1 to 5 run
in a **new session** once npm has it.

## Read first

- `prompts/autoapp/00-common-rules.md` and every report so far; 02 for the
  supervision chain, 08 for MCP and the control connection, 12i for `remove`
  asking the launcher over that connection.
- Brobridge, at `/Users/pv/works/brobridge/code` (pnpm, vitest):
  `packages/server/src/auth.ts` (`AuthGuard`: `launchToken`, `tokenSpent`,
  `redeemToken`, `#tokenBytes`, `#tokenIssuedAt`), `packages/server/src/index.ts`
  (`url:` at line ~145, the `Bridge` object), `packages/server/tests/auth.test.ts`,
  `SECURITY.md`, `PROTOCOL.md`, `.changeset/`.
- `packages/broapp/src/host/runtime.ts` (`RunningApp`, `startApp`),
  `packages/broapp/src/host/app.ts` (`createReservedHostApp`, the reserved groups),
  `packages/broapp/src/host/open-browser.ts`.
- `packages/broapp-autoapp/src/ipc/messages.ts` (every message kind),
  `child/run-child.ts` (`startApp` with `openBrowser: false`, `ready` with the
  URL), `launcher/supervisor.ts` (`ChildHandle`, the message handling),
  `launcher/control.ts` (the `serving` answer and its comment on launch URLs,
  `invoke`), `launcher/main.ts` (`openLauncher`, `serve`, `servedElsewhere`,
  `stopChildrenOnExit`), `launcher/recover.ts`, `launcher/keepalive.ts`,
  `launcher/app.ts` (`launcher.appOpen`, `launcher.appStop`).
- `packages/broapp-autoapp/src/react/Page.tsx` (`.autoapp-page`, the title),
  `react/context.tsx` (how the renderer calls the host), `react/tokens.css`.
- `docs/autoapp/security.md` ("The one door", "Opening a tab", "The control
  connection", "MCP"), `docs/autoapp/design.md`.
- `tests/autoapp-remove.test.ts` (spawning the compiled launcher and asking it),
  `tests/autoapp-activation.test.ts` (recover), `tests/autoapp-launcher.ts`.

## Fixed decisions for this prompt

| Decision | Value |
|---|---|
| Brobridge: many tokens, each once | `AuthGuard` keeps a small set of live launch tokens instead of one: `mintLaunchToken(): string` adds one (base64url, same bytes, its own `issuedAt`), `redeemToken` accepts any live one and burns exactly that one, every token has the guard's TTL, expired tokens are dropped on the next redeem, and at most **8** live tokens (minting a ninth drops the oldest). `launchToken` and `tokenSpent` keep their meaning for the first token, so nothing that reads them changes. The comparison stays constant-time per token; when no token is live the decoy compare runs as today. The `Bridge` gains `launchUrl(): string` returning `${origin}/?bt=<new token>`; `url` is unchanged. Version 0.2.2, a changeset, a `SECURITY.md` paragraph: "an address is single-use; a bridge may issue more than one, each minted by the host on its own decision, never on a request from the browser". |
| Core | `RunningApp` gains `launchUrl(): string` delegating to the bridge. `packages/broapp/package.json`: `brobridge` `^0.2.2`. Nothing else in core. |
| The child's route | The child mounts a reserved host app for the group `autoapp` beside the application, as `broapp/ai/host` mounts `ai`: one route `autoapp.panel`, effect `read`, input `{ mint: boolean }`, output `{ available: boolean, url: string \| null }`. `mint: false` is the renderer's probe at load: is there a panel to go to. `mint: true` asks the launcher over IPC and returns the fresh address. The handler refuses with `rejected` on any channel but `user`: an MCP client or a workflow asking for a panel address is asking for a credential, and the gate's ask would not make that right. |
| IPC | Two message kinds: child → launcher `ask { id, what: 'panel', mint: boolean }` and launcher → child `answer { id, ok: true, available, url } \| { id, ok: false, reason }`. The supervisor answers from a function the launcher gives it, `panel: () => { available: boolean; url(): string }`; absent, every ask is answered `available: false`. A child's ask is answered within `IPC_TIMEOUT_MS` or fails `unavailable` in the child. |
| Which launcher has a panel | `open` and the bare command: yes, the launcher's own tab's `RunningApp.launchUrl()`. `serve <appId>`: no panel is running; the mark is hidden (the probe says `available: false`) and the route says so in words: "This launcher was started for one application. Run `broapp-autoapp open` for the panel." Starting the panel on demand from `serve` is out of scope. |
| The mark | `Page.tsx` draws a link **Autoapp** in the page's top-right, class `autoapp-page__panel`, only when the probe at load answered `available: true`. Colour `--autoapp-text-muted`, hover `--autoapp-text`, no other new token. Click: `autoapp.panel { mint: true }`, then `window.location.assign(url)` in the same tab. A failed ask shows the route's message in the page's existing message area and leaves the tab where it is. No other application (plain Broapp, the Notes example) shows the mark: without the route the probe is never made. |
| `broapp-autoapp open` while a launcher runs | The control connection gains a `panel` request: `{ type: 'panel' }` → `{ ok: true, url }` or `{ ok: false, reason }`. `open` (and the bare command) first tries `launcher.json`: a launcher that answers is asked for a panel address, which is opened in the browser (or printed with `--no-open`), and the command exits 0 without starting anything. A `launcher.json` nobody answers is removed as today, and a launcher starts. The control comment on launch URLs changes to say why this request is different: the secret in `launcher.json` already reaches `invoke`, which reaches `launcher.appOpen`, so a process that has the secret can already have an application's address; a panel address on the same terms is not a new door. One `log` event per issued address: "a panel address was issued to a local process". Rate: one answer per two seconds, later asks refused with `unavailable`. |
| Restart survival | `<root>/launcher/serving.json`, written atomically: `{ v: 1, apps: ["<appId>", …] }`. `launcher.appOpen` and `serve` add the application; `launcher.appStop`, `remove`, and a clean exit of `serve` remove it. On `open` and the bare command, `recover` starts every listed application that is activated, on new ports, opens no browser, and the panel lists them serving. `--no-restore` skips it. A listed application that fails to start is logged and dropped from the file. Stopping the launcher does not clear the file: that is the point. |
| What does not change | Every application still gets one address per token, loopback only; the panel still opens an application by minting that application's token; the engineer has no tool that reaches any of this; the gate, the contract and the release loop are untouched. The one visible change to existing behaviour is restart survival, and the release notes say so. |
| Not in scope | Starting the panel from `serve`; a fixed port; the mark in applications not served by the launcher; opening the panel in a new tab; any change to the session cookie. |

## Step 0 — Brobridge (its own repository; stop after this step)

In `/Users/pv/works/brobridge/code`: the guard, the bridge method, tests in
`packages/server/tests/auth.test.ts`:

1. `mintLaunchToken` returns a distinct token; each of two tokens redeems once
   and once only; redeeming the first does not spend the second.
2. TTL is per token: a token minted late is still valid after the first expired.
3. A ninth token drops the oldest; the dropped one fails `spent`.
4. `launchToken` still names the first token and `tokenSpent` still says
   whether that one was burnt; `url` is unchanged.
5. With no live token the redeem path still takes the decoy compare (the
   existing timing test, unchanged).

`pnpm test`, `pnpm build`, a changeset (`patch`, "a bridge can mint more than
one single-use launch address"), the `SECURITY.md` paragraph. Report to
`prompts/autoapp/reports/12m-panel-link.md` (section "Step 0") in the broapp
repository, and **stop**. The person publishes `brobridge` 0.2.2. Steps 1 to 5
run in a new session once `npm view brobridge version` prints 0.2.2.

## Step 1 — core

`RunningApp.launchUrl`, the dependency range, `bun install`; `tests/ai-chat.test.ts`
unchanged.

## Step 2 — IPC, the child's route, the supervisor

`ipc/messages.ts`, `child/run-child.ts` (mount `autoapp.panel` through
`createReservedHostApp`; the ask over `process.send`, answered by id), `supervisor.ts`
(the `panel` function, the answer, the timeout). `main.ts` gives the supervisor
the panel function once the launcher's tab is running.

## Step 3 — the mark

`Page.tsx`, `view.css`, the probe at load, the click. The theme harness's pages
gain nothing: the mark is absent without the route, and the harness has no host.

## Step 4 — `open`, the control connection, restart survival

`control.ts` (`panel`), `main.ts` (`open` asks first; `--no-restore`), `recover.ts`
(start what `serving.json` lists), `app.ts` (`appOpen`/`appStop` maintain it),
`keepalive.ts` (`serve` adds and removes), `remove.ts` (removes).

## Step 5 — docs

`docs/autoapp/security.md`: "Opening a tab" says one token per address, minted
by the host on a person's click in an authenticated tab or for a local process
over the control connection, never on a browser's request; "The control
connection" gains the `panel` request and why it is on the same terms as
`invoke`; "MCP" says `autoapp.panel` is refused off channel `user`.
`docs/autoapp/design.md`: a short section "Between an application and the
panel". `packages/broapp-autoapp/README.md`: `open` against a running launcher,
`--no-restore`. `docs/autoapp/backlog.md`: "Multiple launcher instances" gains
that `open` now joins a running one instead of starting a second.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-panel-link.test.ts
bun test tests/autoapp-activation.test.ts tests/autoapp-remove.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run dryrun
bun run dryrun:autoapp
bun run check
```

New `tests/autoapp-panel-link.test.ts` (root under `tests/.autoapp-run/`, the
compiled launcher from `ensureLauncher`, children stopped in `afterEach`):

1. A launcher tab over the harness with one served child: `autoapp.panel
   { mint: false }` on the child's bridge, channel `user`, answers
   `available: true`; `{ mint: true }` answers a URL on the launcher tab's
   origin; fetching it once answers 200 and sets a session cookie; fetching it
   again answers 403.
2. The same on channel `ai` (a hand-built envelope) is `rejected`; the gate
   record says so.
3. A supervisor built without `panel` answers `available: false` and the child's
   route returns the `serve` sentence.
4. Two mints in a row give two different addresses, both usable once.
5. `broapp-autoapp open --no-open` while a launcher serves from the same root
   prints a fresh panel address and exits 0 without starting a second launcher
   (`launcher.json`'s pid is unchanged); the address loads once; a second `open`
   within two seconds is refused with `unavailable`.
6. `serving.json`: `launcher.appOpen` adds the id, `launcher.appStop` removes it,
   `remove` removes it; a launcher started over a root whose file lists an
   activated application starts it (a child exists for it, `serving: true` in
   `appsList`, no browser opened); `--no-restore` does not; a listed id with no
   activated release is dropped and logged.
7. The smoke gains: open an application from the panel, ask the child for the
   panel address, load it once.

## Acceptance criteria

- From any application the launcher serves, a person reaches the panel with one
  click, on a fresh single-use address; from the panel they reach the application
  as before.
- `broapp-autoapp open` never starts a second launcher over a root that has one.
- Applications that were serving are serving again after the launcher restarts,
  unless `--no-restore` was given.
- No address is ever minted on a browser's or an MCP client's request.
- `bun run check` is green; every command above exits 0; `tests/ai-chat.test.ts`
  is unchanged.

## Report

`prompts/autoapp/reports/12m-panel-link.md`: the Step 0 section from the first
session; then how many tokens the Brobridge guard holds live in practice on this
machine after a day's use (read from a launcher started with the new binary), the
byte size the mark adds to the renderer's stylesheet, and whether the restart
survival surprised anything in the existing tests.

## Commit

Step 0 commits in the Brobridge repository with its own message. Steps 1 to 5:

```
Give every application a way back to the panel

A launcher-served application draws an Autoapp mark that mints a fresh
single-use address for the panel at the click, over the child's own
authenticated session; broapp-autoapp open against a running launcher asks
it for a panel address instead of starting a second launcher; applications
that were serving come back when the launcher starts again. Brobridge 0.2.2
lets a bridge mint more than one launch address, each burnt on first use.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

Release after: `broapp` 0.4.3, `broapp-autoapp` 0.3.11 on `broapp ^0.4.3`,
root 0.4.12; the notes name restart survival as the one change in behaviour.
