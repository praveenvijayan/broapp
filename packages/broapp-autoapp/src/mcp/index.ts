/**
 * `broapp-autoapp/mcp` — the adapter that offers an application to an external
 * agent.
 *
 * Imported lazily by the launcher's `mcp` command: the MCP SDK is a large
 * dependency and `serve` has no use for it. Nothing in the browser bundle may
 * reach this, and a test asserts it.
 */
export { connectControl, LauncherNotRunning, readControlFile } from './client.ts';
export type { ControlClient, Described } from './client.ts';

export { createMcpServer, runMcp, toolNameOf } from './server.ts';
export type { RunMcpOptions } from './server.ts';
