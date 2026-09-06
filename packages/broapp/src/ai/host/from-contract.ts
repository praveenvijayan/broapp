/**
 * Turning an application's own operations into tools a model may call.
 *
 * The contract already says what each operation takes, what it returns and,
 * in its `summary`, what it is for — which is exactly what a tool definition
 * needs. Deriving tools from it means a model cannot be offered an operation
 * that does not exist, and a change to an operation's input reaches the tool
 * description without anybody remembering to update it.
 *
 * The permission split is the important part. `read` operations run as soon as
 * the model asks; `confirm` operations wait for the user. Nothing is a tool
 * unless it is named here, so the default for an application's surface is that
 * the model cannot reach it.
 */
import type { HostApp } from '../../host/app.ts';
import type { AnyContract, OperationName } from '../../shared/contract.ts';
import type { JsonSchema } from '../../shared/schema.ts';
import type { ToolPermission } from '../shared/types.ts';

import type { AiTool } from './tool.ts';

/** Which operations a model may call, and how much ceremony each needs. */
export interface ContractToolAllowList<C extends AnyContract> {
  readonly read?: readonly OperationName<C>[];
  readonly confirm?: readonly OperationName<C>[];
}

/** Build tools from operations the contract already describes. */
export function fromContract<C extends AnyContract>(
  contract: C,
  app: HostApp<C>,
  allow: ContractToolAllowList<C>,
): Record<string, AiTool> {
  const read = allow.read ?? [];
  const confirm = allow.confirm ?? [];

  const both = read.filter((route) => (confirm as readonly string[]).includes(route));
  if (both.length > 0) {
    throw new TypeError(
      `operation ${JSON.stringify(both[0])} is listed as both a read tool and a confirm tool`,
    );
  }

  const tools: Record<string, AiTool> = {};
  const groups: readonly (readonly [readonly OperationName<C>[], ToolPermission])[] = [
    [read, 'read'],
    [confirm, 'confirm'],
  ];
  for (const [routes, permission] of groups) {
    for (const route of routes) {
      const spec = contract.operations[route];
      if (spec === undefined) {
        throw new TypeError(`operation ${JSON.stringify(route)} is not declared in the contract`);
      }
      if (spec.summary === undefined || spec.summary === '') {
        // Without a summary the model is told a name and nothing else, and it
        // will guess. Better to refuse at startup than to guess in production.
        throw new TypeError(
          `operation ${JSON.stringify(route)} needs a summary before it can be offered to a model`,
        );
      }
      const describe = (spec.input as { toJsonSchema?: () => JsonSchema }).toJsonSchema;
      if (typeof describe !== 'function') {
        throw new TypeError(
          `operation ${JSON.stringify(route)} uses a validator with no toJsonSchema(); pass a hand-written tool for it instead`,
        );
      }
      // An operation taking `s.void()` is described to the model as an object
      // with no properties, because that is what a tool's arguments have to
      // be. The model then sends `{}`, which `s.void()` refuses. Nothing is
      // lost by turning it back into "no argument" here.
      const takesNothing = spec.input.kind === 'void';
      tools[route] = {
        description: spec.summary,
        inputSchema: describe.call(spec.input),
        permission,
        // `invoke` validates the input and applies the same error boundary a
        // call from the browser gets, so a model's arguments are no more
        // trusted than a tab's.
        execute: (input) => app.invoke(route, takesNothing ? undefined : input),
      };
    }
  }
  return tools;
}
