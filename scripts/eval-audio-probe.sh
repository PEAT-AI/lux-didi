#!/usr/bin/env bash
# Tier 2 synthetic audio probe. A short made-up utterance, fed through the real realtime adapter's audio path,
# with the provider's spoken output counted and dropped. No audio device is opened, nothing is played aloud.
#
#   scripts/eval-audio-probe.sh                # dry run: the utterance, the chunk plan, no socket
#   scripts/eval-audio-probe.sh --fake-model   # replay a recorded synthetic provider turn, $0
#   scripts/eval-audio-probe.sh --say          # build the utterance with the macOS say command into a local
#                                              # git-ignored file (never played) and probe with it
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ -L "$deps" ]]; then
  echo 'BLOCKED: server/node_modules is a symlink; run npm ci in this worktree server/' >&2
  exit 2
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'AUDIO PROBE BLOCKED: the server dependencies (typescript, @types/node) are not installed; run npm ci in server/' >&2
  exit 2
fi
cd "$root/server"
"$deps/typescript/bin/tsc" -p tsconfig.eval.json
mkdir -p dist/eval dist/test/eval-release
cp eval/tool-map.json dist/eval/tool-map.json
cp -R test/eval-release/scenarios test/eval-release/recordings dist/test/eval-release/
cp test/eval-release/judge-prompt.md dist/test/eval-release/judge-prompt.md

extra=()
for arg in "$@"; do
  case "$arg" in
    --say)
      # A synthetic utterance through the macOS voice, written to a file and never played.
      out="$root/server/eval-out/audio"
      mkdir -p "$out"
      if ! command -v say >/dev/null 2>&1; then
        echo 'AUDIO PROBE: --say needs the macOS say command, building the utterance in code instead' >&2
      else
        say -o "$out/probe.wav" --data-format=LEI16@24000 "synthetic audio probe one two three" >/dev/null 2>&1
        if [[ ! -s "$out/probe.wav" ]]; then
          echo 'AUDIO PROBE: say wrote no file; building the utterance in code instead' >&2
        else
          extra+=(--pcm "$out/probe.wav")
        fi
      fi
      ;;
    *) extra+=("$arg") ;;
  esac
done
exec node dist/test/eval-release/cli.js --audio-probe "${extra[@]}"
