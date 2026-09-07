/**
 * `broapp-autoapp/host` — the host-side runtime.
 *
 * Never import this from browser code. It reaches `node:fs`, and a bundler that
 * followed the import would fail loudly, which is the intended outcome.
 */
export { createViewsHost } from './views.ts';
export type { CreateViewsHostOptions, ViewsHost } from './views.ts';
