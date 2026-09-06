/**
 * Turning an application's own operations into tools a model may call.
 *
 * The contract already says what each operation takes, what it returns and,
 * in its `summary`, what it is for — which is exactly what a tool definition
 * needs. Deriving tools from it means a model cannot be offered an operation
 * that does not exist, and a change to an operation's input reaches the tool
 * description without anybody remembering to update it.
 *
 * The lists here *select*; they no longer decide. What a call is allowed to do
 * is the route's own `effect`, and the gate reads it from the contract. The
 * list a route sits in has to agree with what it declares, and a route that
 * declares nothing takes the list's word for it — which is how an application
 * written before effects existed still says what it meant. Nothing is a tool
 * unless it is named here, so the default for an application's surface is
 * still that the model cannot reach it.
 */
import type { HostApp } from '../../host/app.ts';
import type { Effect } from '../../shared/contract.ts';
import type { AnyContract, OperationName } from '../../shared/contract.ts';
import type { JsonSchema } from '../../shared/schema.ts';

import { GUARDED, type GuardedTool } from './tool.ts';

/** Which operations a model may call, and how much ceremony each needs. */
export interface ContractToolAllowList<C extends AnyContract> {
  readonly read?: readonly OperationName<C>[];
  readonly confirm?: readonly OperationName<C>[];
}

/** What each list means about a route that does not declare an effect. */
const IMPLIED: Record<'read' | 'confirm', Effect> = { read: 'read', confirm: 'write' };

/** Build tools from operations the contract already describes. */
export function fromContract<C extends AnyContract>(
  contract: C,
  app: HostApp<C>,
  allow: ContractToolAllowList<C>,
): Record<string, GuardedTool> {
  const read = allow.read ?? [];
  const confirm = allow.confirm ?? [];

  const both = read.filter((route) => (confirm as readonly string[]).includes(route));
  if (both.length > 0) {
    throw new TypeError(
      `operation ${JSON.stringify(both[0])} is listed as both a read tool and a confirm tool`,
    );
  }

  const tools: Record<string, GuardedTool> = {};
  const groups: readonly (readonly [readonly OperationName<C>[], 'read' | 'confirm'])[] = [
    [read, 'read'],
    [confirm, 'confirm'],
  ];
  for (const [routes, list] of groups) {
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
      const declared = spec.effect;
      // A list that disagrees with the contract is a misunderstanding about
      // what an operation does, and the two readings differ in exactly the way
      // that matters: one asks the user and the other does not. Neither is
      // safe to guess at, so it is refused where a developer can see it.
      if (declared !== undefined && declared !== IMPLIED[list] && !(list === 'confirm' && declared === 'external')) {
        throw new TypeError(
          `operation ${JSON.stringify(route)} is listed as a ${list} tool but declares effect ${JSON.stringify(declared)}`,
        );
      }
      const effect: Effect = declared ?? IMPLIED[list];
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
        [GUARDED]: true,
        description: spec.summary,
        inputSchema: describe.call(spec.input),
        effect,
        // `invoke` validates the input, guards it and applies the same error
        // boundary a call from the browser gets, so a model's arguments are no
        // more trusted than a tab's. The hint is what the list decided, and it
        // only applies where the contract itself is silent.
        execute: (input, envelope) =>
          app.invoke(route, takesNothing ? undefined : input, { ...envelope, effectHint: effect }),
      };
    }
  }
  return tools;
}
