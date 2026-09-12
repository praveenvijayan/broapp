/**
 * Writing a starter workspace onto somebody's disk.
 *
 * The launcher carries two applications inside its binary — `templates/
 * autoapp-starter` and `templates/autoapp-blank`, packed by
 * `scripts/build-template.ts` — so that a person who downloaded a binary and
 * has no source workspace still has somewhere to start: a list of items to take
 * apart, or one empty page to describe to the engineer. What comes out is an ordinary Autoapp source workspace: once it is on
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
 * `.json` or a `.ts`, entity-escaped in an `.html` — because `"` in a name
 * would otherwise produce a manifest, or a module, that does not parse. The
 * starter keeps its markers out of TypeScript entirely anyway; the blank's one
 * page is titled with the name, inside a double-quoted literal, which is what
 * the JSON encoding is exactly right for.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One template, as the binary carries it: relative path to UTF-8 text. */
export interface StarterTemplate {
  readonly files: Readonly<Record<string, string>>;
}

/** The templates a person may choose between. */
export const TEMPLATE_NAMES = ['starter', 'blank'] as const;

/** Which one. `starter` is the default everywhere, so nothing existing changes. */
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * Both templates, as the binary carries them.
 *
 * One file rather than two: they are packed together, shipped together and
 * read together, and a launcher carrying one of them and not the other is a
 * **New application** button with a choice it cannot honour.
 */
export type Templates = Readonly<Record<TemplateName, StarterTemplate>>;

/** Whether a value names a template. Used where one arrives as text. */
export function isTemplateName(value: unknown): value is TemplateName {
  return (TEMPLATE_NAMES as readonly unknown[]).includes(value);
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

/**
 * A value as it may appear inside a JSON string — and inside a double-quoted
 * JavaScript one, which is the same grammar.
 *
 * The starter keeps every marker out of TypeScript. The blank cannot: its one
 * page is titled with the application's name, and a page has to be called
 * something. So the encoding is applied to `.ts` and `.tsx` as well, and the
 * marker in `templates/autoapp-blank/src/shared/views.ts` sits inside a
 * double-quoted literal, where this output is exactly what belongs.
 */
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
  const encode =
    path.endsWith('.json') || path.endsWith('.ts') || path.endsWith('.tsx')
      ? forJson
      : path.endsWith('.html')
        ? forHtml
        : (v: string) => v;
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
