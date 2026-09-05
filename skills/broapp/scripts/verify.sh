#!/usr/bin/env bash
# Verify a Broapp project the way CI would.
#
#   bash verify.sh [project-dir] [--no-build]
#
# Checks, in order:
#   1. It is a Broapp project and Bun is available.
#   2. Nothing under src/ui imports host code, and index.html loads nothing external.
#   3. bun run typecheck
#   4. bun test (when any *.test.ts exists)
#   5. bun run build, then the compiled binary answers --version and --data-dir
#      from an unrelated working directory.
#
# Exit 0 on success, 1 on a failed check, 2 on a usage or environment problem.
set -euo pipefail

root='.'
build=1
for argument in "$@"; do
  case "$argument" in
    --no-build) build=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) root="$argument" ;;
  esac
done

cd "$root" || { echo "verify: cannot enter $root" >&2; exit 2; }

if [ ! -f package.json ] || ! grep -q '"broapp"' package.json; then
  echo 'verify: not a Broapp project (package.json has no "broapp" dependency)' >&2
  exit 2
fi
if ! command -v bun >/dev/null 2>&1; then
  echo 'verify: bun not found. Install from https://bun.sh (1.2 or newer).' >&2
  exit 2
fi

fail=0
say() { printf '\n== %s\n' "$*"; }

say 'host/UI boundary'
if [ -d src/ui ]; then
  if grep -rn --include='*.ts' --include='*.tsx' -E "from ['\"](broapp/host|[./]*/host(/|['\"]))" src/ui; then
    echo 'verify: src/ui imports host code. Move shared pieces into src/shared.' >&2
    fail=1
  else
    echo 'ok: src/ui does not import src/host or broapp/host'
  fi
  if [ -f src/ui/index.html ] && grep -nE '<(script[^>]*\ssrc=|link[^>]*\shref=)' src/ui/index.html; then
    echo 'verify: src/ui/index.html loads an external resource; the UI must be one document.' >&2
    fail=1
  else
    echo 'ok: index.html loads nothing external'
  fi
fi

say 'typecheck'
bun run typecheck || fail=1

say 'tests'
if find . -path ./node_modules -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | grep -q .; then
  bun test || fail=1
else
  echo 'no *.test.ts files; skipping'
fi

if [ "$build" -eq 1 ]; then
  say 'build'
  if bun run build; then
    name=$(bun -e 'const p=await Bun.file("package.json").json(); console.log((p.name||"app").replace(/^@[^/]+\//,""))')
    out_dir='release'
    if [ -f broapp.config.ts ]; then
      configured=$(grep -oE "outDir:\s*['\"][^'\"]+['\"]" broapp.config.ts | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" || true)
      [ -n "${configured:-}" ] && out_dir="$configured"
      configured=$(grep -oE "binaryName:\s*['\"][^'\"]+['\"]" broapp.config.ts | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" || true)
      [ -n "${configured:-}" ] && name="$configured"
    fi
    binary=$(find "$out_dir" -maxdepth 1 -type f \( -name "$name" -o -name "$name.exe" -o -name "$name-*" \) | head -n 1 || true)
    if [ -z "$binary" ]; then
      echo "verify: no executable named $name in $out_dir" >&2
      fail=1
    else
      binary=$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")
      say "smoke: $binary"
      scratch=$(mktemp -d)
      ( cd "$scratch" && "$binary" --version && BROAPP_DATA_DIR="$scratch/data" "$binary" --data-dir ) || fail=1
      rm -rf "$scratch"
    fi
  else
    fail=1
  fi
else
  say 'build skipped (--no-build)'
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo 'verify: FAILED' >&2
  exit 1
fi
echo
echo 'verify: all checks passed'
