/**
 * What a build refuses in a specification that parses.
 *
 * `parseSpec` says whether a specification is well formed, and it is also what
 * reads every stored release back, so a rule added there would stop a release
 * built last week from reading, activating or rolling back. These rules are
 * about what a *new* build may say, and run on the specification the build has
 * just assembled, before it has an identity.
 *
 * Both come from the `news` application on 2026-09-22 (22a). Six of its
 * examples called `news.search`, an `external` route, and passed on the
 * preview gate's own refusal: they asserted nothing about the application and
 * completed three tasks. And its contract had that route while its manifest
 * asked for no capability, so the person was never told it reaches the web.
 */
import type { AppSpec, BuildProblem } from './types.ts';
import { isViewStep } from './types.ts';

/**
 * The routes of a contract whose effect is `external`, sorted: the ones a
 * preview refuses for everyone, the person's own click included.
 */
export function externalRoutes(contract: {
  readonly operations: Readonly<Record<string, { readonly effect: string }>>;
  readonly streams: Readonly<Record<string, { readonly effect: string }>>;
}): string[] {
  return [...Object.entries(contract.operations), ...Object.entries(contract.streams)]
    .filter(([, route]) => route.effect === 'external')
    .map(([name]) => name)
    .sort();
}

/**
 * The ids of the examples of `spec` with a step on one of its `external`
 * routes: the examples {@link releaseProblems} refuses.
 */
export function examplesOnExternal(spec: Pick<AppSpec, 'contract' | 'acceptance'>): Set<string> {
  const external = new Set(externalRoutes(spec.contract));
  return new Set(
    spec.acceptance
      .filter((example) => example.steps.some((step) => !isViewStep(step) && external.has(step.route)))
      .map((example) => example.id),
  );
}

/** `a`, `a and b`, `a, b and c`, each in backticks. */
function named(routes: readonly string[]): string {
  const quoted = routes.map((route) => `\`${route}\``);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`;
}

/**
 * Everything a build refuses in an assembled specification, every problem at
 * stage `spec`.
 *
 * - A route step on an `external` route, one problem per step in example
 *   order. A preview refuses such a route before the route sees it, so a step
 *   that expects output always fails and a step with `fails` always passes:
 *   neither tests the route. A view step is never one.
 * - An `external` route and a manifest that asks for no capability, one
 *   problem naming every such route. The capability is what the person is told
 *   at `candidate.explain` and asked at activation; it is not a fence, since a
 *   release is trusted local code. Asking for a capability with no `external`
 *   route is not refused: asking for more than is used is the person's to
 *   notice at the grant.
 */
export function releaseProblems(spec: Pick<AppSpec, 'contract' | 'acceptance' | 'manifest'>): BuildProblem[] {
  const problems: BuildProblem[] = [];
  const routes = externalRoutes(spec.contract);
  const external = new Set(routes);

  for (const example of spec.acceptance) {
    example.steps.forEach((step, index) => {
      if (isViewStep(step) || !external.has(step.route)) return;
      problems.push({
        stage: 'spec',
        message: `example \`${example.id}\` step ${String(index + 1)} calls \`${step.route}\`, an \`external\` route, which a preview refuses before the route sees it; no step can test it. Assert what the preview can show — the page, the form, a route that is not \`external\` — and put trying \`${step.route}\` in the runbook, after activating.`,
      });
    });
  }

  if (routes.length > 0 && spec.manifest.capabilities.length === 0) {
    problems.push({
      stage: 'spec',
      message: `the contract has ${named(routes)} as \`external\`, but \`autoapp.json\` asks for no capability. An \`external\` route reaches outside this machine or the data directory; say what it reaches — \`network\` with the hosts it will call, \`files\` with the paths, or \`spawn\` — with one sentence of reason, so the person is told and asked.`,
    });
  }
  return problems;
}
