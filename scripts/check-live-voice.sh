#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-live-voice.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server
npm run build
node --test --test-reporter=tap --test-timeout=10000 dist/test/live-voice.test.js | tee "$work/test.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected live voice tests' >&2; exit 1; }
# Use the canonical files inventory and bundled production dependencies, offline.
npm pack --offline --ignore-scripts --pack-destination "$work" --json > "$work/pack.json"
mkdir "$work/runtime"
(cd "$work/runtime" && npm init -y >/dev/null && npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund "$work"/*.tgz >/dev/null)
node --input-type=module - "$work/runtime" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] + '/node_modules/@lux-didi/service';
const live = await import(pathToFileURL(root + '/dist/adapters/live-voice/index.js').href);
const text = await import(pathToFileURL(root + '/dist/adapters/model/index.js').href);
assert.equal(typeof live.GeminiLiveVoiceAdapter, 'function');
assert.equal(typeof live.LiveVoiceError, 'function');
assert.equal(typeof text.GeminiAdapter, 'function');
console.log('Offline canonical tarball optional voice and text imports: PASS');
NODE
