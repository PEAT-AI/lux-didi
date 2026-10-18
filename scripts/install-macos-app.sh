#!/bin/bash
# Install an already built and verified Lux Didi app into an explicit user-local
# Applications target. The production build is separate from the install.
#
# Refuses: a target outside the user's home, a missing/invalid source app, an
# existing staging path, any use of --force, or an ad-hoc signed app once a
# signing identity is configured. It never deletes user data or rewrites owner-edited configuration and never touches an unrelated application. The prior app is preserved as
# a uniquely named rollback and restored if post-swap validation fails.
#
# The designated requirement is printed because macOS keys the Accessibility
# grant to it: an ad-hoc `cdhash H"..."` changes on every build and the grant is
# dropped on every install (issue #382).
#
# Usage: scripts/install-macos-app.sh <built-app> [--to DIR]
#   --to DIR   user-local Applications directory (default: $HOME/Applications)
#
# Environment:
#   LUX_DIDI_SIGNING_IDENTITY  the identity the owner signs with; set it (or have
#                              a valid one in the keychain) and an ad-hoc app is
#                              refused instead of installed.
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

# The installed shell must be the one the build produced. Read the hashed script
# asset out of an app's index.html and assert it is present beside it.
web_shell_asset() {  # web_shell_asset <app-dir>
  local index="$1/Contents/Resources/web/dist/index.html"
  [ -f "$index" ] || return 1
  grep -o '/assets/[A-Za-z0-9._-]*\.js' "$index" | head -1
}

web_shell_installed() {
  local source_asset installed_asset
  source_asset="$(web_shell_asset "$built" 2>/dev/null)" || source_asset=""
  installed_asset="$(web_shell_asset "$target" 2>/dev/null)" || installed_asset=""
  printf 'INSTALL-MACOS-APP WEB_SHELL source=%s installed=%s\n' "${source_asset:-none}" "${installed_asset:-none}"
  if [ -z "$source_asset" ]; then return 0; fi
  [ "$installed_asset" = "$source_asset" ] || return 1
  [ -f "$target/Contents/Resources/web/dist$installed_asset" ] || return 1
  [ ! -e "$target/Contents/Resources/web/dist/dist" ] || return 1
}

name="$(basename "$built")"
[ "$name" = "Lux Didi.app" ] || { echo "install-macos-app.sh: expected 'Lux Didi.app', got '$name'" >&2; exit 2; }

# The requirement macOS matches the Accessibility grant against. An ad-hoc
# signature states a bare cdhash, which no reinstall can match; a
# certificate-backed one names an identifier and a certificate anchor.
designated_requirement() { codesign -d -r- "$1" 2>&1 | sed -n 's/^#* *designated => //p' | head -1; }
is_adhoc_requirement() {
  case "$1" in
    *'cdhash H"'*) case "$1" in *certificate*) return 1;; *) return 0;; esac;;
  esac
  return 1
}
signing_identity="${LUX_DIDI_SIGNING_IDENTITY:-}"
if [ -z "$signing_identity" ] && security find-identity -p codesigning -v 2>/dev/null | grep -qF '"Lux Didi Local Signing"'; then
  signing_identity="Lux Didi Local Signing"
fi
target="$target_dir/$name"
stage="$target_dir/.LuxDidi.install.$$"
[ ! -e "$stage" ] || { echo "install-macos-app.sh: staging path already exists" >&2; exit 2; }

# Validate before swap.
codesign --verify --deep --strict "$built"
[ -x "$built/Contents/MacOS/LuxDidi" ] || { echo "install-macos-app.sh: source executable missing" >&2; exit 2; }
built_requirement="$(designated_requirement "$built")"
if [ -n "$signing_identity" ] && is_adhoc_requirement "$built_requirement"; then
  echo "install-macos-app.sh: refusing an ad-hoc install: signing identity '$signing_identity' is configured" >&2
  echo "install-macos-app.sh: but the designated requirement is ad-hoc ($built_requirement), so macOS would" >&2
  echo "install-macos-app.sh: drop the Accessibility grant again; rebuild with scripts/build-macos-app.sh" >&2
  exit 1
fi

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
if ! codesign --verify --deep --strict "$target" || [ ! -x "$target/Contents/MacOS/LuxDidi" ] || ! web_shell_installed; then
  rm -rf "$target"
  if [ -n "$rollback" ]; then mv "$rollback" "$target"; fi
  echo "install-macos-app.sh: post-swap validation failed; prior app restored" >&2
  exit 1
fi

# Installation owns only the app bundle. Configuration remains owner-controlled.
installed_requirement="$(designated_requirement "$target")"
printf 'INSTALL-MACOS-APP designated requirement: %s\n' "${installed_requirement:-unknown}"
if is_adhoc_requirement "$installed_requirement"; then
  printf 'INSTALL-MACOS-APP WARNING ad-hoc signature: this requirement changes every build, so the Accessibility grant will not survive the next install\n' >&2
fi

printf 'INSTALL-MACOS-APP PASS target=%s rollback=%s\n' "$target" "${rollback:-none}"
