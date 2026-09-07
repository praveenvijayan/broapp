/**
 * Turning a source workspace into an immutable release.
 *
 * Two things are worth reading here.
 *
 * The contract and the views are *bundled first and imported from the bundle*,
 * rather than imported straight out of the source tree. Importing the source
 * would resolve its imports through the workspace's own `node_modules`, which
 * is not necessarily what the built release will resolve them through — so a
 * release could be described by one version of a contract and run another. The
 * bundle is what ships, so the bundle is what is read.
 *
 * And every failure is a `BuildProblem` rather than a throw. A build is
 * something an AI engineer runs against something it just wrote; it needs to be
 * told everything that is wrong in one pass, not the first thing.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage } from 'broapp/build';
import type { HostLogger } from 'broapp/host';

import { checkViewsAgainstContract, parseViews } from '../views/index.ts';
import type { ViewsSpec } from '../views/types.ts';
import {
  canonicalJson,
  exportContract,
  parseSpec,
  readRelease,
  releaseId as computeReleaseId,
  stripIdentity,
  writeRelease,
  type AppSpec,
  type Capability,
  type Layout,
  type MigrationSpec,
  type AcceptanceExample,
} from '../spec/index.ts';

/** What `autoapp.json` in a source workspace says. */
export interface SourceManifest {
  readonly appId: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly capabilities?: readonly Capability[];
  readonly migrations?: readonly MigrationSpec[];
  readonly acceptance?: readonly AcceptanceExample[];
}

/** Options for {@link buildCandidate}. */
export interface BuildCandidateParams {
  readonly layout: Layout;
  readonly appId: string;
  /** Defaults to the application's own source workspace. */
  readonly sourceDir?: string;
  readonly logger?: HostLogger;
}

/** One thing wrong with a source workspace, and which stage found it. */
export interface BuildProblem {
  readonly stage: 'contract' | 'views' | 'page' | 'host' | 'spec';
  readonly message: string;
}

/** What a build produced, or why it produced nothing. */
export type BuildCandidateResult =
  | { readonly ok: true; readonly releaseId: string; readonly spec: AppSpec; readonly rebuilt: boolean }
  | { readonly ok: false; readonly problems: readonly BuildProblem[] };

/** The fixed shape of a source workspace. */
const SOURCE = {
  manifest: 'autoapp.json',
  contract: 'src/shared/contract.ts',
  views: 'src/shared/views.ts',
  host: 'src/host/app.ts',
  uiEntry: 'src/ui/main.tsx',
  uiTemplate: 'src/ui/index.html',
} as const;

/** The names a release directory gives its two bundles. */
const RELEASE_PAGE = 'page.html';
const RELEASE_HOST = 'host.js';

/** A one-sentence reason, without a stack. */
function reason(cause: unknown): string {
  return String(cause instanceof Error ? cause.message : cause);
}

/** What a build says when a dependency is not installed. */
const MISSING_DEPENDENCY =
  'dependencies are installed when an application is imported; re-import to add one';

/**
 * Check that every declared dependency can be resolved from the workspace.
 *
 * A candidate build must not reach the network, and `Bun.build` would otherwise
 * fail somewhere inside the bundler with a message about a module specifier,
 * which says nothing about what a person should do. This says it before
 * bundling starts and names the package.
 *
 * Resolution follows Node's rules, so a dependency may be satisfied by a
 * `node_modules` above the workspace — which is how the examples in this
 * repository build at all. That is deliberately allowed: the offline guarantee
 * documented in `docs/autoapp/packaging.md` is the one about the *built
 * release*, which bundles what it needs and resolves nothing at run time. What
 * this check is for is the other half — a package that is nowhere at all, which
 * only the network could supply.
 */
function checkDependencies(sourceDir: string): readonly BuildProblem[] {
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    // An application without a `package.json` declares no dependencies. The
    // bundler will say so if it imports something anyway.
    return [];
  }

  const problems: BuildProblem[] = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try {
      Bun.resolveSync(name, sourceDir);
    } catch {
      problems.push({ stage: 'host', message: `${name} is not installed. ${MISSING_DEPENDENCY}` });
    }
  }
  return problems;
}

/** Read the version of an installed package, for the manifest's record. */
function versionOf(specifier: string, fallback: string): string {
  try {
    const path = Bun.resolveSync(`${specifier}/package.json`, import.meta.dir);
    return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? fallback;
  } catch {
    return fallback;
  }
}

/** Build one candidate release from a source workspace. */
export async function buildCandidate(params: BuildCandidateParams): Promise<BuildCandidateResult> {
  const app = params.layout.app(params.appId);
  const sourceDir = params.sourceDir ?? app.source;
  const problems: BuildProblem[] = [];
  const work = mkdtempSync(join(tmpdir(), 'autoapp-build-'));

  try {
    let manifest: SourceManifest;
    try {
      manifest = JSON.parse(readFileSync(join(sourceDir, SOURCE.manifest), 'utf8')) as SourceManifest;
    } catch (cause) {
      return { ok: false, problems: [{ stage: 'spec', message: `${SOURCE.manifest}: ${reason(cause)}` }] };
    }
    if (manifest.appId !== params.appId) {
      return {
        ok: false,
        problems: [
          {
            stage: 'spec',
            message: `${SOURCE.manifest} says this is ${JSON.stringify(manifest.appId)}, not ${JSON.stringify(params.appId)}`,
          },
        ],
      };
    }

    // 1. The contract and the views, read out of a bundle rather than out of
    //    the source tree, for the reason in this file's opening comment.
    let contract: unknown;
    let views: ViewsSpec | null = null;
    const shared = await Bun.build({
      entrypoints: [join(sourceDir, SOURCE.contract), join(sourceDir, SOURCE.views)],
      outdir: join(work, 'shared'),
      target: 'bun',
      format: 'esm',
      minify: false,
    }).catch((cause: unknown) => ({ success: false as const, logs: [reason(cause)] }));
    if (!shared.success) {
      return {
        ok: false,
        problems: [{ stage: 'contract', message: `the shared layer would not bundle: ${String(shared.logs.join('; '))}` }],
      };
    }
    try {
      const module = (await import(join(work, 'shared', 'contract.js'))) as { contract?: unknown };
      contract = module.contract;
      if (contract === undefined) throw new Error(`${SOURCE.contract} does not export "contract"`);
    } catch (cause) {
      problems.push({ stage: 'contract', message: reason(cause) });
    }
    try {
      const module = (await import(join(work, 'shared', 'views.js'))) as Record<string, unknown>;
      // An application may name its export `views` or after itself; both are
      // ordinary, and refusing one of them would be a rule nobody remembers.
      const exported = module['views'] ?? Object.values(module).find((value) => isViewsSpec(value));
      if (exported === undefined) throw new Error(`${SOURCE.views} does not export a view specification`);
      views = parseViews(exported);
    } catch (cause) {
      problems.push({ stage: 'views', message: reason(cause) });
    }

    let exported: ReturnType<typeof exportContract> | null = null;
    if (contract !== undefined) {
      try {
        exported = exportContract(contract as Parameters<typeof exportContract>[0]);
      } catch (cause) {
        problems.push({ stage: 'contract', message: reason(cause) });
      }
    }
    if (exported !== null && views !== null) {
      for (const message of checkViewsAgainstContract(views, exported)) {
        problems.push({ stage: 'views', message });
      }
    }

    // 2. The page. One document, CSP pinned to the hashes of what is in it.
    try {
      await buildPage({
        root: sourceDir,
        entry: SOURCE.uiEntry,
        template: SOURCE.uiTemplate,
        outFile: join(work, RELEASE_PAGE),
      });
    } catch (cause) {
      problems.push({ stage: 'page', message: reason(cause) });
    }

    // 3. The host bundle. Dependencies are checked first, so a missing one is a
    //    sentence about re-importing rather than a bundler error about a
    //    module specifier.
    //
    //    `bun:sqlite` is external because it is part of the runtime the child
    //    already is, not something to bundle a copy of.
    //
    //    This runs `Bun.build` in the launcher's own process. That bundles the
    //    application's modules; it does not *execute* them — the bundler reads
    //    and rewrites source, and nothing in the release runs until a child
    //    imports it. Report 02 established that a compiled launcher can also
    //    run the bundler through `BUN_BE_BUN=1`, which is the route to take if
    //    this ever needs to be isolated further.
    problems.push(...checkDependencies(sourceDir));

    const host = await Bun.build({
      entrypoints: [join(sourceDir, SOURCE.host)],
      outdir: work,
      naming: RELEASE_HOST,
      target: 'bun',
      format: 'esm',
      external: ['bun:sqlite'],
      minify: false,
    }).catch((cause: unknown) => ({ success: false as const, logs: [reason(cause)] }));
    if (!host.success) {
      problems.push({ stage: 'host', message: `the host bundle failed: ${String(host.logs.join('; '))}` });
    }

    if (problems.length > 0 || exported === null || views === null) return { ok: false, problems };

    // 4. The manifest and the identity.
    let page: Uint8Array;
    let hostBytes: Uint8Array;
    try {
      page = readFileSync(join(work, RELEASE_PAGE));
      hostBytes = readFileSync(join(work, RELEASE_HOST));
    } catch (cause) {
      return { ok: false, problems: [{ stage: 'spec', message: reason(cause) }] };
    }

    // The identity covers the whole specification, so the specification has to
    // exist before it can be computed. It is assembled with a placeholder name,
    // hashed — `stripIdentity` removes the placeholder along with `createdAt` —
    // and then parsed a second time under the name it earned.
    const PLACEHOLDER = '0'.repeat(32);
    let draft: AppSpec;
    try {
      draft = parseSpec({
        manifest: {
          specVersion: 1,
          appId: manifest.appId,
          name: manifest.name,
          releaseId: PLACEHOLDER,
          createdAt: Date.now(),
          runtime: {
            broapp: versionOf('broapp', '0.0.0'),
            autoapp: versionOf('broapp-autoapp', '0.0.0'),
            bun: Bun.version,
          },
          entry: { host: RELEASE_HOST, page: RELEASE_PAGE },
          schemaVersion: manifest.schemaVersion,
          capabilities: manifest.capabilities ?? [],
        },
        contract: exported,
        views,
        workflows: [],
        migrations: manifest.migrations ?? [],
        acceptance: manifest.acceptance ?? [],
      });
    } catch (cause) {
      return { ok: false, problems: [{ stage: 'spec', message: reason(cause) }] };
    }

    const releaseId = computeReleaseId({ page, host: hostBytes, spec: draft });
    const spec: AppSpec = { ...draft, manifest: { ...draft.manifest, releaseId } };

    // 5. Write it. An identical rebuild produces an identical id, and there is
    //    nothing a second write could legitimately change — so it is a success
    //    that did nothing rather than a conflict.
    try {
      writeRelease(params.layout, spec, { page, host: hostBytes });
      return { ok: true, releaseId, spec, rebuilt: true };
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'conflict') {
        return { ok: false, problems: [{ stage: 'spec', message: reason(cause) }] };
      }
      // The identity already exists, and the identity now covers everything a
      // release contains — so this is a rebuild of the same sources and
      // nothing else. The stored specification is compared anyway, because if
      // it differed the hash would be broken, and continuing on a broken hash
      // is how an approval ends up authorising code nobody looked at.
      const stored = readRelease(params.layout, params.appId, releaseId);
      if (canonicalJson(stripIdentity(stored)) !== canonicalJson(stripIdentity(spec))) {
        throw new Error(
          `release ${releaseId} already exists with a different specification; the release identity is not a function of its contents`,
        );
      }
      params.logger?.warn(`[autoapp] release ${releaseId} was already built`);
      return { ok: true, releaseId, spec, rebuilt: false };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A cheap shape test, for finding the view specification among a module's exports. */
function isViewsSpec(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'specVersion' in value &&
    'pages' in value &&
    'home' in value
  );
}
