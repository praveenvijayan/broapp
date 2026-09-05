# Build and release

## Commands

```bash
bun run dev                              # watch src/, rebuild, restart host, print launch URL
bun run dev -- --no-open                 # same, never open a browser
bun run build                            # UI + executable for this machine, into release/
bun run build:page                       # UI document only (dist/ui.html)
bun run build -- --target linux-x64      # one other target; repeatable
bun run build:all                        # every supported target
bun run build -- --no-minify --no-bytecode
```

`broapp dev` watches `src/` for `.ts .tsx .js .jsx .css .html .json`,
debounced 120 ms. It opens the browser on the first start only; every
restart prints a fresh launch URL because the old session died with the old
process. A build failure prints and keeps the previous host running.

There is no hot module replacement, by design. HMR would need a second,
unauthenticated origin. Do not add one.

## broapp.config.ts

```ts
import { defineConfig } from 'broapp/build';
export default defineConfig({
  uiEntry: 'src/ui/main.tsx',
  uiTemplate: 'src/ui/index.html',
  hostEntry: 'src/host/main.ts',
  pageOut: 'dist/ui.html',        // must match the import in src/host/main.ts
  binaryName: 'my-app',           // default: package name without scope
  outDir: 'release',
  bytecode: true,
  csp: { 'img-src': ['data:'] },  // extra CSP sources, rarely needed
});
```

Restart `broapp dev` after editing it.

## What the build enforces

- One document. Everything inline. A dynamic `import()` that produces a
  second chunk fails the build.
- No off-origin `src`, `href`, CSS `url()` or `@import`. A URL that is only
  a string in JavaScript is fine.
- The browser bundle must not reach `broapp/host` or `src/host`.
- CSP hashes are computed from the exact bytes served.

## Targets

| Target | Suffix | Notes |
| --- | --- | --- |
| `darwin-arm64` | | macOS, Apple silicon |
| `darwin-x64` | | macOS, Intel |
| `linux-x64` | | glibc |
| `linux-arm64` | | glibc |
| `linux-x64-musl` | | Alpine and other musl distributions; most portable Linux |
| `windows-x64` | `.exe` | |

**A cross-compiled binary is built, not run.** Only the binary for the
building machine has been executed. Anything native, `bun:sqlite` included,
is where this bites. Test each target on that target.

Binaries are around 60 MB (about 25 MB compressed). That is the Bun runtime
and it will not shrink meaningfully. Say so; do not promise small files.

## What the executable guarantees

Runs without source files nearby, without Bun installed, from any working
directory, without writing into its own directory, without a network.

Smoke check after a build:

```bash
cd /tmp && /path/to/release/my-app --version && /path/to/release/my-app --data-dir
```

## Signing and distribution

Broapp signs nothing. Per platform:

- **macOS.** Unsigned downloads hit Gatekeeper. For your own machine:
  `xattr -d com.apple.quarantine ./my-app`. For distribution: Developer ID
  certificate, `codesign --options runtime --timestamp`, then
  `xcrun notarytool submit … --wait`. Ship inside a `.dmg` or `.pkg` so the
  ticket can be stapled. Must run on macOS.
- **Windows.** Unsigned executables trigger SmartScreen. OV certificates
  earn reputation slowly; EV gets it immediately. Always timestamp:
  `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a app.exe`.
- **Linux.** Ship `.tar.gz`, not zip, so the executable bit survives.
  Build on the oldest glibc you support, or ship the musl target.

Publish `SHA256SUMS` beside the archives and tell users to run
`sha256sum -c SHA256SUMS --ignore-missing`.

## Replacing an installed binary

It is one file. `mv new over old` is atomic on the same filesystem. On
Windows, quit the app first. Data is in the per-user directory and is not
touched; migrations run on next start. Downgrades are the risk: a database
migrated by a newer build should be refused by an older one.

## No self-updater

Deliberately. An updater that fetches and runs code needs signature
verification, rollback and a trusted channel. Use a package manager or a
release page plus checksum. Do not build one into the app.

## Release automation for the user's project

The generated project has no workflow. If the user wants one, mirror the
Broapp repository's `release.yml`: run checks, compile every target, smoke
test natively on each OS runner, produce archives and `SHA256SUMS`, create a
draft release. Keep publication manual. Never publish, tag or push a release
without explicit instruction.
