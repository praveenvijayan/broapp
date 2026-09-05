/**
 * `broapp/host` — the host runtime.
 *
 * Never import this from browser code. It pulls in `node:fs`, `node:os` and
 * `Bun.spawn`, none of which exist in a browser, and a bundler that follows
 * the import would fail loudly — which is the intended outcome.
 */
export { createHostApp } from './app.ts';
export type {
  CallContext,
  HostApp,
  HostAppOptions,
  HostLogger,
  OperationHandler,
  StreamHandlerFor,
  StreamSink,
} from './app.ts';

export { startApp } from './runtime.ts';
export type { LifecycleMode, RunningApp, ShutdownReason, StartAppOptions } from './runtime.ts';

export { dataDir, ensureDataDir, DATA_DIR_ENV } from './paths.ts';
export { openBrowser } from './open-browser.ts';

export { PublicError, publicError } from '../shared/errors.ts';
