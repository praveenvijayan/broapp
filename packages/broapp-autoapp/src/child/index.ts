/**
 * `broapp-autoapp/child` — what a release's host bundle is, and how it is run.
 *
 * An application imports only the types from here: they describe the two
 * functions its `host.js` must export. The runtime that calls them lives beside
 * them and is reached by the launcher binary, never by an application.
 */
export { assertAppModule } from './module.ts';
export type { AppInstance, AppModule, AppStartContext } from './module.ts';
