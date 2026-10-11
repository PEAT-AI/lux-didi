#!/usr/bin/env bash
# Acceptance check for the Mongoose and Mattermost read connectors (W-H).
# Synthetic fixtures only: no network, no real Mongoose or Mattermost service, no credentials.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# The lane worktree carries no installed deps. Materialize an ignored node_modules
# directory that symlinks an accepted sibling's installed service deps read-only
# (server/node_modules is gitignored, so this pollutes no tracked file).
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  for cand in "$root/../lux-didi-train" "$root/../lux-didi-voice-c" "$root/../lux-didi-voice-b"; do
    if [[ -x "$cand/server/node_modules/.bin/tsc" ]]; then
      mkdir -p "$root/server/node_modules"
      for entry in "$cand/server/node_modules"/* "$cand/server/node_modules"/.[!.]*; do
        [[ -e "$entry" ]] || continue
        ln -sfn "$entry" "$root/server/node_modules/$(basename "$entry")"
      done
      break
    fi
  done
fi
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  echo 'COMPANY CONNECTORS CHECK BLOCKED: installed SERVICE TypeScript required' >&2
  exit 2
fi

cd "$root/server"
npm run build
mkdir -p dist/test/fixtures
cp test/fixtures/stdio-mattermost-child.mjs dist/test/fixtures/
node --test --test-timeout=20000 \
  dist/test/mongoose-connector.test.js \
  dist/test/mattermost-connector.test.js
