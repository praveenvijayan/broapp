import { defineConfig } from 'broapp/build';

/**
 * Every field here has a default that matches this layout, so the file exists
 * mostly to be read. Change `binaryName` if the executable should not be named
 * after the package.
 */
export default defineConfig({
  uiEntry: 'src/ui/main.tsx',
  uiTemplate: 'src/ui/index.html',
  hostEntry: 'src/host/main.ts',
  pageOut: 'dist/ui.html',
  outDir: 'release',
});
