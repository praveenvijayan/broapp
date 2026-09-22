/**
 * One page: its sources, and its components.
 *
 * Sources load in the order the page declares them, on open and on reload.
 * They are loaded here rather than by the components that read them, because
 * two components may read the same source and neither should cause a second
 * call — and because an action's `refresh` names sources, not components.
 */
import * as React from 'react';

import { useBroappReady } from 'broapp/react';
import { BroappError, fromTransportError } from 'broapp/shared';
import type { AnyContract } from 'broapp/shared';

import type { Component, Page as PageSpec, ViewsSpec } from '../views/types.ts';

import { coerceToSchema, inputToSend, resolveInput } from './bind.ts';
import {
  PageProvider,
  useRunAction,
  type PageContextValue,
  type RouteInfo,
  type SourceState,
} from './context.tsx';
import { Button } from './components/Button.tsx';
import { Form } from './components/Form.tsx';
import { Section } from './components/Section.tsx';
import { Status } from './components/Status.tsx';
import { Table } from './components/Table.tsx';
import { Text } from './components/Text.tsx';

/** Props for {@link Page}. */
export interface PageProps {
  readonly views: ViewsSpec;
  readonly page: PageSpec;
  /** Positional parameters from the hash, named by the page's `params`. */
  readonly params: readonly string[];
  /** What the contract says about each operation. */
  readonly routes: Readonly<Record<string, RouteInfo>>;
  navigate(pageId: string, params?: readonly string[]): void;
  /** Replaceable so a test does not need a browser dialog. */
  confirm?(message: string): boolean;
  /** Change this to reload every source. For something outside the renderer that changed the data. */
  readonly reloadToken?: number;
}

/**
 * Render one component and, for a section, whatever is inside it.
 *
 * Exported for the theme gallery, which draws components inside a stub page
 * context because nothing on a server can load a page's sources.
 */
export function renderComponent(component: Component): React.ReactElement | null {
  if (component.hidden === true) return null;
  switch (component.kind) {
    case 'section':
      return (
        <Section component={component} key={component.id}>
          {(component.children ?? []).map((child) => renderComponent(child))}
        </Section>
      );
    case 'text':
      return <Text component={component} key={component.id} />;
    case 'table':
      return <Table component={component} key={component.id} />;
    case 'form':
      return <Form component={component} key={component.id} />;
    case 'button':
      return <Button component={component} key={component.id} />;
    case 'status':
      return <Status component={component} key={component.id} />;
  }
}

/** The route the launcher's child runtime mounts beside an application's own. */
const PANEL_ROUTE = 'autoapp.panel';

/** What `autoapp.panel` answers, checked here because it is not in the page's contract. */
function panelAnswer(raw: unknown): { available: boolean; opened: boolean | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { available, opened } = raw as Record<string, unknown>;
  if (typeof available !== 'boolean') return null;
  return { available, opened: typeof opened === 'boolean' ? opened : null };
}

/**
 * Whether there is a launcher panel to go back to, asked once when the page loads.
 *
 * Called on the bridge rather than through the client: the route belongs to
 * the launcher, not to the application's contract, and the client refuses a
 * route its contract does not name. An application the launcher does not
 * serve has no such route, the call fails, and the mark stays hidden.
 */
function usePanelLink(): { available: boolean; message: string | null; open(): void } {
  const ready = useBroappReady<AnyContract>();
  const [available, setAvailable] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const client = await ready;
        const answer = panelAnswer(await client.bridge.call(PANEL_ROUTE, { mint: false }));
        if (live) setAvailable(answer?.available === true);
      } catch {
        // No route, no launcher, no mark.
      }
    })();
    return () => {
      live = false;
    };
  }, [ready]);

  const open = React.useCallback(() => {
    setMessage(null);
    void (async () => {
      try {
        const client = await ready;
        const answer = panelAnswer(await client.bridge.call(PANEL_ROUTE, { mint: true }));
        if (answer?.opened === false) {
          setMessage('The launcher could not open a browser. Its terminal shows the panel’s address.');
        }
      } catch (cause) {
        setMessage(fromTransportError(cause).message);
      }
    })();
  }, [ready]);

  return { available, message, open };
}

/** The browser's own confirmation dialog, where there is a browser. */
function browserConfirm(message: string): boolean {
  return typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : true;
}

export function Page({
  views,
  page,
  params,
  routes,
  navigate,
  confirm = browserConfirm,
  reloadToken = 0,
}: PageProps): React.ReactElement {
  const ready = useBroappReady<AnyContract>();
  const [sources, setSources] = React.useState<Record<string, SourceState>>({});
  // Bumped to ask for a reload. A counter rather than a callback so that the
  // effect below owns every call and there is one place cancellation happens.
  const [generation, setGeneration] = React.useState(0);
  const [wanted, setWanted] = React.useState<readonly string[] | null>(null);

  // Something outside the renderer changed the data — an approved AI tool call,
  // usually. Every source is stale, and which ones is not knowable from here.
  React.useEffect(() => {
    if (reloadToken === 0) return;
    setWanted(null);
    setGeneration((current) => current + 1);
  }, [reloadToken]);

  /** Page parameters by the names the page gave them. */
  const named = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const [index, name] of (page.params ?? []).entries()) out[name] = params[index] ?? '';
    return out;
  }, [page.params, params]);

  const specs = page.sources ?? [];

  React.useEffect(() => {
    let live = true;
    const loading = wanted === null ? specs : specs.filter((source) => wanted.includes(source.id));
    if (loading.length === 0) return;

    setSources((current) => {
      const next = { ...current };
      for (const source of loading) {
        next[source.id] = { data: current[source.id]?.data ?? null, error: null, loading: true };
      }
      return next;
    });

    void (async () => {
      const client = await ready;
      // In order, deliberately: a page whose second source depends on the
      // first being current is the common case, and a local round trip is
      // cheap enough that parallelism buys nothing worth the surprise.
      for (const source of loading) {
        try {
          // As for actions: a source with no input sends nothing, because a
          // route taking `s.void()` refuses an empty object — and so does a
          // source whose input resolves to nothing on such a route.
          const schema = routes[source.operation]?.input;
          const input =
            source.input === undefined
              ? undefined
              : inputToSend(
                  coerceToSchema(resolveInput(source.input as Record<string, unknown>, { params: named }), schema),
                  schema,
                );
          const data = await client.call(source.operation as never, input as never);
          if (!live) return;
          setSources((current) => ({ ...current, [source.id]: { data, error: null, loading: false } }));
        } catch (cause) {
          if (!live) return;
          const message =
            cause instanceof BroappError ? cause.message : 'This could not be loaded.';
          setSources((current) => ({
            ...current,
            [source.id]: { data: current[source.id]?.data ?? null, error: message, loading: false },
          }));
        }
      }
    })();

    return () => {
      live = false;
    };
    // `specs` is derived from the page, and `named` from the parameters; both
    // change exactly when the page should reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, page.id, named, generation]);

  const reload = React.useCallback((ids?: readonly string[]) => {
    setWanted(ids ?? null);
    setGeneration((current) => current + 1);
  }, []);

  const run = useRunAction(routes, reload, navigate, confirm);
  const panel = usePanelLink();

  const value = React.useMemo<PageContextValue>(
    () => ({ views, params: named, sources, routes, reload, navigate, confirm, run }),
    [views, named, sources, routes, reload, navigate, confirm, run],
  );

  return (
    <PageProvider value={value}>
      <div className="autoapp-page" data-autoapp-page={page.id}>
        {panel.available ? (
          <div className="autoapp-page__head">
            <h1 className="autoapp-page__title">{page.title}</h1>
            <button
              type="button"
              className="autoapp-page__panel"
              title="Open the Autoapp panel"
              onClick={panel.open}
            >
              Autoapp
            </button>
          </div>
        ) : (
          <h1 className="autoapp-page__title">{page.title}</h1>
        )}
        {panel.message === null ? null : (
          <p className="autoapp-message autoapp-message--error" role="alert">
            {panel.message}
          </p>
        )}
        {page.children.map((component) => renderComponent(component))}
      </div>
    </PageProvider>
  );
}
