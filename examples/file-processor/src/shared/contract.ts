/**
 * File Processor — contract.
 *
 * This is the example most likely to be copied into something real, so it is
 * also the one most worth reading carefully.
 *
 * ## How file paths get here
 *
 * They are not chosen in the browser. A browser `<input type="file">` gives
 * JavaScript a `File` object and deliberately withholds its absolute path —
 * that is a privacy boundary in the browser, not an oversight, and no amount of
 * work in the page gets around it. A browser-picked file therefore cannot be
 * named to the host at all.
 *
 * What this application does instead is what a local application should do:
 * the *host* owns a single authorized root directory, chosen when it starts
 * (`--root`, defaulting to a folder inside the application's own data
 * directory). The browser may list what is inside that root and name files
 * **relative** to it. The host resolves each name against the root and refuses
 * anything that lands outside — after resolution, so `..`, an absolute path,
 * and a symlink pointing elsewhere are all caught by the same check.
 *
 * The browser never supplies a path. It supplies a name inside a boundary the
 * host already agreed to.
 */
import { defineContract, s } from 'broapp/shared';

/**
 * A name relative to the authorized root.
 *
 * This is a first filter, not the security boundary: the host resolves and
 * re-checks every name regardless. Rejecting the obvious cases here produces a
 * better message and keeps clearly malformed input away from filesystem calls.
 */
const relativePath = s.string({ min: 1, max: 512 });

export const contract = defineContract({
  operations: {
    'workspace.describe': {
      summary: 'The authorized root and how it was chosen.',
      input: s.void(),
      output: s.object({
        root: s.string(),
        /** True when the root came from --root rather than the default. */
        explicit: s.boolean(),
        outputDirName: s.string(),
      }),
    },

    'workspace.list': {
      summary: 'Text files directly inside the authorized root.',
      input: s.void(),
      output: s.object({
        files: s.array(
          s.object({
            name: s.string(),
            sizeBytes: s.number(),
            modifiedAt: s.number(),
          }),
          { max: 5_000 },
        ),
        /** True when the listing hit its cap and was cut short. */
        truncated: s.boolean(),
      }),
    },
  },

  streams: {
    /**
     * Count lines, words and characters across the named files.
     *
     * Writes a report into `<root>/<outputDirName>`. It never overwrites: a
     * name that already exists gets a numbered suffix. Cancelling deletes the
     * partial report, because a half-written report that looks complete is
     * worse than no report at all.
     */
    'process.count': {
      summary: 'Summarise the named files, with progress, cancellable.',
      params: s.object({
        files: s.array(relativePath, { min: 1, max: 500 }),
      }),
      event: s.object({
        kind: s.enum(['progress', 'skipped', 'finished']),
        completed: s.number(),
        total: s.number(),
        /** The file this event is about, when it is about one. */
        file: s.nullable(s.string()),
        /** Why a file was skipped. Public text, safe to display. */
        note: s.nullable(s.string()),
        totals: s.object({
          files: s.number(),
          lines: s.number(),
          words: s.number(),
          characters: s.number(),
        }),
        /** On the final event: where the report was written, relative to the root. */
        reportPath: s.nullable(s.string()),
      }),
    },
  },
});
