/**
 * Opening the user's browser.
 *
 * Brobridge does not launch browsers — deliberately, since a launcher is
 * policy, not protocol — so Broapp supplies one. It is the same
 * platform-handler call every tool of this shape makes.
 *
 * The URL carries a one-time launch token. It is passed as a separate `argv`
 * element to a directly spawned executable, never through a shell, so nothing
 * in it can be interpreted as a command and nothing lands in a shell history.
 */

/** Which command opens a URL on this platform. */
function launcher(url: string): string[] | null {
  switch (process.platform) {
    case 'darwin':
      return ['open', url];
    case 'win32':
      // `start` is a `cmd` builtin, so `cmd /c` is unavoidable here. The empty
      // string is `start`'s title argument: without it `start` would read a
      // quoted URL as the window title and open nothing.
      return ['cmd', '/c', 'start', '', url];
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return ['xdg-open', url];
    default:
      return null;
  }
}

/**
 * Try to open `url`. Resolves `false` when no browser could be launched — the
 * caller is expected to have already printed the URL for manual use.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const argv = launcher(url);
  if (argv === null) return false;
  try {
    const child = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
