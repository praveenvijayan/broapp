# Packaging and release

```bash
bun run build          # this platform, into ./release
bun run build:all      # every supported target
bun run build -- --target linux-x64 --target windows-x64
```

## Targets

| Target | Suffix | Notes |
| --- | --- | --- |
| `darwin-arm64` | — | macOS, Apple silicon |
| `darwin-x64` | — | macOS, Intel |
| `linux-x64` | — | glibc |
| `linux-arm64` | — | glibc |
| `linux-x64-musl` | — | Alpine and other musl distributions |
| `windows-x64` | `.exe` | |

**A cross-compiled binary is built, not run.** `bun build --compile
--target=bun-linux-x64` on a Mac produces a Linux executable; nothing about that
proves it works. `broapp build` labels cross-compiled outputs
`(cross-compiled, not run)`, and the release workflow keeps "compiled" and
"smoke-tested" as separate columns. Test each target on that target before you
ship it.

This matters most with anything native. `bun:sqlite` links a platform SQLite
into the produced binary — the cross-compile succeeds and the result is
untested. Pure-JavaScript dependencies cross-compile without trouble.

## Size

Roughly **60 MB** per binary, compressing to about 25 MB. That is the Bun
runtime; your application code is a rounding error beside it. It does not
meaningfully depend on how large your UI is, and it is not going to get much
smaller.

If that is disqualifying, this is not the right architecture — see
[comparison.md](comparison.md).

`--no-bytecode` trades a little size for slower startup. Bytecode is on by
default because startup is what a user notices.

## What ends up inside

The Bun runtime, your host code, your dependencies, and the UI document — the
last as an ordinary import with `{ type: "text" }`, which Bun inlines into the
bundle.

So the executable is genuinely self-contained. It runs:

- without source files nearby,
- without Bun installed,
- from any working directory,
- without writing into its own directory,
- without a network.

Each of those is exercised by the release dry run.

## Signing and distribution

Broapp does not sign anything. Here is what each platform needs.

### macOS

An unsigned binary downloaded from the internet carries a quarantine attribute,
and Gatekeeper refuses it. Users can bypass this per-file
(right-click → Open, or `xattr -d com.apple.quarantine ./my-app`), but you should
not ask them to.

To distribute properly you need an Apple Developer account, a Developer ID
Application certificate, and both steps:

```bash
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Your Name (TEAMID)" ./release/my-app

ditto -c -k --keepParent ./release/my-app ./release/my-app.zip
xcrun notarytool submit ./release/my-app.zip \
  --apple-id you@example.com --team-id TEAMID --password "$APP_PASSWORD" --wait
```

Notarisation is not optional in practice — signing alone still trips Gatekeeper
for a downloaded file. A single binary cannot be stapled; ship it inside a `.dmg`
or `.pkg` and staple that, or accept that the check happens online at first
launch.

Signing must run on macOS, so it cannot be done from a Linux CI runner.

### Windows

Unsigned executables trigger SmartScreen's "Windows protected your PC", with the
Run anyway button behind **More info**. Most users will not click through.

An OV code-signing certificate removes the warning only after your signature
accumulates reputation, which takes downloads and time. An EV certificate
(hardware token or cloud HSM) gets reputation immediately and costs
substantially more.

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /a .\release\my-app-windows-x64.exe
```

Always timestamp: without it, signatures stop verifying when the certificate
expires.

### Linux

No signing infrastructure to satisfy. Two practical points:

- **The executable bit does not survive a zip archive.** Ship `.tar.gz`, which
  preserves permissions, or tell users to `chmod +x`.
- **glibc versions matter.** A binary built against a newer glibc will not run on
  an older distribution. Build on the oldest one you intend to support, or ship
  the `musl` target, which is far more portable.

## Checksums

The release workflow writes `SHA256SUMS` beside the archives. Publish it, and
tell users how to check:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

Without signing, a checksum published over HTTPS is the strongest integrity
signal you have. It is worth doing.

## Replacing an installed executable

The binary is one file. Replacing it is copying over it.

```bash
# macOS and Linux
curl -fLo my-app.new https://…/my-app-darwin-arm64
chmod +x my-app.new
mv my-app.new /usr/local/bin/my-app
```

`mv` over the old file is atomic on the same filesystem, so there is no window
in which the file is half-written. On Windows you cannot replace a running
executable — quit the application first.

**Application data is not touched.** It lives in the per-user directory
([lifecycle.md](lifecycle.md)), never beside the executable, so an update never
risks it. Migrations run on the next start.

Downgrades are the case to be careful about: a database migrated by a newer
build may be unreadable by an older one. The notes example refuses to open a
database whose schema version is newer than it understands, rather than silently
ignoring columns it does not know about.

## No self-updater

Deliberately out of scope for v1. An updater that fetches and executes code is a
security-critical component — it needs signature verification, rollback, and a
trustworthy channel — and a bad one is worse than none. Use your platform's
package manager, or a release page and a checksum.

## The release workflow

`.github/workflows/release.yml` runs on a `v*` tag:

1. Checks — typecheck and the full test suite.
2. Compiles every target.
3. Runs a **native** smoke test on Linux, macOS and Windows runners: launch the
   binary, complete the authenticated bootstrap, call an operation, shut it down.
4. Produces archives and `SHA256SUMS`.
5. Creates a **draft** release.

Publishing is manual. The draft is created, the button is yours. npm publication
is a separate manually-triggered workflow — see [publishing.md](publishing.md).
