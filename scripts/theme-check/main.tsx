/**
 * The page `bun run theme-check` measures.
 *
 * Three styling vocabularies share an Autoapp page: the renderer draws its own
 * components from `--autoapp-*` tokens, the AI panel is shadcn source on Radix
 * reading seven application properties, and the application sets those seven.
 * Nothing had ever checked, in a browser, that a button the renderer drew and
 * a select the panel opened show the same theme — so this page puts one of
 * each side by side, in the order and with the stylesheets a real application
 * uses, and `scripts/theme-check.ts` reads their computed styles.
 *
 * Why a page of its own rather than the Notes example: the renderer needs a
 * bridge to load a view's sources, and the panel as Notes composes it has no
 * portalled component at all — its prompt bar is a textarea and two buttons.
 * So the renderer's components are drawn here inside a stub page context with
 * fixed data, the way `theme-gallery.ts` does it, and the panel's vendored
 * select is drawn inside `.broapp-chat`, where an application composing its own
 * prompt bar would put it. Everything else is real: the stylesheets, their
 * order, the bundler, the hashed policy, the portal.
 *
 * `theme.css` is written by the harness before each build, one file per theme.
 * It is last, so it is the application's own stylesheet, and it is not
 * committed.
 */
import * as React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/*
 * The vendored select by path rather than through `broapp-ai-elements/ui`,
 * which also exports it: the package entry pulls in the whole panel, and
 * `Bun.build` inside `bun test` resolves a relative import from the workspace
 * symlink rather than from its real path, so a file two directories up from
 * `src/ui/` cannot be found. Nothing about the styling changes — this is the
 * same file the panel draws.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../packages/broapp-ai-elements/src/ui/components/ui/select.tsx';

import { views } from '../../templates/autoapp-starter/src/shared/views.ts';
import { PageProvider } from '../../packages/broapp-autoapp/src/react/context.tsx';
import type { PageContextValue, SourceState } from '../../packages/broapp-autoapp/src/react/context.tsx';
import { renderComponent } from '../../packages/broapp-autoapp/src/react/Page.tsx';
import type { Component } from '../../packages/broapp-autoapp/src/views/types.ts';

import 'broapp-ai-elements/styles.css';
import '../../packages/broapp-autoapp/src/react/tokens.css';
import '../../packages/broapp-autoapp/src/react/view.css';
import './theme.css';

const NOW = Date.UTC(2026, 8, 12, 9, 30);

const ITEMS = [
  { id: 1, label: 'Renew the parking permit', note: 'The form wants last year’s number.', done: false, nextDone: true, createdAt: NOW - 86_400_000 * 3 },
  { id: 2, label: 'Book the boiler service', note: 'Before the first cold week.', done: true, nextDone: false, createdAt: NOW },
];

const loaded = (data: unknown): SourceState => ({ data, error: null, loading: false });

const context: PageContextValue = {
  views,
  params: {},
  sources: { all: loaded({ items: ITEMS }), status: loaded({ count: 2, done: 1 }) },
  routes: {},
  reload: () => undefined,
  navigate: () => undefined,
  confirm: () => true,
  run: () => Promise.resolve(null),
};

const page = views.pages[0];
if (page === undefined) throw new Error('the starter has no page');

/** A link and a status, which the starter's own page does not draw. */
const extras: Component = {
  id: 'check-more',
  kind: 'section',
  label: 'The other kinds',
  children: [
    { id: 'check-status', kind: 'status', label: 'Done so far', source: 'status', path: 'done' },
    {
      id: 'check-links',
      kind: 'table',
      label: 'A table whose cells are links',
      source: 'all',
      rows: 'items',
      columns: [{ id: 'label', header: 'Opens', path: 'label', link: { page: 'items', params: ['id'] } }],
    },
  ],
};

/**
 * The panel, reduced to the part that is being measured.
 *
 * `.broapp-chat` is the scope that carries the shadcn tokens, so a component
 * inside it is coloured the way the whole panel is. The select's content is
 * portalled to the end of the document, which is the case this page exists to
 * catch: outside that scope, unless the portal carries the scope with it.
 */
function Panel(): React.ReactElement {
  return (
    <div className="broapp-chat" data-check="panel">
      <Select defaultValue="first">
        <SelectTrigger data-check="select-trigger">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent data-check="select-content">
          <SelectItem value="first">The first choice</SelectItem>
          <SelectItem value="second">The second choice</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <div className="autoapp">
      <PageProvider value={context}>
        <div className="autoapp-page" data-autoapp-page={page.id}>
          <h1 className="autoapp-page__title">{page.title}</h1>
          {page.children.map((component) => renderComponent(component))}
          {renderComponent(extras)}
        </div>
      </PageProvider>
    </div>
    <Panel />
  </StrictMode>,
);
