#!/bin/bash
# Install an already built and verified Lux Didi app into an explicit user-local
# Applications target. The production build is separate from the install.
#
# Refuses: a target outside the user's home, a missing/invalid source app, an
# existing staging path, or any use of --force. It never deletes or reseeds user
# data and never touches an unrelated application. The prior app is preserved as
# a uniquely named rollback and restored if post-swap validation fails.
#
# Usage: scripts/install-macos-app.sh <built-app> [--to DIR]
#   --to DIR   user-local Applications directory (default: $HOME/Applications)
set -euo pipefail
export CI=1

built="${1:?install-macos-app.sh needs a built .app path}"
shift
target_dir="${HOME}/Applications"
while [ $# -gt 0 ]; do
  case "$1" in
    --to) target_dir="${2:?--to needs a directory}"; shift 2;;
    --force) echo "install-macos-app.sh: --force is not supported" >&2; exit 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "install-macos-app.sh: unknown argument $1" >&2; exit 2;;
  esac
done

[ -d "$built" ] || { echo "install-macos-app.sh: source app $built missing" >&2; exit 2; }
case "$(cd "$target_dir" 2>/dev/null && pwd || echo "$target_dir")/" in
  "$HOME"/*) ;;
  *) echo "install-macos-app.sh: target must be inside the user home" >&2; exit 2;;
esac

name="$(basename "$built")"
[ "$name" = "Lux Didi.app" ] || { echo "install-macos-app.sh: expected 'Lux Didi.app', got '$name'" >&2; exit 2; }
target="$target_dir/$name"
stage="$target_dir/.LuxDidi.install.$$"
[ ! -e "$stage" ] || { echo "install-macos-app.sh: staging path already exists" >&2; exit 2; }

# Validate before swap.
codesign --verify --deep --strict "$built"
[ -x "$built/Contents/MacOS/LuxDidi" ] || { echo "install-macos-app.sh: source executable missing" >&2; exit 2; }

mkdir -p "$target_dir"
ditto "$built" "$stage"
codesign --verify --deep --strict "$stage" || { echo "install-macos-app.sh: staged copy failed verification" >&2; rm -rf "$stage"; exit 1; }

rollback=""
if [ -e "$target" ]; then
  rollback="$target.rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$rollback" ] || { echo "install-macos-app.sh: rollback name already exists" >&2; rm -rf "$stage"; exit 1; }
  mv "$target" "$rollback"
fi

mv "$stage" "$target"
if ! codesign --verify --deep --strict "$target" || [ ! -x "$target/Contents/MacOS/LuxLidi" ]; then
  rm -rf "$target"
  if [ -n "$rollback" ]; then mv "$rollback" "$target"; fi
  echo "install-macos-app.sh: post-swap validation failed; prior app restored" >&2
  exit 1
fi

printf 'INSTALL-MACOS-APP PASS target=%s rollback=%s\n' "$target" "${rollback:-none}"
