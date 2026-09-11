/**
 * The renderer.
 *
 * One component, pinned in this package, drawing whatever view specification
 * the host hands it. Nothing about an application's interface is code that was
 * generated for it — which is why a proposal from an AI engineer can change
 * what an application looks like without changing what runs in the browser, and
 * why the page's content-security policy can stay pinned to the hashes the
 * build computed.
 */
import * as React from 'react';

import { useBroappContract, useOperation } from 'broapp/react';
import type { AnyContract, JsonSchema } from 'broapp/shared';

import type { AutoappContract } from '../shared/contract.ts';
import type { Conflict } from '../views/overrides.ts';
import type { ViewsSpec } from '../views/types.ts';

import { ApprovalsStrip } from './ApprovalsStrip.tsx';
import { buildHash, parseHash, type RouteInfo } from './context.tsx';
import { Page } from './Page.tsx';
import { RunsPage } from './RunsPage.tsx';
import { WorkflowsPage } from './WorkflowsPage.tsx';

/** Props for {@link AutoappView}. */
export interface AutoappViewProps {
  /** Replaceable so a test does not need a browser dialog. */
  confirm?(message: string): boolean;
  /**
   * Change this to reload every source on the current page.
   *
   * For something outside the renderer that changed the data — an approved AI
   * tool call is the case this exists for.
   */
  readonly reloadToken?: number;
}

/** What the host said the interface is, and what could not be applied. */
export interface ViewsState {
  readonly views: ViewsSpec | null;
  readonly conflicts: readonly Conflict[];
  readonly error: string | null;
  readonly loading: boolean;
}

/**
 * The application's interface, once.
 *
 * Fetched from the host rather than imported, because a person's own overrides
 * are applied there and the browser should not have to know they exist.
 */
export function useViews(): ViewsState {
  const get = useOperation<AutoappContract, 'autoapp.viewsGet'>('autoapp.viewsGet');
  const { run } = get;
  React.useEffect(() => {
    void run(undefined);
  }, [run]);
  return {
    views: get.data?.views ?? null,
    conflicts: get.data?.conflicts ?? [],
    error: get.error?.message ?? null,
    loading: get.pending,
  };
}

/** The current hash, kept in state so navigation re-renders. */
function useHash(): string {
  const [hash, setHash] = React.useState(() =>
    typeof globalThis.location === 'undefined' ? '' : globalThis.location.hash,
  );
  React.useEffect(() => {
    const onChange = (): void => setHash(globalThis.location.hash);
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/**
 * What the contract says about every operation.
 *
 * Read from the live contract the provider is already speaking, rather than
 * from the release's exported copy, so the renderer and the connection can
 * never disagree about what a route takes.
 */
function routesOf(contract: AnyContract): Readonly<Record<string, RouteInfo>> {
  const out: Record<string, RouteInfo> = {};
  for (const [route, spec] of Object.entries(contract.operations)) {
    const described = (spec as { input?: { toJsonSchema?: () => JsonSchema } }).input;
    out[route] = {
      effect: (spec as { effect?: string }).effect ?? 'write',
      input: typeof described?.toJsonSchema === 'function' ? described.toJsonSchema() : null,
    };
  }
  return out;
}

/**
 * What could not be applied of a person's own changes, above the page.
 *
 * Its own component so the theme gallery can draw a notice through the same
 * markup the renderer uses, without a connection to ask for views over.
 */
export function ConflictList({ conflicts }: { readonly conflicts: readonly Conflict[] }): React.ReactElement | null {
  if (conflicts.length === 0) return null;
  return (
    <ul className="autoapp-conflicts" data-autoapp-conflicts={String(conflicts.length)}>
      {conflicts.map((conflict) => (
        <li className="autoapp-conflicts__item" key={`${conflict.componentId}:${conflict.reason}`}>
          Your change to “{conflict.componentId}” could not be applied: {conflict.reason}.
        </li>
      ))}
    </ul>
  );
}

export function AutoappView({ confirm, reloadToken }: AutoappViewProps = {}): React.ReactElement {
  const { views, conflicts, error, loading } = useViews();
  const contract = useBroappContract();
  const hash = useHash();
  const routes = React.useMemo(() => routesOf(contract), [contract]);

  const navigate = React.useCallback((pageId: string, params: readonly string[] = []) => {
    if (typeof globalThis.location === 'undefined') return;
    globalThis.location.hash = buildHash(pageId, params);
  }, []);

  if (error !== null) {
    return (
      <div className="autoapp" data-autoapp-state="error">
        <p className="autoapp-message autoapp-message--error" role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (views === null) {
    return (
      <div className="autoapp" data-autoapp-state={loading ? 'loading' : 'empty'}>
        <p className="autoapp-empty">{loading ? 'Loading…' : 'This application has no interface yet.'}</p>
      </div>
    );
  }

  const { pageId, params } = parseHash(hash, views);
  const page = views.pages.find((candidate) => candidate.id === pageId);
  // Two pages every application has and none of them describes. A person is
  // entitled to see what was done on their behalf, so an application cannot
  // decline to offer it.
  const builtIn =
    pageId === 'autoapp' ? (params[0] === 'workflows' ? 'workflows' : 'runs') : null;

  return (
    <div className="autoapp" data-autoapp-state="ready">
      <ApprovalsStrip />
      <ConflictList conflicts={conflicts} />
      {builtIn === 'runs' ? (
        <RunsPage />
      ) : builtIn === 'workflows' ? (
        <WorkflowsPage />
      ) : page === undefined ? (
        <section className="autoapp-section" data-autoapp-state="not-found">
          <h2 className="autoapp-section__title">That page is not here</h2>
          <p className="autoapp-text">
            <a className="autoapp-link" href={buildHash(views.home)}>
              Go back to {views.pages.find((candidate) => candidate.id === views.home)?.title ?? 'the start'}
            </a>
          </p>
        </section>
      ) : (
        <Page
          key={`${page.id}:${params.join('/')}`}
          views={views}
          page={page}
          params={params}
          routes={routes}
          navigate={navigate}
          {...(confirm === undefined ? {} : { confirm })}
          {...(reloadToken === undefined ? {} : { reloadToken })}
        />
      )}
    </div>
  );
}
