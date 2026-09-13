/**
 * The way back to the panel, from inside an application.
 *
 * Every tab is its own bridge with its own one-time address, so a person who
 * closed the panel's tab had no way back to it but stopping the launcher. This
 * is the route an application's page calls to get there: `autoapp.panel`,
 * mounted by the child runtime beside the application's own routes, answered
 * by asking the launcher over IPC.
 *
 * Two things about it are deliberate. It answers only channel `user`: an MCP
 * client or a workflow asking for the panel is asking for a credential, and a
 * gate question would not make that right. And no address comes back: the
 * launcher mints one and gives it to the operating system's browser opener,
 * because a page on this port navigating to the panel's port arrives
 * `Sec-Fetch-Site: same-site`, which the panel's bridge refuses.
 */
import { createReservedHostApp, publicError } from 'broapp/host';
import type { Gate, HostApp, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import { IPC_VERSION, type Answer, type Ask } from '../ipc/messages.ts';
import { panelContract, type PanelContract } from '../shared/contract.ts';

/** What the route needs from the child runtime. */
export interface PanelRouteOptions {
  readonly gate: Gate;
  readonly logger: HostLogger;
  /** Send an `ask` to the launcher and wait for its `answer`. */
  ask(message: Ask): Promise<Answer>;
}

/** Said when the launcher did not answer in time. */
const NO_ANSWER = 'The launcher did not answer. Is it still running?';

/** Build the `autoapp.panel` host app. */
export function createPanelRoute(options: PanelRouteOptions): HostApp<PanelContract> {
  const host = createReservedHostApp<PanelContract>(panelContract, {
    gate: options.gate,
    logger: options.logger,
  });
  let counter = 0;

  host.operation('autoapp.panel', async ({ mint }, context) => {
    if (context.channel !== 'user') {
      throw publicError.rejected('The panel opens only from a person’s click in the application’s tab.');
    }
    counter += 1;
    let answer: Answer;
    try {
      answer = await options.ask({ v: IPC_VERSION, id: `p${String(counter)}`, type: 'ask', what: 'panel', mint });
    } catch {
      throw publicError.unavailable(NO_ANSWER);
    }
    if (!answer.ok) throw publicError.unavailable(answer.reason ?? NO_ANSWER);
    if (answer.available !== true) {
      // The probe hears "no" quietly; the click hears why.
      if (!mint) return { available: false, opened: null };
      throw publicError.unavailable(answer.reason ?? NO_ANSWER);
    }
    return { available: true, opened: mint ? answer.opened === true : null };
  });

  return host;
}

/**
 * A bridge that folds `autoapp.panel` into whatever `autoapp` group the
 * application exposes.
 *
 * Brobridge exposes one service object per group and refuses a second under
 * the same name, and an application built on Autoapp's host already exposes
 * `autoapp`. So the application registers through this wrapper, which adds
 * `panel` to that group when it arrives; `finish` exposes the group on its own
 * when the application never did.
 */
export function withPanel(
  bridge: Bridge,
  route: HostApp<PanelContract>,
): { bridge: Bridge; finish(): void } {
  const captured: Record<string, unknown> = {};
  route.mount({
    expose: (name: string, service: Record<string, unknown>) => {
      if (name === 'autoapp') Object.assign(captured, service);
    },
    stream: () => undefined,
  } as unknown as Bridge);

  let merged = false;
  const wrapped = Object.create(bridge) as Bridge;
  wrapped.expose = (name, service) => {
    if (name !== 'autoapp') {
      bridge.expose(name, service);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(service, 'panel')) {
      throw new TypeError('the application declares autoapp.panel, which the launcher owns');
    }
    merged = true;
    bridge.expose(name, { ...service, ...captured });
  };
  wrapped.stream = (name, handler) => bridge.stream(name, handler);

  return {
    bridge: wrapped,
    finish() {
      if (!merged) bridge.expose('autoapp', captured);
    },
  };
}
