/**
 * The starter template, as the tests see it.
 *
 * The launcher reads `dist/starter-template.json`, which is a build artefact.
 * A test packs `templates/autoapp-starter` itself, with the same function the
 * build script uses, so a suite does not depend on whether anybody has run
 * `build:template` — and so the thing under test is the template in git rather
 * than whatever happens to be in `dist`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packTemplate } from '../packages/broapp-autoapp/scripts/build-template.ts';
import type { StarterTemplate } from 'broapp-autoapp/launcher';

/** Where the starter lives, reviewed in git. */
export const STARTER_DIR = join(import.meta.dir, '..', 'templates', 'autoapp-starter');

/** The starter, packed the way the build packs it. */
export const STARTER: StarterTemplate = packTemplate(STARTER_DIR);

/** The ranges a created workspace is written with, read where the launcher reads them. */
export const STARTER_VERSIONS = (() => {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'package.json'),
      'utf8',
    ),
  ) as { version: string; dependencies: Record<string, string> };
  return { broapp: manifest.dependencies['broapp'] ?? '', autoapp: `^${manifest.version}` };
})();
