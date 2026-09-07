/**
 * An application's operations, offered to an external agent.
 *
 * This process is started by the MCP client, not by the launcher, so it reaches
 * the running application the long way round: over the launcher's loopback
 * control connection, which forwards to the child over IPC, which runs the call
 * through the application's own gate on channel `mcp`.
 *
 * Two things the adapter deliberately does not do. It does not offer
 * `external` operations at all — v1 has no story for an agent that can send
 * mail on somebody's behalf from another program, and refusing is better than
 * a hint. And it does not decide anything: the annotations it publishes are
 * *hints* to the client, as the specification says, and the enforcement is the
 * gate on the other end. A client that ignores every hint gets exactly the same
 * answers.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { ContractExport } from '../spec/types.ts';

import { connectControl, LauncherNotRunning, type ControlClient } from './client.ts';

/** What the server tells a client about itself. */
const INSTRUCTIONS = `These tools reach an application running on this computer.

Anything that changes data has to be approved by the person, in the
application's own browser tab. If no tab is open the call is refused rather
than queued — open the application from the launcher first
(\`broapp-autoapp serve\`) and leave its tab open while you work.

Operations that reach outside this machine are not offered here at all.`;

/** Options for {@link runMcp}. */
export interface RunMcpOptions {
  readonly appId: string;
  /** The launcher's `launcher.json`. */
  readonly controlPath: string;
  /** Defaults to stdio. A test passes an in-memory pair. */
  readonly transport?: Transport;
  /** Defaults to `connectControl(controlPath)`. A test passes a fake. */
  readonly control?: ControlClient;
  readonly stderr?: { write(text: string): void };
}

/**
 * An MCP tool name from a route.
 *
 * The specification does not forbid a dot, but several clients treat a tool
 * name as an identifier and refuse one, so the separator becomes an
 * underscore. The mapping is reversed on the way back rather than kept in a
 * table, because a table would be a second thing to keep in step.
 */
export function toolNameOf(route: string): string {
  return route.replace(/\./g, '_');
}

/** Build the server for one application, without connecting a transport. */
export async function createMcpServer(options: RunMcpOptions): Promise<{
  server: Server;
  control: ControlClient;
  /** The routes offered, for a test to assert on. */
  readonly routes: readonly string[];
}> {
  const control = options.control ?? (await connectControl(options.controlPath));
  const described = await control.describe(options.appId);

  const offered = offerable(described.contract);
  const server = new Server(
    { name: `broapp-autoapp:${options.appId}`, version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: offered.map(([route, spec]) => ({
      name: toolNameOf(route),
      description: spec.summary,
      inputSchema: spec.input as { type: 'object' },
      annotations: {
        title: route,
        // Hints, not permissions. The gate on the other end decides, and a
        // client that ignores these gets the same answers.
        readOnlyHint: spec.effect === 'read',
        destructiveHint: spec.effect === 'write',
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const wanted = offered.find(([route]) => toolNameOf(route) === request.params.name);
    if (wanted === undefined) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${request.params.name} is not a tool this application offers.` }],
      };
    }
    // The client's own name, as it gave it at the handshake. It ends up in the
    // question the person is asked and in the run record — so "who is asking"
    // is answered by the handshake rather than by the call.
    const client = server.getClientVersion()?.name ?? 'unknown';
    const result = await control.invoke({
      appId: options.appId,
      route: wanted[0],
      input: request.params.arguments ?? {},
      client,
    });

    if (!result.ok) {
      // A refusal is a result, not a transport failure: the agent should read
      // it and say something, and the person may have declined on purpose.
      return { isError: true, content: [{ type: 'text' as const, text: result.message }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.output, null, 2) }] };
  });

  return { server, control, routes: offered.map(([route]) => route) };
}

/** Run the server over stdio until the client disconnects. */
export async function runMcp(options: RunMcpOptions): Promise<number> {
  const stderr = options.stderr ?? { write: (text: string) => void process.stderr.write(text) };
  let built;
  try {
    built = await createMcpServer(options);
  } catch (cause) {
    if (cause instanceof LauncherNotRunning) {
      stderr.write(`${cause.message}\n`);
      return 1;
    }
    stderr.write(`${String(cause instanceof Error ? cause.message : cause)}\n`);
    return 1;
  }

  const transport = options.transport ?? new StdioServerTransport();
  await built.server.connect(transport);
  await new Promise<void>((resolve) => {
    built.server.onclose = resolve;
  });
  built.control.close();
  return 0;
}

/**
 * The operations an external agent may be offered.
 *
 * `external` is left out on purpose, and the server's instructions say so: an
 * operation that reaches outside this machine, invoked from another program on
 * somebody's behalf, is not something v1 has a good answer for.
 */
function offerable(contract: ContractExport): readonly [string, ContractExport['operations'][string]][] {
  return Object.entries(contract.operations).filter(([, spec]) => spec.effect !== 'external');
}
