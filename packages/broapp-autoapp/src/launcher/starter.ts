/**
 * Writing the starter workspace onto somebody's disk.
 *
 * The launcher carries one application inside its binary — `templates/
 * autoapp-starter`, packed by `scripts/build-template.ts` — so that a person
 * who downloaded a binary and has no source workspace still has somewhere to
 * start. What comes out is an ordinary Autoapp source workspace: once it is on
 * disk it is imported in every sense that matters, and every existing command
 * and tool works on it.
 *
 * Two properties are load-bearing.
 *
 * **Nothing pre-existing is destroyed.** `target` is made with a
 * non-recursive `mkdirSync`, so a directory that already exists is an `EEXIST`
 * the caller turns into a conflict rather than something this overwrites.
 *
 * **No shell, and no value that can escape its file.** Substitution is
 * `replaceAll` over five markers. A name is arbitrary text a person typed, so
 * the value is encoded for the file it is going into — JSON-escaped in a
 * `.json`, entity-escaped in an `.html` — because `"` in a name would
 * otherwise produce a manifest that does not parse. The markers are kept out
 * of TypeScript string literals entirely; see the comment at the top of the
 * template's `views.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The starter, as the binary carries it: relative path to UTF-8 text. */
export interface StarterTemplate {
  readonly files: Readonly<Record<string, string>>;
}

/** What is substituted into it. */
export interface StarterValues {
  readonly appId: string;
  readonly name: string;
  readonly description: string;
  /** The `broapp` range this launcher was built against. */
  readonly broappVersion: string;
  /** The `broapp-autoapp` range, `^` plus this package's own version. */
  readonly autoappVersion: string;
}

/** The five markers. One list, so a new one cannot be missed by the check. */
export const STARTER_MARKERS: readonly string[] = [
  '__APP_ID__',
  '__APP_NAME__',
  '__APP_DESCRIPTION__',
  '__BROAPP_VERSION__',
  '__AUTOAPP_VERSION__',
];

/** Files whose contents get substitution. Everything else is written verbatim. */
const SUBSTITUTED = /\.(?:ts|tsx|json|md|html|css)$/;

/** A value as it may appear inside a JSON string. */
function forJson(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, -1);
}

/** A value as it may appear in HTML text. */
function forHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Substitute the five markers into one file's text. */
function substitute(text: string, path: string, values: StarterValues): string {
  const encode = path.endsWith('.json') ? forJson : path.endsWith('.html') ? forHtml : (v: string) => v;
  return text
    .replaceAll('__APP_ID__', encode(values.appId))
    .replaceAll('__APP_NAME__', encode(values.name))
    .replaceAll('__APP_DESCRIPTION__', encode(values.description))
    .replaceAll('__BROAPP_VERSION__', encode(values.broappVersion))
    .replaceAll('__AUTOAPP_VERSION__', encode(values.autoappVersion));
}

/**
 * Substitute the template and write it into `target`.
 *
 * `target` must not exist: the `mkdirSync` is non-recursive and its `EEXIST`
 * is left to propagate, which is what makes two creations of the same id a
 * race one of them loses rather than one overwriting the other.
 *
 * Returns the relative paths written, in the order they were written.
 */
export function writeStarter(
  template: StarterTemplate,
  target: string,
  values: StarterValues,
): readonly string[] {
  mkdirSync(target);

  const written: string[] = [];
  for (const [relative, contents] of Object.entries(template.files)) {
    const text = SUBSTITUTED.test(relative) ? substitute(contents, relative, values) : contents;
    // A marker that survived is a template this code does not fully understand.
    // Written that way it would reach a person as `__APP_NAME__` on their own
    // screen, so it stops here instead.
    for (const marker of STARTER_MARKERS) {
      if (text.includes(marker)) {
        throw new Error(`the template marker ${marker} was not substituted in ${relative}`);
      }
    }
    const path = join(target, ...relative.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
    written.push(relative);
  }
  return written;
}
