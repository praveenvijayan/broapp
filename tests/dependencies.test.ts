/**
 * Dependency invariants.
 *
 * Brobridge releases its four packages in lockstep — `.changeset/config.json`
 * lists them under `fixed`, so `@brobridgejs/core`, `brobridge`,
 * `@brobridgejs/client` and `@brobridgejs/adapters` always share a version
 * number. That is a property Broapp depends on and cannot check by reading a
 * manifest, because what matters is what a package manager actually installed.
 *
 * The failure this guards against has already happened once here in a milder
 * form. Working around `brobridge@0.2.0`'s unresolvable `workspace:^`
 * specifier needed an `overrides` entry, and an *exact* override
 * (`"@brobridgejs/core": "0.2.0"`) would have been a trap: when 0.2.1 shipped,
 * bumping `brobridge` and `@brobridgejs/client` would leave the override still
 * pinning core to 0.2.0. Nothing would fail to install. The protocol
 * implementation would simply be a version behind the server and client built
 * against it, and the first symptom would be a wire-level bug.
 *
 * So this test reads the resolved tree rather than the declared ranges.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The manifest actually installed for `name`, resolved from `from`.
 *
 * Resolution runs Node's algorithm from a real file, which is the path the
 * runtime itself takes. Globbing `node_modules/.bun/<pkg>@<version>/` would
 * read an implementation detail of Bun's isolated linker instead.
 *
 * `from` matters: with an isolated install a transitive package is not hoisted
 * to the root, so `@brobridgejs/core` has to be resolved from the package that
 * depends on it — which is also the stronger question. "Which core does
 * `brobridge` see?" is the thing that has to agree, not "which core happens to
 * be reachable from the repository root".
 */
async function installedManifest(
  name: string,
  from: string,
): Promise<{ version: string; dependencies?: Record<string, string> }> {
  const resolve = from === '' ? require.resolve : createRequire(from).resolve;
  return JSON.parse(await readFile(resolve(`${name}/package.json`), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
  };
}

const serverPath = require.resolve('brobridge/package.json');
const clientPath = require.resolve('@brobridgejs/client/package.json');

describe('brobridge packages', () => {
  test('every installed Brobridge package is on the same version', async () => {
    const versions = [
      ['brobridge', (await installedManifest('brobridge', '')).version],
      ['@brobridgejs/client', (await installedManifest('@brobridgejs/client', '')).version],
      // Resolved from each dependent, so a tree that gave them different
      // copies of core would show up as two different versions here.
      ['@brobridgejs/core (via brobridge)', (await installedManifest('@brobridgejs/core', serverPath)).version],
      ['@brobridgejs/core (via client)', (await installedManifest('@brobridgejs/core', clientPath)).version],
    ] as const;

    const distinct = new Set(versions.map(([, version]) => version));
    expect(
      distinct.size,
      `Brobridge releases in lockstep, so these must agree: ${versions
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}`,
    ).toBe(1);
  });

  test('the installed core is the one the server package asked for', async () => {
    // The specific shape of the override trap: a resolution that satisfies
    // nobody's declared range but installs anyway.
    const serverManifest = await installedManifest('brobridge', '');
    const declared = serverManifest.dependencies?.['@brobridgejs/core'];

    expect(declared).toBeDefined();
    // A `workspace:` specifier means the published tarball was packed wrong;
    // that is what made brobridge@0.2.0 uninstallable.
    expect(declared).not.toContain('workspace:');

    const installed = (await installedManifest('@brobridgejs/core', serverPath)).version;
    expect(Bun.semver.satisfies(installed, declared ?? '')).toBe(true);
  });

  test('no Brobridge package is pinned by an override', async () => {
    // An override is a last resort with no expiry. If one ever comes back,
    // this says so out loud rather than letting it quietly outlive its cause.
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      overrides?: Record<string, string>;
      resolutions?: Record<string, string>;
    };
    const pins = { ...root.resolutions, ...root.overrides };
    const brobridgePins = Object.keys(pins).filter(
      (name) => name === 'brobridge' || name.startsWith('@brobridgejs/'),
    );

    expect(
      brobridgePins,
      'Brobridge releases in lockstep. An override pins one package while the others move, which installs cleanly and mismatches at the protocol level.',
    ).toEqual([]);
  });
});
