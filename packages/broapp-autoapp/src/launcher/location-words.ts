/**
 * Every sentence about where an application's workspace lives.
 *
 * One module, so that the route, the command line, the engineer's tools and
 * the launcher's page cannot say the same thing four different ways — and so
 * that a person who reads one of them in a terminal recognises it in the page.
 * It imports nothing from `node:`: the page draws some of these, and a module
 * the page bundles cannot reach the file system.
 *
 * Each sentence says what the rule is or what happened, and what a person can
 * do about it. No error codes and no stack: whoever reads these is deciding
 * where to put their project, not debugging the launcher.
 */

/** Where the macOS sentence about protected folders is added. */
export type WordsPlatform = 'darwin' | 'other';

export const LOCATION_WORDS = {
  notAbsolute: (input: string): string =>
    `A folder has to be given as a full path, such as /Users/you/Projects. "${input}" is not one.`,
  /**
   * A NUL character in a path. Not in the prompt's table of words: no file
   * system accepts one, and the sentence for "not a full path" would be
   * wrong about why this was refused.
   */
  nul: (): string => 'A folder’s path cannot contain a NUL character. Write the path again.',
  otherHome: (input: string): string =>
    `"${input}" starts with another person’s home folder, which cannot be worked out here. Write the full path.`,
  doesNotExist: (location: string): string =>
    `${location} does not exist. Choose a folder that is already there; the application’s own folder is made inside it.`,
  notADirectory: (location: string): string => `${location} is a file, not a folder.`,
  notWritable: (location: string, platform: WordsPlatform): string =>
    `Nothing can be written in ${location}. Choose a folder you can save into.` +
    (platform === 'darwin'
      ? ' If it is in Desktop, Documents or Downloads, the system may not have given the launcher permission to use it.'
      : ''),
  insideRoot: (location: string): string =>
    `${location} is inside the launcher’s own folder. Leave the choice empty to keep the application there, or choose somewhere else.`,
  insideWorkspace: (location: string, otherAppId: string): string =>
    `${location} is inside the workspace of ${otherAppId}. Choose a folder that is not part of another application.`,
  targetExists: (target: string): string =>
    `${target} already exists. Choose another folder, or move or rename that one first.`,
  diskFull: (target: string): string =>
    `There was not enough room at ${target} to write the application. What was written is still there.`,
  pathTooLong: (target: string): string =>
    `${target} is a longer path than this system allows. Choose a folder nearer the top of the drive.`,
  readOnly: (location: string): string => `${location} is on a volume that cannot be written to.`,
  synced: (location: string): string =>
    `${location} looks like a folder that is synced to the cloud. The application will work, but installing its dependencies there can be slow.`,
  created: (target: string): string => `the workspace is at ${target}`,
  missing: (dir: string, name: string): string =>
    `Its workspace at ${dir} cannot be found. It may have been moved, renamed or deleted, or be on a drive that is not connected. ${name} still opens; it cannot be changed until the folder is back or you say where it went.`,
  notADirectoryState: (dir: string): string =>
    `${dir} is where its workspace should be, and it is a file.`,
  denied: (dir: string): string =>
    `Its workspace at ${dir} cannot be read. The system has not given the launcher permission to use that folder.`,
  unreadable: (appId: string, reason: string): string =>
    `The file that says where ${appId}’s workspace is cannot be read (${reason}). Use Locate, or broapp-autoapp locate, to say where it is.`,
  removalLeft: (dir: string): string => `Its workspace at ${dir} was left where it is.`,
  removalMissing: (dir: string): string =>
    `Its workspace at ${dir} could not be found, and nothing there was touched.`,
  locateWrong: (sourceDir: string, appId: string): string =>
    `${sourceDir} does not hold ${appId}: there is no autoapp.json there with that id.`,
  locateWrongOwner: (sourceDir: string, appId: string, owner: string): string =>
    `${sourceDir} does not hold ${appId}: there is no autoapp.json there with that id. The one there belongs to ${owner}.`,
  locateDefault: (appId: string): string =>
    `${appId}’s workspace is in the launcher’s own folder and is not moved from here.`,
} as const;

/** The states a workspace can be found in, as the list reports them. */
export const WORKSPACE_STATES = ['present', 'missing', 'not-a-directory', 'unreadable', 'denied'] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/**
 * The sentence for a workspace that is not `present`, or `null` when it is.
 *
 * `name` is the application's name as a person knows it, and `appId` its id;
 * `dir` is where the workspace should be, or `null` when the pointer that
 * would have said so could not be read.
 */
export function workspaceSentence(input: {
  readonly state: WorkspaceState;
  readonly appId: string;
  readonly name: string;
  readonly dir: string | null;
  readonly reason?: string;
}): string | null {
  const dir = input.dir ?? input.appId;
  switch (input.state) {
    case 'present':
      return null;
    case 'missing':
      return LOCATION_WORDS.missing(dir, input.name);
    case 'not-a-directory':
      return LOCATION_WORDS.notADirectoryState(dir);
    case 'denied':
      return LOCATION_WORDS.denied(dir);
    case 'unreadable':
      return LOCATION_WORDS.unreadable(input.appId, input.reason ?? 'it is not what it should be');
  }
}
