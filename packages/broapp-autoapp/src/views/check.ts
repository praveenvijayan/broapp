/**
 * Checking a view specification against the contract it draws.
 *
 * `parseViews` says the specification is internally consistent. This says it
 * agrees with the application it belongs to — and that is a separate question,
 * because the two are edited separately and a release is the moment they have
 * to be true together. A table whose source is a route that no longer exists is
 * a screen that fails on open; a delete button with no confirmation text is a
 * screen that deletes something on the first mis-click.
 *
 * It returns problems rather than throwing, because a builder wants all of them
 * at once and an engineer wants to be told everything it got wrong in one pass.
 */
import type { ContractExport, ExportedRoute } from '../spec/types.ts';

import type { Action, Component, ViewsSpec } from './types.ts';
import { walkComponents } from './validate.ts';

/** One action, and whether reaching it takes more than a single click. */
interface Reachable {
  readonly action: Action;
  /**
   * True when the action is a form's submit.
   *
   * A form is already a deliberate act: a person filled it in and pressed the
   * button on it. A bare button or a row action is one click from a list, which
   * is a different risk and gets a different rule.
   */
  readonly deliberate: boolean;
}

/** Every action reachable from one component. */
function actionsOf(member: Component): readonly Reachable[] {
  return [
    ...(member.action === undefined ? [] : [{ action: member.action, deliberate: false }]),
    ...(member.submit === undefined ? [] : [{ action: member.submit, deliberate: true }]),
    ...(member.rowActions ?? []).map((action) => ({ action, deliberate: false })),
  ];
}

/** The top-level property names an operation's input accepts, or `null` when it says nothing. */
function inputProperties(route: ExportedRoute): ReadonlySet<string> | null {
  const properties = route.input['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null;
  return new Set(Object.keys(properties as Record<string, unknown>));
}

/**
 * Compare a view specification with a contract.
 *
 * An empty result means the two agree. Anything else is a sentence naming what
 * is wrong, ready to show a person or hand back to an engineer.
 */
export function checkViewsAgainstContract(
  views: ViewsSpec,
  contract: ContractExport,
): readonly string[] {
  const problems: string[] = [];

  for (const screen of views.pages) {
    for (const loaded of screen.sources ?? []) {
      const route = contract.operations[loaded.operation];
      if (route === undefined) {
        problems.push(
          `page "${screen.id}": source "${loaded.id}" reads ${JSON.stringify(loaded.operation)}, which is not an operation in this contract`,
        );
        continue;
      }
      // A source runs when a page opens, without anybody asking for it. Only a
      // route that changes nothing may do that — otherwise navigating would be
      // a mutation, and the person would never have been asked.
      if (route.effect !== 'read') {
        problems.push(
          `page "${screen.id}": source "${loaded.id}" reads ${JSON.stringify(loaded.operation)}, whose effect is ${route.effect}; a source must be read`,
        );
      }
    }

    walkComponents(screen.children, [], (member) => {
      for (const { action: performed, deliberate } of actionsOf(member)) {
        const route = contract.operations[performed.operation];
        if (route === undefined) {
          problems.push(
            `component "${member.id}": action "${performed.id}" calls ${JSON.stringify(performed.operation)}, which is not an operation in this contract`,
          );
          continue;
        }
        if (route.effect !== 'read' && !deliberate && performed.confirmText === undefined) {
          problems.push(
            `component "${member.id}": action "${performed.id}" calls ${JSON.stringify(performed.operation)}, whose effect is ${route.effect}, so it needs confirmText`,
          );
        }
        const allowed = inputProperties(route);
        if (allowed === null) continue;
        for (const key of Object.keys(performed.input ?? {})) {
          if (!allowed.has(key)) {
            problems.push(
              `component "${member.id}": action "${performed.id}" passes ${JSON.stringify(key)}, which ${JSON.stringify(performed.operation)} does not accept`,
            );
          }
        }
      }
    });
  }

  return problems;
}
