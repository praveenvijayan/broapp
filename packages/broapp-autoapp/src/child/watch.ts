/**
 * How a child knows its launcher is still there.
 *
 * Its own module so the supervisor, which sets the variable, and the `stop`
 * command, which asks whether a pid is alive, need not load the child runtime.
 */

/**
 * The environment variable a launcher names itself in when it spawns a child.
 *
 * Its pid, given at spawn rather than read from `process.ppid`: on Windows, and
 * under a shell that wraps the command, the parent process is not always the
 * launcher. A child started without it — a test spawning `--child` itself —
 * has no launcher to watch and watches nothing.
 */
export const LAUNCHER_PID_ENV = 'AUTOAPP_LAUNCHER_PID';
/** How often a child checks that its launcher is still there. */
export const LAUNCHER_WATCH_MS = 3_000;
/**
 * Whether a process is alive. `kill(pid, 0)` sends nothing and only asks;
 * `EPERM` means it exists and belongs to somebody else, which is alive.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: unknown }).code === 'EPERM';
  }
}
