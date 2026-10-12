#!/bin/bash
# Install an already built and verified Lux Didi app into an explicit user-local
# Applications target. The production build is separate from the install.
#
# Refuses: a target outside the user's home, a missing/invalid source app, an
# existing staging path, or any use of --force. It never deletes user data or rewrites owner-edited configuration and never touches an unrelated application. The prior app is preserved as
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
if ! codesign --verify --deep --strict "$target" || [ ! -x "$target/Contents/MacOS/LuxDidi" ]; then
  rm -rf "$target"
  if [ -n "$rollback" ]; then mv "$rollback" "$target"; fi
  echo "install-macos-app.sh: post-swap validation failed; prior app restored" >&2
  exit 1
fi

data_dir="${HOME}/Library/Application Support/ai.peat.lux-didi"
# Upgrade only byte-identical program-owned seeds. Owner edits and symlinks are untouched.
# The candidate is private and renamed atomically; an unchanged seed is never rewritten.
seed_shipped_config() {
  local file="$1" desired="$2" candidate old
  shift 2
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then return; fi
  if [ ! -d "$(dirname "$file")" ]; then mkdir -p "$(dirname "$file")"; chmod 700 "$(dirname "$file")"; fi
  candidate="$(mktemp "${file}.tmp.XXXXXX")"
  printf '%s\n' "$desired" > "$candidate"
  chmod 600 "$candidate"
  if [ ! -e "$file" ]; then mv "$candidate" "$file"; return; fi
  if cmp -s "$file" "$candidate"; then rm "$candidate"; return; fi
  for old in "$@"; do
    if cmp -s "$file" <(printf '%s\n' "$old"); then mv "$candidate" "$file"; return; fi
  done
  rm "$candidate"
}
# Substitutions are the same ones used by every shipped endpoint seed.
google_command="/Users/rob/.lux/reports/lux-didi-voice-1011/tools/google-mcp/.venv/bin/google-mcp"
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
stdio_env="{\"HOME\":\"$(json_escape "${HOME}")\",\"PATH\":\"$(json_escape "${PATH}")\",\"LOGNAME\":\"\",\"SHELL\":\"\",\"TERM\":\"\",\"USER\":\"\"}"
node_command="$(json_escape "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")"
mattermost_command="$(json_escape "${HOME}/GitHub/mattermost-mcp/dist/index.cjs")"
mcp_template="$(cat <<JSON
{"schemaVersion":1,"grantMode":"owner-trusted-reads","endpoints":[{"id":"lux-knowledge","unknownClass":"private","transport":"streamable-http","url":"http://127.0.0.1:8765/mcp","connector":"lux-knowledge","account":"local","resource":"lux-knowledge","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"gmail","unknownClass":"private","transport":"stdio","command":"${google_command}","args":["--family","gmail"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-gmail","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"calendar","unknownClass":"private","transport":"stdio","command":"${google_command}","args":["--family","calendar"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-calendar","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"mongoose","unknownClass":"private","transport":"streamable-http","url":"https://mongoose.dev.peat-cloud.com/mcp/","connector":"mongoose","account":"local","resource":"mongoose","credentialRef":"mongoose-mcp","enabled":true,"allowEgress":true},{"id":"mattermost","unknownClass":"private","transport":"stdio","command":"${node_command}","args":["${mattermost_command}"],"env":${stdio_env},"connector":"mattermost","account":"local","resource":"mattermost","credentialRef":null,"enabled":true,"allowEgress":true}]}
JSON
)"
live_template="$(cat <<'JSON'
{"schemaVersion":1,"enabled":true,"provider":"gemini","modelId":"models/gemini-3.1-flash-live-preview","voice":"Aoede","keyReference":"gemini-primary","dataClasses":["ordinary","private"],"preferences":{"dataClass":"ordinary","language":"en","register":"plain","humor":"dry","verbosity":"brief"}}
JSON
)"
# Exact historical templates, not semantic JSON equality or an ownership marker.
# This whitelist covers the shipped one-, three-, and five-connector catalogs.
old_mcp_templates=(
"$(cat <<JSON
{"schemaVersion":1,"grantMode":"owner-trusted-reads","endpoints":[{"id":"lux-knowledge","transport":"streamable-http","url":"http://127.0.0.1:8765/mcp","connector":"lux-knowledge","account":"local","resource":"lux-knowledge","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"gmail","transport":"stdio","command":"${google_command}","args":["--family","gmail"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-gmail","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"calendar","transport":"stdio","command":"${google_command}","args":["--family","calendar"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-calendar","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"mongoose","transport":"streamable-http","url":"https://mongoose.dev.peat-cloud.com/mcp/","connector":"mongoose","account":"local","resource":"mongoose","credentialRef":"mongoose-mcp","enabled":true,"allowEgress":true},{"id":"mattermost","transport":"stdio","command":"${node_command}","args":["${mattermost_command}"],"env":${stdio_env},"connector":"mattermost","account":"local","resource":"mattermost","credentialRef":null,"enabled":true,"allowEgress":true}]}
JSON
)"
"$(cat <<JSON
{"schemaVersion":1,"grantMode":"owner-trusted-reads","endpoints":[{"id":"lux-knowledge","transport":"streamable-http","url":"http://127.0.0.1:8765/mcp","connector":"lux-knowledge","account":"local","resource":"lux-knowledge","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"gmail","transport":"stdio","command":"${google_command}","args":["--family","gmail"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-gmail","credentialRef":null,"enabled":true,"allowEgress":true},{"id":"calendar","transport":"stdio","command":"${google_command}","args":["--family","calendar"],"env":${stdio_env},"connector":"google","account":"local","resource":"google-calendar","credentialRef":null,"enabled":true,"allowEgress":true}]}
JSON
)"
"$(cat <<JSON
{"schemaVersion":1,"grantMode":"owner-trusted-reads","endpoints":[{"id":"lux-knowledge","transport":"streamable-http","url":"http://127.0.0.1:8765/mcp","connector":"lux-knowledge","account":"local","resource":"lux-knowledge","credentialRef":null,"enabled":true,"allowEgress":true}]}
JSON
)"
)
old_live_templates=(
"$(cat <<'JSON'
{"schemaVersion":1,"enabled":true,"provider":"gemini","modelId":"models/gemini-3.1-flash-live-preview","voice":"Aoede","keyReference":"gemini-primary","dataClasses":["ordinary"],"preferences":{"dataClass":"ordinary","language":"en","register":"plain","humor":"dry","verbosity":"brief"}}
JSON
)"
 )
for config_dir in "${data_dir}/provider-config" "${data_dir}/provider-38"; do
  seed_shipped_config "${config_dir}/mcp.json" "$mcp_template" "${old_mcp_templates[@]}"
  seed_shipped_config "${config_dir}/live.json" "$live_template" "${old_live_templates[@]}"
done

printf 'INSTALL-MACOS-APP PASS target=%s rollback=%s\n' "$target" "${rollback:-none}"
