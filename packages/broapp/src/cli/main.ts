#!/usr/bin/env bun
/**
 * The `broapp` command.
 *
 * Three subcommands, and no plugin system: `dev`, `build`, and `build --page`
 * for the rare case where only the UI needs rebuilding.
 */
import { runDev } from './dev.ts';
import { buildPage } from './build-page.ts';
import { buildBinary } from './build-binary.ts';
import { loadConfig } from './config.ts';
import { currentTarget, TARGETS } from './targets.ts';

const VERSION = '0.1.0';

const USAGE = `broapp ${VERSION} — build tooling for local Bun + Brobridge applications

Usage:
  broapp dev [--no-open]              Watch, rebuild and restart the host
  broapp build [options]              Build the UI and compile the executable
  broapp build --page                 Build the UI document only

Build options:
  --target <id>       Compile for one target. Repeatable. Default: this machine.
  --all-targets       Compile every supported target.
  --out-dir <path>    Where executables go. Default: release
  --no-minify         Keep the bundle readable.
  --no-bytecode       Skip bytecode compilation.

Common:
  -h, --help          Show this message.
  -v, --version       Show the version.

Targets: ${TARGETS.map((target) => target.id).join(', ')}

Cross-compiled binaries are built, not run. Only a binary compiled for the
machine that built it has been executed by this command.`;

interface Flags {
  readonly command: string;
  readonly targets: string[];
  readonly allTargets: boolean;
  readonly outDir: string | undefined;
  readonly pageOnly: boolean;
  readonly minify: boolean;
  readonly bytecode: boolean;
  readonly open: boolean;
}

function parse(argv: readonly string[]): Flags | { readonly help: true } | { readonly version: true } {
  const targets: string[] = [];
  let command = '';
  let allTargets = false;
  let outDir: string | undefined;
  let pageOnly = false;
  let minify = true;
  let bytecode = true;
  let open = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    switch (argument) {
      case '-h':
      case '--help':
        return { help: true };
      case '-v':
      case '--version':
        return { version: true };
      case '--all-targets':
        allTargets = true;
        break;
      case '--page':
        pageOnly = true;
        break;
      case '--no-minify':
        minify = false;
        break;
      case '--no-bytecode':
        bytecode = false;
        break;
      case '--no-open':
        open = false;
        break;
      case '--target': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--target needs a value');
        targets.push(value);
        index += 1;
        break;
      }
      case '--out-dir': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--out-dir needs a value');
        outDir = value;
        index += 1;
        break;
      }
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option ${JSON.stringify(argument)}`);
        if (command === '') command = argument;
        else throw new Error(`unexpected argument ${JSON.stringify(argument)}`);
    }
  }
  return { command, targets, allTargets, outDir, pageOnly, minify, bytecode, open };
}

async function main(): Promise<number> {
  let flags: ReturnType<typeof parse>;
  try {
    flags = parse(process.argv.slice(2));
  } catch (cause) {
    console.error(String(cause instanceof Error ? cause.message : cause));
    console.error('\nRun `broapp --help`.');
    return 2;
  }

  if ('help' in flags) {
    console.log(USAGE);
    return 0;
  }
  if ('version' in flags) {
    console.log(VERSION);
    return 0;
  }
  if (flags.command === '') {
    console.log(USAGE);
    return 2;
  }

  const config = await loadConfig();

  if (flags.command === 'dev') {
    return await runDev({ config, open: flags.open });
  }

  if (flags.command === 'build') {
    const page = await buildPage({
      root: config.root,
      entry: config.uiEntry,
      template: config.uiTemplate,
      outFile: config.pageOut,
      minify: flags.minify,
      csp: config.csp,
    });
    console.log(`ui  ${config.pageOut}  ${(page.bytes / 1024).toFixed(1)} KiB`);
    if (flags.pageOnly) return 0;

    const targets = flags.allTargets
      ? TARGETS.map((target) => target.id)
      : flags.targets.length > 0
        ? flags.targets
        : [currentTarget().id];

    const built = await buildBinary({
      root: config.root,
      entry: config.hostEntry,
      name: config.binaryName,
      outDir: flags.outDir ?? config.outDir,
      targets,
      minify: flags.minify,
      bytecode: flags.bytecode && config.bytecode,
    });
    for (const binary of built) {
      console.log(
        `bin ${binary.path}  ${(binary.bytes / 1024 / 1024).toFixed(1)} MiB  ${binary.target.label}${binary.native ? '' : '  (cross-compiled, not run)'}`,
      );
    }
    return 0;
  }

  console.error(`unknown command ${JSON.stringify(flags.command)}\n`);
  console.error(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? (cause.stack ?? cause.message) : cause));
    process.exit(1);
  },
);
