/**
 * The host side of the renderer.
 *
 * Three routes and one file. The release's view specification is immutable and
 * lives in the release directory; a person's own changes live in their data
 * directory and outlive releases. `autoapp.viewsGet` is where the two meet, and
 * it is the only thing the browser asks — so the renderer never has to know
 * that overrides exist, and a conflict is reported once, in one place.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createReservedHostApp } from 'broapp/host';
import type { Bridge } from 'brobridge';
import type { HostApp, HostLogger } from 'broapp/host';

import { autoappContract, type AutoappContract } from '../shared/contract.ts';
import { applyOverrides, NO_OVERRIDES, type Overrides } from '../views/overrides.ts';
import type { ViewsSpec } from '../views/types.ts';

/** Options for {@link createViewsHost}. */
export interface CreateViewsHostOptions {
  /** The application's data directory. Overrides live in `autoapp/` under it. */
  readonly dataDir: string;
  /** The release's own view specification, already validated. */
  readonly views: ViewsSpec;
  readonly logger?: HostLogger;
}

/** The renderer's host routes, ready to mount. */
export interface ViewsHost {
  mount(bridge: Bridge): void;
  /** The release's views, without overrides. For tests and for the engineer. */
  readonly views: ViewsSpec;
}

/** Where a person's own changes are kept. */
function overridesPath(dataDir: string): string {
  return join(dataDir, 'autoapp', 'overrides.json');
}

/** Build the renderer's host routes for one application. */
export function createViewsHost(options: CreateViewsHostOptions): ViewsHost {
  const logger: HostLogger = options.logger ?? console;
  const path = overridesPath(options.dataDir);

  /** What this person has changed, or nothing when they have changed nothing. */
  function read(): Overrides {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return NO_OVERRIDES;
    }
    try {
      const parsed = JSON.parse(raw) as Overrides;
      // A file that has been hand-edited into nonsense is not worth failing the
      // whole interface over: the release's own views are still renderable, and
      // the person gets their application back rather than a blank page.
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
        logger.warn(`[autoapp] ${path} is not a version 1 overrides file; ignoring it`);
        return NO_OVERRIDES;
      }
      return parsed;
    } catch {
      logger.warn(`[autoapp] ${path} could not be read as JSON; ignoring it`);
      return NO_OVERRIDES;
    }
  }

  /** Replace them, without ever leaving a half-written file behind. */
  function write(next: Overrides): void {
    mkdirSync(join(options.dataDir, 'autoapp'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporary, path);
  }

  const host: HostApp<AutoappContract> = createReservedHostApp<AutoappContract>(autoappContract, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  host.operation('autoapp.overridesGet', () => read());
  host.operation('autoapp.overridesSet', (next) => {
    write(next);
    return { ok: true };
  });
  host.operation('autoapp.viewsGet', () => {
    const applied = applyOverrides(options.views, read());
    return { views: applied.views, conflicts: [...applied.conflicts] };
  });

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    views: options.views,
  };
}
