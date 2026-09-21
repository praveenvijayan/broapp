/**
 * Creating an application from one of the starters in the binary.
 *
 * The other way in is `import`, which takes a source workspace somebody
 * already has. This is for the person who downloaded a binary and has nothing:
 * the launcher writes one out, installs it, builds it and makes it current.
 * After that the two are indistinguishable — a created application is an
 * ordinary source workspace, and every command and every tool works on it.
 *
 * The directory is the lock. `writeStarter` makes it with a non-recursive
 * `mkdirSync`, and `EEXIST` is how two creations of the same id are resolved:
 * the second one loses. Nothing is checked before that, because anything
 * checked first is a window two callers can both pass through.
 *
 * Nothing that fails deletes anything. A half-created directory is somebody's
 * work now — they may have been told to fix their network and try the build
 * again — and a creation that tidies up after itself is a creation that will
 * one day tidy away the wrong thing. There is one exception, for a workspace in
 * a folder the person chose, and it is written down where it happens.
 *
 * A chosen folder (19a) is checked before the lock, because the checks are
 * about the folder rather than the id, and a refusal must not burn the id. The
 * pointer that says where the workspace is goes down only once the workspace
 * has been made by this call — a pointer to a folder somebody else made would
 * hand their folder to the engineer.
 */
import { mkdirSync, rmdirSync, statSync } from 'node:fs';

import { publicError } from 'broapp/host';

import { APP_ID_PATTERN } from '../spec/types.ts';

import type { BuildProblem } from './candidate.ts';
import { LOCATION_WORDS } from './location-words.ts';
import { checkLocation, idProblem, writeFailure, writeLocation, type LocationOptions } from './location.ts';
import { writeStarter, type TemplateName, type Templates } from './starter.ts';
import { adopt, prepareWorkspace, type PrepareOptions } from './workspace.ts';

/** What {@link createApplication} needs. */
export interface CreateOptions extends Omit<PrepareOptions, 'appId'> {
  /** Both starters, as the binary carries them. */
  readonly templates: Templates;
  /** Which one to write. Default `starter`, so an existing caller is unchanged. */
  readonly template?: TemplateName;
  /** The ranges the created workspace depends on. */
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  readonly appId: string;
  readonly name: string;
  readonly description?: string;
  /**
   * The folder a person chose; the workspace is made at `<location>/<appId>`.
   * Absent, it is `<root>/apps/<appId>/source` and no pointer is written, so
   * every caller that does not pass one is exactly as before 19a.
   */
  readonly location?: string;
  /** How `~` and the platform's sentences are worked out; a test replaces them. */
  readonly locationOptions?: LocationOptions;
  /** Write the template. Defaults to {@link writeStarter}; a test replaces it to fail on cue. */
  readonly writeStarter?: typeof writeStarter;
}

/** A created application, or why there is not one. */
export type CreateResult =
  | {
      readonly ok: true;
      readonly releaseId: string;
      readonly installed: boolean;
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly installed: boolean;
      readonly problems: readonly BuildProblem[];
      readonly notes: readonly string[];
    };

/** The longest a name and a description may be, matching the route's schema. */
const MAX_NAME = 200;
const MAX_DESCRIPTION = 400;

/** A one-sentence reason, without a stack. */
function reason(cause: unknown): string {
  return String(cause instanceof Error ? cause.message : cause);
}

/** Write the starter for `appId`, install it, build it, and make it current. */
export async function createApplication(options: CreateOptions): Promise<CreateResult> {
  const { layout: root, appId } = options;

  // Checked here as well as in `layout.app`, because the message a person sees
  // should say what the rule is rather than come out of a path helper.
  if (!APP_ID_PATTERN.test(appId)) {
    throw publicError.invalidInput(idProblem(appId));
  }

  const name = options.name.trim();
  if (name.length < 1 || name.length > MAX_NAME) {
    throw publicError.invalidInput(`A name must be 1 to ${String(MAX_NAME)} characters.`);
  }
  const description = (options.description ?? '').trim();
  if (description.length > MAX_DESCRIPTION) {
    throw publicError.invalidInput(
      `A description may be at most ${String(MAX_DESCRIPTION)} characters.`,
    );
  }

  // 2. The folder, before anything is written. Racy, and that is fine: what is
  //    not racy is the non-recursive `mkdirSync` of the target in step 4.
  let chosen: { readonly location: string; readonly target: string; readonly notes: readonly string[] } | null = null;
  if (options.location !== undefined) {
    const checked = checkLocation(root, appId, options.location, options.locationOptions);
    if (!checked.ok) {
      throw checked.conflict ? publicError.conflict(checked.problem) : publicError.invalidInput(checked.problem);
    }
    chosen = checked;
  }
  const platform = options.locationOptions?.platform ?? (process.platform === 'darwin' ? 'darwin' : 'other');

  const app = root.app(appId);
  // 3. The lock. The parent has to exist for the non-recursive `mkdirSync` below to be
  // about this application rather than about `apps/` being missing.
  mkdirSync(`${root.root}/apps`, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(app.dir, { mode: 0o700 });
  } catch (cause) {
    if ((cause as { code?: string }).code === 'EEXIST') {
      throw publicError.conflict(`${appId} already exists.`);
    }
    throw cause;
  }

  // 4. The workspace. For a chosen folder this is `<location>/<appId>`, and
  //    `layout.app()` would still say `source/` because there is no pointer
  //    yet — which is the point: the pointer follows the workspace, never the
  //    other way round.
  const target = chosen?.target ?? app.source;
  try {
    (options.writeStarter ?? writeStarter)(options.templates[options.template ?? 'starter'], target, {
      appId,
      name,
      description,
      broappVersion: options.versions.broapp,
      autoappVersion: options.versions.autoapp,
    });
  } catch (cause) {
    if (chosen === null) {
      // Reported rather than thrown: the directory exists now, and a person
      // whose id has been taken should see a sentence saying why rather than an
      // id that is silently burnt.
      return { ok: false, installed: false, problems: [{ stage: 'spec', message: reason(cause) }], notes: [] };
    }
    const message = writeFailure(cause, chosen.location, target, platform);
    let made = false;
    try {
      made = statSync(target).isDirectory();
    } catch {
      made = false;
    }
    if ((cause as { code?: string }).code === 'EEXIST' || !made) {
      // Somebody made the target between the check and now, so `writeStarter`'s
      // first act — a non-recursive `mkdirSync` — failed and it wrote nothing:
      // the folder is not ours and no pointer may name it. Or nothing was
      // made at all. Either way the id is given back. This is the one
      // exception to "nothing that fails deletes anything", and it is a safe
      // one: `rmdirSync` is not recursive, so it can only remove the empty
      // directory this call made a moment ago — never a byte of anybody's.
      try {
        rmdirSync(app.dir);
      } catch {
        // Not empty means somebody else put something there; it stays.
      }
      if ((cause as { code?: string }).code === 'EEXIST') throw publicError.conflict(message);
      return { ok: false, installed: false, problems: [{ stage: 'spec', message }], notes: [] };
    }
    // The target is ours and half-written: point at it, so the person and
    // the engineer can find what is there, and say what went wrong.
    writeLocation(root, appId, target);
    return {
      ok: false,
      installed: false,
      problems: [{ stage: 'spec', message }],
      notes: [LOCATION_WORDS.created(target)],
    };
  }

  // 5. Only now, with the workspace made by this call, the pointer.
  if (chosen !== null) writeLocation(root, appId, target);
  const locationNotes = chosen === null ? [] : [LOCATION_WORDS.created(target), ...chosen.notes];

  const prepared = await prepareWorkspace({
    layout: root,
    appId,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.install === undefined ? {} : { install: options.install }),
    ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
  });
  if (!prepared.ok) {
    return {
      ok: false,
      installed: prepared.installed,
      problems: prepared.problems,
      notes: [...locationNotes, ...prepared.notes],
    };
  }

  // A starter is not allowed to ask for anything. Nobody read it before it was
  // written, so nobody can be asked to approve what it wants — and a question
  // whose answer is always "yes, whatever it says" is not a question.
  const wanted = prepared.spec.manifest.capabilities;
  if (wanted.length > 0) {
    return {
      ok: false,
      installed: prepared.installed,
      problems: [
        {
          stage: 'spec',
          message: `the starter asks for ${wanted.map((one) => one.kind).join(', ')}; a starter may not ask for a capability, so nothing was made current`,
        },
      ],
      notes: [...locationNotes, ...prepared.notes],
    };
  }

  adopt(root, appId, prepared.releaseId, []);
  return {
    ok: true,
    releaseId: prepared.releaseId,
    installed: prepared.installed,
    notes: [...locationNotes, ...prepared.notes],
  };
}
