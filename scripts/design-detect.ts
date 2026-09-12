#!/usr/bin/env bun
/**
 * The design detector, over the pages this repository actually renders.
 *
 * `scripts/theme-check.ts` measures what a browser computes for a handful of
 * pairs it was told about: one button, one select, the text on a card. That is
 * a check of the token contract, not of the page. Impeccable's detector is 61
 * deterministic rules with no model behind them, and run over the same pages it
 * reads every text-on-background pair there is — which is how four contrast
 * failures in the gallery's own frame survived 12g.
 *
 *   bun run design-detect
 *
 * It scans the theme gallery and every harness page `theme-check` built, and
 * fails on a primary finding. Advisory findings are printed and never fail:
 * that is the detector's own contract, and honouring it is what keeps this
 * usable in CI.
 *
 * `--no-config` is deliberate. A project config could waive a rule quietly, and
 * a waiver nobody reads is worse than a failure nobody wanted; an ignore has to
 * be argued for in a report, not in a JSON file.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One finding, as the detector's JSON reports it. */
interface Finding {
  readonly antipattern: string;
  readonly name: string;
  readonly description: string;
  readonly severity: string;
  readonly category: string;
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/** The pages to scan, in the order a person would look at them. */
const TARGETS: readonly string[] = [
  join('packages', 'broapp-autoapp', '.broapp-tmp', 'theme-gallery.html'),
  join('.broapp-tmp', 'theme-check', 'starter.html'),
  join('.broapp-tmp', 'theme-check', 'quiet.html'),
  join('.broapp-tmp', 'theme-check', 'override.html'),
];

/** What one detector run said. */
interface Run {
  readonly findings: readonly Finding[];
  readonly code: number;
}

/**
 * One detector run over every file.
 *
 * Exit 0 means no primary finding, 2 means at least one, and 1 means a target
 * could not be read at all — which is a failure of this script's own list, not
 * of the pages, so it is reported as one.
 */
async function detect(files: readonly string[], advisory: boolean): Promise<Run> {
  const child = Bun.spawn(
    ['bun', 'x', 'impeccable', 'detect', '--no-config', '--json', ...(advisory ? [] : ['--no-advisory']), ...files],
    { cwd: repo, stdout: 'pipe', stderr: 'ignore' },
  );
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  const trimmed = text.trim();
  const findings = trimmed === '' ? [] : (JSON.parse(trimmed) as Finding[]);
  return { findings, code };
}

/** A finding on one line, with the file it is in. */
function line(finding: Finding): string {
  const where = finding.file === '' ? '' : `${relative(repo, finding.file)} `;
  return `  ${where}[${finding.antipattern}] ${finding.snippet}\n      ${finding.description}`;
}

/** What makes two findings the same finding. */
function key(finding: Finding): string {
  return `${finding.file}|${finding.antipattern}|${finding.snippet}|${String(finding.line)}`;
}

async function main(): Promise<number> {
  const present = TARGETS.filter((path) => existsSync(join(repo, path)));
  const missing = TARGETS.filter((path) => !existsSync(join(repo, path)));
  for (const path of missing) {
    console.log(`skipped ${path} — not built; run theme-gallery and theme-check first`);
  }
  if (present.length === 0) {
    console.error('design-detect  nothing to scan. Build the gallery and the harness pages first.');
    return 1;
  }

  const primary = await detect(present, false);
  const all = await detect(present, true);
  if (primary.code === 1 || all.code === 1) {
    console.error('design-detect  a target could not be scanned');
    return 1;
  }

  const primaryKeys = new Set(primary.findings.map(key));
  const advisories = all.findings.filter((finding) => !primaryKeys.has(key(finding)));

  for (const path of present) console.log(`scanned ${path}`);
  if (advisories.length > 0) {
    console.log(`\nadvisory (${String(advisories.length)}, never a failure):`);
    for (const finding of advisories) console.log(line(finding));
  }
  if (primary.findings.length === 0) {
    console.log(`\ndesign-detect  ${String(present.length)} pages, no primary findings`);
    return 0;
  }
  console.error(`\ndesign-detect  ${String(primary.findings.length)} primary findings:`);
  for (const finding of primary.findings) console.error(line(finding));
  return 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
