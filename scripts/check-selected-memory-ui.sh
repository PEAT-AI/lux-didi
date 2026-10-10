#!/usr/bin/env bash
# Declared producer for the explicit selected-local-memory UI slice.
#
# Builds the real canonical service (Store/Domain/ChatService/HTTP), runs the new
# selected-memory HTTP tests plus the impacted MEMORY/NCS/CHAT/HTTP regressions, and
# then drives the real GPU browser view of note selection. It never runs a broad
# unrelated ring.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# The lane worktree carries no installed deps. Materialize ignored node_modules
# DIRECTORY trees that symlink each entry of an accepted sibling's installed deps
# read-only; node_modules is already gitignored so this pollutes no tracked file.
# Prefer a candidate that also carries `ws`, needed by the accepted live-voice adapter.
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  for cand in "$root/../lux-didi-live-voice" "$root/../lux-didi-assembled-manifest" "$root/../lux-didi-connected" "$root/../lux-didi-service"; do
    if [[ -x "$cand/server/node_modules/.bin/tsc" && -d "$cand/web/node_modules" && -d "$cand/server/node_modules/ws" ]]; then
      for pkg in server web; do
        mkdir -p "$root/$pkg/node_modules"
        for entry in "$cand/$pkg/node_modules"/* "$cand/$pkg/node_modules"/.[!.]*; do
          [[ -e "$entry" ]] || continue
          ln -sfn "$entry" "$root/$pkg/node_modules/$(basename "$entry")"
        done
      done
      break
    fi
  done
fi
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  echo 'check-selected-memory-ui BLOCKED: installed dependencies (tsc, web, ws) required' >&2; exit 2
fi

git diff --check
bash scripts/run-local.sh --build-only

for f in server/dist/chat/index.js server/dist/http/server.js server/dist/test/selected-memory-ui.test.js \
         server/dist/test/selected-memory-browser-fixture.js server/dist/test/memory-context.test.js \
         server/dist/test/native-conversation.test.js; do
  test -s "$f" || { echo "check-selected-memory-ui: missing build output: $f" >&2; exit 1; }
done

log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
# New selected-memory HTTP behavior + impacted MEMORY/NCS accept/fingerprint/recovery and
# CHAT/HTTP regressions, against the real compiled build.
timeout 1200 node --test --test-reporter=tap --test-timeout=30000 \
  server/dist/test/selected-memory-ui.test.js server/dist/test/memory-context.test.js \
  server/dist/test/native-conversation.test.js server/dist/test/http.test.js \
  server/dist/test/chat.test.js \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-selected-memory-ui: zero selected server tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi

# Real GPU browser admission: a held slot is reported by the helper, never read as a pass.
lux-browser-slot run --priority worker --want 1 --wait 240 -- node web/test/selected-memory-browser.mjs
