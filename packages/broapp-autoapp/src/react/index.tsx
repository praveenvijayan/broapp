/**
 * `broapp-autoapp/react` — the pinned renderer.
 *
 * The whole point of this entry point is that it is *pinned*: an application's
 * interface changes by changing the view specification a release carries, never
 * by shipping different browser code. Import `broapp-autoapp/react/tokens.css`
 * and then `broapp-autoapp/react/view.css` alongside it, the way
 * `broapp/ai/react/ai.css` is imported: the first is every token's default,
 * generated from `theme.ts`, and the second is the renderer's rules, which read
 * nothing but those tokens.
 */
export { AutoappView, useViews } from './AutoappView.tsx';
export type { AutoappViewProps, ViewsState } from './AutoappView.tsx';

export { ApprovalsStrip } from './ApprovalsStrip.tsx';
export { RunsPage } from './RunsPage.tsx';
export { WorkflowsPage } from './WorkflowsPage.tsx';

export { Page } from './Page.tsx';
export type { PageProps } from './Page.tsx';

export { buildHash, parseHash, PageProvider, usePage } from './context.tsx';
export type { PageContextValue, SourceState } from './context.tsx';

export { announcePending, browserSurface, titleWithPending } from './pending.ts';
export type { PendingSurface } from './pending.ts';

export {
  APPLICATION_VARIABLES,
  AUTOAPP_TOKENS,
  declaredValue,
  fallbackFor,
  TOKEN_PREFIX,
  tokensCss,
} from './theme.ts';
export type { ApplicationVariable, ThemeToken, TokenConsumer, TokenGroup } from './theme.ts';

export { readPath, resolveInput, resolveValue } from './bind.ts';
export type { Scope } from './bind.ts';
export { formatValue } from './format.ts';

export { autoappContract } from '../shared/contract.ts';
export type { AutoappContract } from '../shared/contract.ts';
export type { Addition, Conflict, Override, Overrides } from '../views/overrides.ts';
export type {
  WorkflowDefinition,
  WorkflowParam,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepResult,
} from '../workflows/types.ts';
export type { ViewsSpec } from '../views/types.ts';
