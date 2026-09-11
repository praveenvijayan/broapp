#!/usr/bin/env bun
/**
 * Write `src/react/tokens.css` from the theme table.
 *
 *   bun run --cwd packages/broapp-autoapp build:tokens
 *
 * The result is committed, like `broapp-ai-elements`' stylesheet: an
 * application imports this package from source, so a stylesheet that existed
 * only after a build step would be missing exactly when it is needed.
 * `tests/autoapp-theme.test.ts` regenerates it and fails when the committed
 * copy is stale.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AUTOAPP_TOKENS, tokensCss } from '../src/react/theme.ts';

// `import.meta.dir` rather than a URL's `pathname`: on Windows the latter is
// `/D:/a/...`, which resolves against the drive again and fails to open.
const packageDir = resolve(import.meta.dir, '..');

if (import.meta.main) {
  const css = tokensCss();
  writeFileSync(join(packageDir, 'src', 'react', 'tokens.css'), css, 'utf8');
  console.log(`tokens  src/react/tokens.css  ${String(AUTOAPP_TOKENS.length)} tokens  ${String(css.length)} bytes`);
}
