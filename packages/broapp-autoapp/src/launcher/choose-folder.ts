/**
 * The system's own folder window, for the New application form.
 *
 * A person choosing where their project lives should get the dialog they
 * already know rather than a folder browser drawn in the page, which would
 * need a route that lists their directories. So the launcher, which runs on
 * their computer, asks the operating system for one and hands back the path.
 *
 * Nothing about this is trusted. The starting folder is a string from a page,
 * and it reaches the dialog only as one whole argument or one environment
 * value, never as script text: every script below is a constant, and a test
 * reads the argv to hold that. What comes back is a string like any other —
 * the form sends it through `launcher.locationCheck`, and creation checks it
 * again — so a dialog that answered something odd can mislead nobody.
 *
 * And nothing about it may strand the form. A missing program, a remote
 * session with no display, a dialog that fails: each is `available: false`,
 * and the form offers a typed path. Cancel is `chosen: null`. A window left
 * open is killed after five minutes, and the launcher stopping kills it too.
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { publicError } from 'broapp/host';
import type { HostLogger } from 'broapp/host';

import { LOCATION_WORDS } from './location-words.ts';

/** What the route answers. */
export interface FolderChoice {
  /** Whether there is a folder window on this computer at all. */
  readonly available: boolean;
  /** The folder chosen, or `null` when the person cancelled or nothing came back. */
  readonly chosen: string | null;
}

/** One way to open the window: the program and its arguments, and what goes in its environment. */
export interface ChooserCommand {
  readonly cmd: readonly string[];
  /** Added to the launcher's own environment, never replacing it. */
  readonly env: Readonly<Record<string, string>>;
  /** Which dialog it is, because each says "cancelled" differently. */
  readonly kind: 'osascript' | 'powershell' | 'zenity' | 'kdialog';
}

/** A running dialog, as the chooser sees it. */
export interface ChooserProcess {
  readonly done: Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  kill(): void;
}

/**
 * Start one dialog. Throws when the program is not there — Bun's own spawn
 * throws `ENOENT` for that — which the chooser reads as "no dialog here".
 */
export type SpawnChooser = (command: ChooserCommand) => ChooserProcess;

/** Everything a test replaces, so no test opens a window. */
export interface FolderChooserOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether a program is on the path. Linux asks it which dialog it has. */
  readonly which?: (program: string) => string | null;
  readonly spawn?: SpawnChooser;
  /** How long a window may stay open before it is closed for the person. */
  readonly deadlineMs?: number;
  readonly logger?: HostLogger;
}

/** The chooser the route holds: one window at a time, and a way to close it. */
export interface FolderChooser {
  choose(startAt?: string): Promise<FolderChoice>;
  /** Close a window that is open, as the launcher stops. Harmless when none is. */
  stop(): void;
}

/** Five minutes: long enough to find a folder, short enough that a forgotten window does not hold the route. */
export const FOLDER_WINDOW_DEADLINE_MS = 5 * 60_000;

/** The title the window shows. A constant, like every script here. */
export const FOLDER_PROMPT = 'Choose the folder to make the application in';

/**
 * AppleScript for macOS. The prompt and the starting folder arrive through
 * `on run argv`, so neither is ever part of the text osascript compiles.
 *
 * `activate` makes osascript itself the front application, which brings the
 * window forward without asking the person for anything: it names no other
 * application, so no automation permission is involved. `System Events`
 * would bring it forward too, at the price of that question.
 */
const MAC_SCRIPT = [
  'on run argv',
  'activate',
  'set thePrompt to item 1 of argv',
  'if (count of argv) > 1 then',
  'set theFolder to choose folder with prompt thePrompt default location (POSIX file (item 2 of argv))',
  'else',
  'set theFolder to choose folder with prompt thePrompt',
  'end if',
  'return POSIX path of theFolder',
  'end run',
] as const;

/**
 * PowerShell for Windows. The two values are read from the environment, so the
 * script is the same bytes whatever they hold; a cancelled dialog writes
 * nothing and exits 0.
 */
const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:AUTOAPP_FOLDER_PROMPT',
  '$dialog.ShowNewFolderButton = $true',
  'if ($env:AUTOAPP_FOLDER_START) { $dialog.SelectedPath = $env:AUTOAPP_FOLDER_START }',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
].join('; ');

/**
 * How to open the window on one platform, or `null` when there is none.
 *
 * Pure, so a test can read exactly what would be spawned. `startAt` is used
 * as given: the chooser has already dropped one that is not a folder.
 */
export function chooserCommand(
  platform: NodeJS.Platform,
  input: { readonly startAt?: string; readonly prompt?: string },
  host: { readonly env?: Readonly<Record<string, string | undefined>>; readonly which?: (program: string) => string | null } = {},
): ChooserCommand | null {
  const prompt = input.prompt ?? FOLDER_PROMPT;
  const startAt = input.startAt;
  switch (platform) {
    case 'darwin':
      return {
        kind: 'osascript',
        cmd: ['osascript', ...MAC_SCRIPT.flatMap((line) => ['-e', line]), '--', prompt, ...(startAt === undefined ? [] : [startAt])],
        env: {},
      };
    case 'win32':
      return {
        kind: 'powershell',
        cmd: ['powershell', '-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT],
        env: { AUTOAPP_FOLDER_PROMPT: prompt, ...(startAt === undefined ? {} : { AUTOAPP_FOLDER_START: startAt }) },
      };
    default: {
      // A dialog needs somewhere to draw. Over SSH, or in a service, there is
      // nowhere, and a spawn would wait for a window nobody can see.
      const env = host.env ?? {};
      if ((env['DISPLAY'] ?? '') === '' && (env['WAYLAND_DISPLAY'] ?? '') === '') return null;
      const which = host.which ?? ((program: string) => Bun.which(program));
      if (which('zenity') !== null) {
        return {
          kind: 'zenity',
          cmd: [
            'zenity',
            '--file-selection',
            '--directory',
            `--title=${prompt}`,
            ...(startAt === undefined ? [] : [`--filename=${withSeparator(startAt, '/')}`]),
          ],
          env: {},
        };
      }
      if (which('kdialog') !== null) {
        return {
          kind: 'kdialog',
          cmd: ['kdialog', '--title', prompt, '--getexistingdirectory', ...(startAt === undefined ? [] : [startAt])],
          env: {},
        };
      }
      return null;
    }
  }
}

/** `dir` with one separator at its end, so a dialog opens inside it rather than beside it. */
function withSeparator(dir: string, separator: string): string {
  return dir.endsWith(separator) ? dir : `${dir}${separator}`;
}

/**
 * The path a dialog printed, as a folder: its trailing newline gone, and a
 * trailing separator gone unless the separator is all there is (`/`, `C:\`).
 * `null` for nothing at all.
 */
export function trimChosen(output: string): string | null {
  let path = output.replace(/[\r\n]+$/, '');
  if (path.trim() === '') return null;
  while (path.length > 1 && /[/\\]$/.test(path) && !/^[A-Za-z]:[/\\]$/.test(path)) {
    path = path.slice(0, -1);
  }
  return path;
}

/** Whether a dialog's ending was the person pressing Cancel. */
function cancelled(kind: ChooserCommand['kind'], exitCode: number, stdout: string, stderr: string): boolean {
  switch (kind) {
    // osascript reports a cancelled `choose folder` as error -128, "User canceled".
    case 'osascript':
      return exitCode === 1 && /-128\b/.test(stderr);
    // The script writes nothing when the dialog is not answered with OK.
    case 'powershell':
      return exitCode === 0 && stdout.trim() === '';
    case 'zenity':
    case 'kdialog':
      return exitCode === 1;
  }
}

/** A starting folder the dialog can use, or `undefined`: one that is not an existing folder is dropped. */
export function usableStart(startAt: string | undefined): string | undefined {
  if (startAt === undefined || startAt === '' || startAt.includes('\0') || !isAbsolute(startAt)) return undefined;
  try {
    return statSync(startAt).isDirectory() ? startAt : undefined;
  } catch {
    return undefined;
  }
}

/** The real spawn: an argument array, never a shell, with the additions laid over the launcher's environment. */
const spawnDialog: SpawnChooser = (command) => {
  const child = Bun.spawn({
    cmd: [...command.cmd],
    env: { ...process.env, ...command.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    done: Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
    ),
    kill: () => child.kill(),
  };
};

/** The last non-empty line of what a program printed to stderr, for the log. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.at(-1) ?? '(nothing)';
}

/** The launcher's folder chooser. */
export function createFolderChooser(options: FolderChooserOptions = {}): FolderChooser {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnDialog;
  const deadlineMs = options.deadlineMs ?? FOLDER_WINDOW_DEADLINE_MS;
  const logger: HostLogger = options.logger ?? console;
  /** The window that is open, if one is. */
  let open: ChooserProcess | null = null;

  const unavailable: FolderChoice = { available: false, chosen: null };

  return {
    async choose(startAt) {
      // One window at a time: a second one would be a second answer for one
      // form, and a person who pressed twice is better told where the first is.
      if (open !== null) throw publicError.conflict(LOCATION_WORDS.folderWindowOpen());
      const start = usableStart(startAt);
      const command = chooserCommand(
        platform,
        { ...(start === undefined ? {} : { startAt: start }) },
        { env: options.env ?? process.env, ...(options.which === undefined ? {} : { which: options.which }) },
      );
      if (command === null) return unavailable;

      let running: ChooserProcess;
      try {
        running = spawn(command);
      } catch (cause) {
        // The program is not there. Not an error: the form offers a typed path.
        const code = (cause as { code?: unknown } | null)?.code;
        if (code !== 'ENOENT') {
          logger.warn(`[autoapp] the folder window could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        return unavailable;
      }
      open = running;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        running.kill();
      }, deadlineMs);
      try {
        const { exitCode, stdout, stderr } = await running.done;
        // Closed for the person, by the deadline or by the launcher stopping:
        // nothing was chosen, and nothing went wrong.
        if (timedOut || open !== running) return { available: true, chosen: null };
        if (cancelled(command.kind, exitCode, stdout, stderr)) return { available: true, chosen: null };
        if (exitCode !== 0) {
          logger.warn(`[autoapp] the folder window ended with ${String(exitCode)}: ${lastLine(stderr)}`);
          return unavailable;
        }
        const chosen = trimChosen(stdout);
        if (chosen !== null && chosen.length > 1_024) {
          logger.warn('[autoapp] the folder window answered a path longer than the form can take');
          return { available: true, chosen: null };
        }
        return { available: true, chosen };
      } catch (cause) {
        logger.warn(`[autoapp] the folder window failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return unavailable;
      } finally {
        clearTimeout(timer);
        if (open === running) open = null;
      }
    },
    stop() {
      const running = open;
      open = null;
      running?.kill();
    },
  };
}
