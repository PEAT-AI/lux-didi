#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-live-session.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server
npm run build
# The new owner suite and the accepted Live adapter regression suite run together.
node --test --test-reporter=tap --test-timeout=30000 dist/test/live-voice.test.js dist/test/live-session.test.js | tee "$work/test.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected live session tests' >&2; exit 1; }
grep -Eq '^# fail 0$' "$work/test.log" || { echo 'Selected live session tests failed' >&2; exit 1; }
# The canonical files inventory must publish the live production root, offline.
npm pack --offline --ignore-scripts --pack-destination "$work" --json > "$work/pack.json"
node --input-type=module - "$work/pack.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pack = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = pack[0].files.map(entry => entry.path);
assert.ok(files.some(path => path.startsWith('dist/live/')), 'published tarball must include dist/live');
NODE
mkdir "$work/runtime"
(cd "$work/runtime" && npm init -y >/dev/null && npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund "$work"/*.tgz >/dev/null)
node --input-type=module - "$work/runtime" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] + '/node_modules/@lux-didi/service';
const live = await import(pathToFileURL(root + '/dist/live/index.js').href);
assert.equal(typeof live.LiveSessionOwner, 'function');
assert.equal(typeof live.createLiveSessionOwner, 'function');
assert.equal(typeof live.validateLiveProfile, 'function');
assert.ok(Array.isArray(live.liveMigrations) && live.liveMigrations[0].owner === 'live');
console.log('Offline canonical tarball live session core import: PASS');
NODE
