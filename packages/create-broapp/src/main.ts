#!/usr/bin/env bun
/**
 * `create-broapp` — the generator.
 *
 * Interactive when stdin is a terminal, fully non-interactive otherwise. The
 * non-interactive path is the one CI and the release dry run use, so it is not
 * a degraded mode: every question has a flag.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, confirm, isInteractive } from './prompt.ts';
import { isUsableDestination, scaffold, type TemplateValues } from './scaffold.ts';
import { checkAppName, checkDestination, suggestName } from './validate.ts';

const VERSION = '0.1.0';

const USAGE = `create-broapp ${VERSION} — scaffold a local application built on Bun and Brobridge

Usage:
  bun create broapp <directory> [options]
  bunx create-broapp <directory> [options]

Options:
  --name <name>        Package and executable name. Default: derived from <directory>.
  --title <title>      Human-readable name shown in the interface. Default: the name.
  --description <text> One-line description for package.json.
  --broapp <range>     Version range for the "broapp" dependency. Default: ^${VERSION}
  --no-install         Skip "bun install". Makes generation work with no network.
  --git                Run "git init" and make one commit. Off by default.
  --yes                Accept every default; never prompt.
  -h, --help           Show this message.
  -v, --version        Show the version.

Examples:
  bun create broapp my-app
  bun create broapp "~/Projects/My App" --name my-app --no-install
  bunx create-broapp ./tmp/app --yes --no-install`;

interface Options {
  directory: string | null;
  name: string | null;
  title: string | null;
  description: string | null;
  broappVersion: string;
  install: boolean;
  git: boolean;
  yes: boolean;
}

function parse(argv: readonly string[]): Options | { readonly exit: number; readonly text: string } {
  const options: Options = {
    directory: null,
    name: null,
    title: null,
    description: null,
    broappVersion: `^${VERSION}`,
    install: true,
    git: false,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    const take = (flag: string): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };

    switch (argument) {
      case '-h':
      case '--help':
        return { exit: 0, text: USAGE };
      case '-v':
      case '--version':
        return { exit: 0, text: VERSION };
      case '--no-install':
        options.install = false;
        break;
      case '--install':
        options.install = true;
        break;
      case '--git':
        options.git = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--name':
        options.name = take('--name');
        break;
      case '--title':
        options.title = take('--title');
        break;
      case '--description':
        options.description = take('--description');
        break;
      case '--broapp':
        options.broappVersion = take('--broapp');
        break;
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option ${JSON.stringify(argument)}`);
        if (options.directory !== null) {
          throw new Error(`unexpected argument ${JSON.stringify(argument)}; the destination was already given`);
        }
        // Taken as a single argv element, so a path with spaces needs quoting
        // by the shell and nothing else. Nothing here re-splits it.
        options.directory = argument;
    }
  }
  return options;
}

/**
 * Where the template lives.
 *
 * Inside the published package it sits beside the source. Inside the
 * repository it is two levels up, in `templates/`. Both are checked so the
 * generator behaves identically run from a packed tarball and from a checkout
 * — which is what makes the workspace-source test meaningful.
 */
function findTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'template'),
    resolve(here, '..', '..', '..', 'templates', 'react-ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(
    `could not find the project template. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

async function run(): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (cause) {
    console.error(String(cause instanceof Error ? cause.message : cause));
    console.error('\nRun `create-broapp --help`.');
    return 2;
  }
  if ('exit' in parsed) {
    console.log(parsed.text);
    return parsed.exit;
  }

  const options = parsed;
  const interactive = isInteractive() && !options.yes;
  const cwd = process.cwd();

  if (options.directory === null) {
    if (!interactive) {
      console.error('A destination directory is required.\n');
      console.error(USAGE);
      return 2;
    }
    options.directory = await ask({
      message: 'Where should the application go?',
      initial: './my-app',
      validate: (value) => {
        const check = checkDestination(value, cwd);
        return check.ok ? null : check.reason;
      },
    });
  }

  const destinationCheck = checkDestination(options.directory, cwd);
  if (!destinationCheck.ok) {
    console.error(`Refusing that destination: ${destinationCheck.reason}`);
    return 2;
  }
  const target = resolve(cwd, options.directory);

  const usable = await isUsableDestination(target);
  if (!usable.ok) {
    console.error(`${target} is not empty. It contains: ${usable.entries.slice(0, 5).join(', ')}${usable.entries.length > 5 ? ', …' : ''}`);
    console.error('Choose a different destination, or empty this one yourself.');
    return 1;
  }

  if (options.name === null) {
    const suggestion = suggestName(options.directory);
    if (interactive) {
      options.name = await ask({
        message: 'Application name',
        initial: suggestion ?? undefined,
        validate: (value) => {
          const check = checkAppName(value);
          return check.ok ? null : check.reason;
        },
      });
    } else if (suggestion !== null) {
      options.name = suggestion;
    } else {
      console.error(
        `Could not derive an application name from ${JSON.stringify(options.directory)}. Pass --name.`,
      );
      return 2;
    }
  }

  const nameCheck = checkAppName(options.name);
  if (!nameCheck.ok) {
    console.error(`Refusing that name: ${nameCheck.reason}`);
    return 2;
  }

  if (options.title === null) {
    options.title = interactive
      ? await ask({ message: 'Title shown in the interface', initial: titleCase(options.name) })
      : titleCase(options.name);
  }
  options.description ??= `A local application built with Bun, a browser UI, and Brobridge.`;

  if (interactive && options.install) {
    options.install = await confirm('Install dependencies now?', true);
  }

  const values: TemplateValues = {
    appName: options.name,
    // Substituted into HTML and JSX. Angle brackets and ampersands would
    // otherwise land in markup unescaped.
    appTitle: escapeText(options.title),
    appDescription: escapeText(options.description),
    broappVersion: options.broappVersion,
  };

  const template = findTemplate();
  console.log(`\nCreating ${values.appName} in ${target}`);

  const result = await scaffold(template, target, values);
  console.log(`  ${String(result.files.length)} files written`);

  if (options.install) {
    console.log('  installing dependencies…');
    const child = Bun.spawn(['bun', 'install'], { cwd: target, stdout: 'inherit', stderr: 'inherit' });
    if ((await child.exited) !== 0) {
      // A failed install leaves a perfectly good project behind. Deleting it
      // would be worse than telling the developer what to run.
      console.error('\nDependency installation failed. The project was still created.');
      console.error(`Run "bun install" in ${target} once the problem is fixed.`);
      return 1;
    }
  }

  if (options.git) {
    const initialised = await gitInit(target, values.appName);
    if (!initialised) console.error('  git init failed; the project is fine, it is just not a repository');
  }

  const where = relativeOrAbsolute(cwd, target);
  console.log(`
Done.

  cd ${quoteForShell(where)}${options.install ? '' : '\n  bun install'}
  bun run dev

"bun run dev" builds the interface, starts the host, and opens your browser.
"bun run build" compiles a single-file executable into ./release.

The application binds to the loopback interface only, and its address carries
a one-time token. See README.md for what that does and does not protect.`);

  return 0;
}

/** `git init` plus one commit. Only ever run when `--git` was passed. */
async function gitInit(directory: string, name: string): Promise<boolean> {
  const steps: string[][] = [
    ['git', 'init', '--quiet'],
    ['git', 'add', '--all'],
    ['git', 'commit', '--quiet', '--message', `Create ${name} with create-broapp`],
  ];
  for (const argv of steps) {
    const child = Bun.spawn(argv, { cwd: directory, stdout: 'ignore', stderr: 'ignore' });
    if ((await child.exited) !== 0) return false;
  }
  return true;
}

function titleCase(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Make text safe to drop into HTML and JSX text nodes. */
function escapeText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

function relativeOrAbsolute(from: string, to: string): string {
  const relative = to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to;
  return relative === '' ? to : relative;
}

/** Quote a path for the copy-pasteable `cd` line. Display only; nothing runs it. */
function quoteForShell(path: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(path) ? path : `'${path.replaceAll("'", String.raw`'\''`)}'`;
}

run().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? (cause.stack ?? cause.message) : cause));
    process.exit(1);
  },
);
