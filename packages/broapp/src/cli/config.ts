/**
 * Project configuration.
 *
 * One optional file, `broapp.config.ts`, with sensible defaults for every
 * field — so a generated project has a config that is mostly there to be read
 * rather than edited.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** What `broapp.config.ts` may set. */
export interface BroappConfig {
  /** Browser entry point. Default `src/ui/main.tsx`. */
  readonly uiEntry?: string;
  /** HTML shell. Default `src/ui/index.html`. */
  readonly uiTemplate?: string;
  /** Host entry point. Default `src/host/main.ts`. */
  readonly hostEntry?: string;
  /** Where the built page goes. Must match what the host imports. Default `dist/ui.html`. */
  readonly pageOut?: string;
  /** Executable base name. Default: the package name. */
  readonly binaryName?: string;
  /** Output directory for executables. Default `release`. */
  readonly outDir?: string;
  /** Extra Content-Security-Policy sources. */
  readonly csp?: Readonly<Record<string, readonly string[]>>;
  /** Compile to bytecode. Default `true`. */
  readonly bytecode?: boolean;
}

/** A config with every default applied. */
export interface ResolvedConfig extends Required<Omit<BroappConfig, 'csp'>> {
  readonly csp: Readonly<Record<string, readonly string[]>>;
  readonly root: string;
}

const CONFIG_FILES = ['broapp.config.ts', 'broapp.config.js', 'broapp.config.mjs'];

/** Read and resolve the project's configuration. */
export async function loadConfig(root: string = process.cwd()): Promise<ResolvedConfig> {
  let user: BroappConfig = {};
  for (const candidate of CONFIG_FILES) {
    const path = resolve(root, candidate);
    if (!existsSync(path)) continue;
    const module = (await import(path)) as { default?: BroappConfig };
    user = module.default ?? {};
    break;
  }

  let packageName = 'app';
  const packageJson = resolve(root, 'package.json');
  if (existsSync(packageJson)) {
    const parsed = (await Bun.file(packageJson).json()) as { name?: string };
    if (typeof parsed.name === 'string' && parsed.name !== '') {
      // A scoped name is not a legal filename on Windows and is awkward
      // everywhere else, so the scope is dropped for the executable.
      packageName = parsed.name.replace(/^@[^/]+\//, '');
    }
  }

  return {
    root,
    uiEntry: user.uiEntry ?? 'src/ui/main.tsx',
    uiTemplate: user.uiTemplate ?? 'src/ui/index.html',
    hostEntry: user.hostEntry ?? 'src/host/main.ts',
    pageOut: user.pageOut ?? 'dist/ui.html',
    binaryName: user.binaryName ?? packageName,
    outDir: user.outDir ?? 'release',
    bytecode: user.bytecode ?? true,
    csp: user.csp ?? {},
  };
}

/** Type helper, so `broapp.config.ts` gets completion. */
export function defineConfig(config: BroappConfig): BroappConfig {
  return config;
}
