/**
 * File Processor — host.
 *
 * Every filesystem call goes through `resolveInside`, and nothing here accepts
 * a path from the browser that is not first resolved against the authorized
 * root.
 */
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { createHostApp, publicError } from 'broapp/host';

import { contract } from '../shared/contract.ts';
import { resolveInside, type Workspace } from './workspace.ts';

/** Extensions this example is willing to read. */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.tsv', '.yaml', '.yml']);

/** Largest file this example will read into memory at once. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Cap on a directory listing, so an enormous folder cannot stall the host. */
const LIST_CAP = 5_000;

export function createApp(workspace: Workspace) {
  const app = createHostApp(contract);

  app.operation('workspace.describe', () => ({
    root: workspace.root,
    explicit: workspace.explicit,
    outputDirName: workspace.outputDirName,
  }));

  app.operation('workspace.list', async () => {
    const entries = await readdir(workspace.root, { withFileTypes: true }).catch(() => {
      throw publicError.unavailable('The folder this application reads is not available.');
    });

    const files: { name: string; sizeBytes: number; modifiedAt: number }[] = [];
    let truncated = false;

    for (const entry of entries) {
      if (files.length >= LIST_CAP) {
        truncated = true;
        break;
      }
      // Not recursive, and no symlinks: both would take the listing outside the
      // shape the interface presents, and the second could take it outside the
      // root entirely.
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !TEXT_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue;

      const info = await stat(join(workspace.root, entry.name)).catch(() => null);
      if (info === null) continue;
      files.push({ name: entry.name, sizeBytes: info.size, modifiedAt: info.mtimeMs });
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    return { files, truncated };
  });

  app.stream('process.count', async ({ files }, sink) => {
    const outputDir = join(workspace.root, workspace.outputDirName);
    await mkdir(outputDir, { recursive: true });

    const totals = { files: 0, lines: 0, words: 0, characters: 0 };
    const rows: string[] = ['file\tlines\twords\tcharacters'];
    let completed = 0;

    for (const name of files) {
      if (sink.signal.aborted) return;

      let note: string | null = null;
      try {
        const path = await resolveInside(workspace, name, { existing: true });
        const info = await stat(path);
        if (!info.isFile()) {
          note = 'Not a file.';
        } else if (info.size > MAX_FILE_BYTES) {
          note = 'Too large for this example to read.';
        } else {
          const text = await Bun.file(path).text();
          const counted = count(text);
          totals.files += 1;
          totals.lines += counted.lines;
          totals.words += counted.words;
          totals.characters += counted.characters;
          rows.push(
            `${name}\t${String(counted.lines)}\t${String(counted.words)}\t${String(counted.characters)}`,
          );
        }
      } catch (cause) {
        // A refusal from `resolveInside` is already public text. Anything else
        // could name a path, so it becomes a fixed message and the file is
        // recorded as skipped rather than failing the whole run.
        note =
          cause instanceof Error && cause.name === 'PublicError'
            ? cause.message
            : 'Could not be read.';
      }

      completed += 1;
      await sink.emit({
        kind: note === null ? 'progress' : 'skipped',
        completed,
        total: files.length,
        file: name,
        note,
        totals: { ...totals },
        reportPath: null,
      });
    }

    if (sink.signal.aborted) return;

    // Written only after every file is done, so a cancelled run leaves nothing
    // behind that could be mistaken for a finished report.
    const reportName = await uniqueName(outputDir, `report-${stamp()}.tsv`);
    const reportPath = join(outputDir, reportName);
    await writeFile(reportPath, `${rows.join('\n')}\n`, 'utf8');

    if (sink.signal.aborted) {
      // Cancelled between the write and the send: remove it rather than leave
      // a report nobody asked for.
      await rm(reportPath, { force: true });
      return;
    }

    await sink.emit({
      kind: 'finished',
      completed,
      total: files.length,
      file: null,
      note: null,
      totals: { ...totals },
      reportPath: relative(workspace.root, reportPath),
    });
  });

  return app;
}

function count(text: string): { lines: number; words: number; characters: number } {
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  const lines = text === '' ? 0 : text.split('\n').length;
  return { lines, words, characters: text.length };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * A name that does not exist yet.
 *
 * The default is never to overwrite a user's file. `wx` makes the check and the
 * claim one atomic step, so two runs finishing at once cannot pick the same
 * name.
 */
async function uniqueName(directory: string, preferred: string): Promise<string> {
  const dot = preferred.lastIndexOf('.');
  const base = dot < 0 ? preferred : preferred.slice(0, dot);
  const extension = dot < 0 ? '' : preferred.slice(dot);

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const name = attempt === 0 ? preferred : `${base}-${String(attempt)}${extension}`;
    try {
      const handle = await open(join(directory, name), 'wx');
      await handle.close();
      return name;
    } catch {
      // Taken; try the next suffix.
    }
  }
  throw publicError.conflict('Could not find an unused name for the report.');
}
