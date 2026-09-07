/**
 * What a release's host bundle has to export.
 *
 * The child runtime is generic: it knows how to be supervised, how to build a
 * gate, and how to serve a page, but nothing at all about what the application
 * *is*. Everything specific arrives through these two functions, which is what
 * lets one compiled launcher run any release of any application.
 *
 * `start` and `migrate` are separate on purpose. Migrating a copy of somebody's
 * data during an activation must not also start serving it: a candidate that
 * opened a bridge on `data-next` would be reachable, and reachable is exactly
 * what a half-migrated copy must not be.
 */
import type { Bridge } from 'brobridge';
import type { Envelope, Gate, PendingApprovals } from 'broapp/host';

/** What the child hands an application when it starts it. */
export interface AppStartContext {
  readonly dataDir: string;
  readonly mode: 'live' | 'preview';
  /** The one gate every call passes. Applications build their host app with it. */
  readonly gate: Gate;
  /**
   * Where a question waits for a person, shared by every channel that has to
   * ask: the workflow runner inside the application, and the MCP calls the
   * child runtime forwards from outside it.
   *
   * One table, because there is one approvals strip in the tab. An application
   * that builds its own would have questions arriving somewhere nobody is
   * looking. Absent when the application is running standalone, where the AI
   * layer has its own and nothing else asks.
   */
  readonly approvals?: PendingApprovals;
  readonly logger: { warn(m: string): void; error(m: string): void };
}

/** A started application, as the child runtime holds it. */
export interface AppInstance {
  register(bridge: Bridge): void | Promise<void>;
  isBusy(): boolean;
  shutdown(reason: string): void | Promise<void>;
  /** The database schema version the opened data is at. */
  readonly schemaVersion: number;
  /**
   * Run one operation from outside the browser, through the gate.
   *
   * This is the application's own `HostApp.invoke`, handed over so the child
   * runtime can forward an MCP call into it. The envelope is built by the child,
   * not by whatever asked — which is what stops an external agent from claiming
   * to be the person at the keyboard.
   */
  invoke(route: string, input: unknown, envelope: Envelope): Promise<unknown>;
}

/** The two functions a release's `host.js` exports. */
export interface AppModule {
  /** Open data, run migrations, prepare handlers. Throws when the data cannot be opened. */
  start(context: AppStartContext): Promise<AppInstance>;
  /** Migrate the databases in `dataDir` forward and report. Must not start serving. */
  migrate(context: {
    dataDir: string;
    logger: AppStartContext['logger'];
  }): Promise<{ from: number; to: number }>;
}

/**
 * Check a dynamically imported module before anything is done with it.
 *
 * The import came from a release directory, which is data on disk rather than
 * something the compiler saw. A missing export would otherwise surface as
 * `mod.start is not a function` several frames later, at which point it is not
 * obvious that the release is the thing that is wrong.
 */
export function assertAppModule(mod: unknown): AppModule {
  if (typeof mod !== 'object' || mod === null) {
    throw new TypeError('the release host bundle did not evaluate to a module');
  }
  const candidate = mod as Partial<AppModule>;
  for (const name of ['start', 'migrate'] as const) {
    if (typeof candidate[name] !== 'function') {
      throw new TypeError(`the release host bundle does not export ${name}()`);
    }
  }
  return candidate as AppModule;
}
