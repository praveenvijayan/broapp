/**
 * `broapp-autoapp/react` — the pinned renderer.
 *
 * The whole point of this entry point is that it is *pinned*: an application's
 * interface changes by changing the view specification a release carries, never
 * by shipping different browser code. Import `broapp-autoapp/react/view.css`
 * alongside it, the way `broapp/ai/react/ai.css` is imported.
 */
export { AutoappView, useViews } from './AutoappView.tsx';
export type { AutoappViewProps, ViewsState } from './AutoappView.tsx';

export { Page } from './Page.tsx';
export type { PageProps } from './Page.tsx';

export { buildHash, parseHash, PageProvider, usePage } from './context.tsx';
export type { PageContextValue, SourceState } from './context.tsx';

export { readPath, resolveInput, resolveValue } from './bind.ts';
export type { Scope } from './bind.ts';
export { formatValue } from './format.ts';

export { autoappContract } from '../shared/contract.ts';
export type { AutoappContract } from '../shared/contract.ts';
export type { Conflict, Override, Overrides } from '../views/overrides.ts';
export type { ViewsSpec } from '../views/types.ts';
