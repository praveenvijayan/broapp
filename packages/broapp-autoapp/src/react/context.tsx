/**
 * What a page hands its components.
 *
 * A component in a view specification names things by id — a source, a page, a
 * field — and the renderer has to turn those names into values, calls and
 * navigation. Rather than thread all of that through every component's props,
 * one context per page carries it.
 *
 * The interesting piece is `run`. Every action a person can take goes through
 * it: it resolves the bindings, asks for confirmation when the route changes
 * something, calls the operation, reloads whatever the action names, and
 * navigates. Having exactly one path for that is what makes "did this action
 * ask first?" a question with one answer.
 */
import * as React from 'react';

import { useBroappReady } from 'broapp/react';
import { BroappError } from 'broapp/shared';
import type { AnyContract, JsonSchema } from 'broapp/shared';

import type { Action, ViewsSpec } from '../views/types.ts';

import { coerceToSchema, resolveInput, resolveValue, type Scope } from './bind.ts';

/**
 * What the contract says about one operation.
 *
 * The effect decides whether a person is asked before it runs; the input schema
 * decides what types its arguments have to arrive as, since a URL parameter and
 * a text input are both strings whatever the route wants.
 */
export interface RouteInfo {
  readonly effect: string;
  readonly input: JsonSchema | null;
}

/** What one source is doing right now. */
export interface SourceState {
  readonly data: unknown;
  readonly error: string | null;
  readonly loading: boolean;
}

/** Everything a component on a page can reach. */
export interface PageContextValue {
  readonly views: ViewsSpec;
  readonly params: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, SourceState>>;
  /** What the contract says about each operation, so an action knows how to call it. */
  readonly routes: Readonly<Record<string, RouteInfo>>;
  /** Reload named sources, or every source when none is named. */
  reload(ids?: readonly string[]): void;
  /** Go to a page, with parameters in the order it declares them. */
  navigate(pageId: string, params?: readonly string[]): void;
  /** Ask the person. Replaceable so a test does not need a browser dialog. */
  confirm(message: string): boolean;
  /** Run one action. Resolves to an error message, or null on success. */
  run(action: Action, scope: Scope): Promise<string | null>;
}

const PageContext = React.createContext<PageContextValue | null>(null);

/** The page a component is on. */
export function usePage(): PageContextValue {
  const value = React.useContext(PageContext);
  if (value === null) throw new Error('this component must be rendered inside <AutoappView>');
  return value;
}

/** Props for {@link PageProvider}. */
export interface PageProviderProps {
  readonly value: PageContextValue;
  readonly children: React.ReactNode;
}

/** Put one page's context in front of its components. */
export function PageProvider({ value, children }: PageProviderProps): React.ReactElement {
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>;
}

/** Turn a hash into a page id and its positional parameters. */
export function parseHash(hash: string, views: ViewsSpec): { pageId: string; params: readonly string[] } {
  const trimmed = hash.replace(/^#\/?/, '');
  if (trimmed === '') return { pageId: views.home, params: [] };
  const segments = trimmed.split('/').filter((segment) => segment !== '');
  const [pageId = views.home, ...rest] = segments;
  return { pageId, params: rest.map((segment) => decodeURIComponent(segment)) };
}

/** Build the hash for a page and its parameters. */
export function buildHash(pageId: string, params: readonly string[] = []): string {
  const tail = params.map((value) => encodeURIComponent(value)).join('/');
  return tail === '' ? `#/${pageId}` : `#/${pageId}/${tail}`;
}

/**
 * The one place an action is carried out.
 *
 * `window.confirm` here is for the *person*, not for the policy. A click in the
 * browser reaches the host as channel `user`, which the gate allows without
 * asking anybody — precisely because the person is the one who clicked. The
 * dialog exists so that a destructive button is not a single mis-click, which
 * is a different problem from authorisation and needs a different answer.
 */
export function useRunAction(
  routes: Readonly<Record<string, RouteInfo>>,
  reload: (ids?: readonly string[]) => void,
  navigate: (pageId: string, params?: readonly string[]) => void,
  confirm: (message: string) => boolean,
): (action: Action, scope: Scope) => Promise<string | null> {
  const ready = useBroappReady<AnyContract>();
  return React.useCallback(
    async (action: Action, scope: Scope): Promise<string | null> => {
      const route = routes[action.operation];
      // An action that declares no input sends *nothing*, not an empty object.
      // A route taking `s.void()` refuses `{}`, so the two are not the same
      // thing — and the failure looks like a validation bug rather than a
      // missing binding, which is a bad hour to give somebody.
      let input: Record<string, unknown> | undefined;
      try {
        input =
          action.input === undefined
            ? undefined
            : coerceToSchema(resolveInput(action.input, scope), route?.input);
      } catch (cause) {
        // An unresolvable binding is an authoring mistake, not a user error,
        // and saying so plainly is more useful than a validation message from
        // the host about a field that was never sent.
        return cause instanceof Error ? cause.message : 'This action is not configured correctly.';
      }

      const effect = route?.effect ?? 'write';
      if (effect !== 'read' && action.confirmText !== undefined && !confirm(action.confirmText)) {
        return null;
      }

      try {
        const client = await ready;
        await client.call(action.operation as never, input as never);
      } catch (cause) {
        return cause instanceof BroappError ? cause.message : 'The action failed.';
      }
      if (action.refresh !== undefined && action.refresh.length > 0) reload(action.refresh);
      if (action.then !== undefined) {
        // A navigation parameter may be a literal or a reference, so that
        // "create it, then open it" can carry the id it was just given.
        const params = (action.then.params ?? []).map((value) =>
          String(resolveValue(value, scope) ?? ''),
        );
        navigate(action.then.page, params);
      }
      return null;
    },
    [ready, routes, reload, navigate, confirm],
  );
}
