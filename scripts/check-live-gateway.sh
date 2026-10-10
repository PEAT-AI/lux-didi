#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-live-gateway.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server
npm run build
# The new gateway suite runs with the accepted Live owner and adapter regression suites.
node --test --test-reporter=tap --test-timeout=30000 dist/test/live-gateway.test.js dist/test/live-session.test.js dist/test/live-voice.test.js dist/test/prompt.test.js | tee "$work/test.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected live gateway tests' >&2; exit 1; }
grep -Eq '^# fail 0$' "$work/test.log" || { echo 'Selected live gateway tests failed' >&2; exit 1; }
# Affected host-entry migration/reopen runtime ring (impact-selected; not the full host/web ring).
node --test --test-reporter=tap --test-timeout=60000 test/host-entry.test.mjs | tee "$work/host.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/host.log" || { echo 'Zero selected host runtime tests' >&2; exit 1; }
grep -Eq '^# fail 0$' "$work/host.log" || { echo 'Selected host runtime tests failed' >&2; exit 1; }
# The canonical files inventory must publish the gateway production roots, offline.
npm pack --offline --ignore-scripts --pack-destination "$work" --json > "$work/pack.json"
node --input-type=module - "$work/pack.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pack = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = pack[0].files.map(entry => entry.path);
for (const root of ['dist/config/', 'dist/http/', 'dist/host/', 'dist/live/']) {
  assert.ok(files.some(path => path.startsWith(root)), `published tarball must include ${root}`);
}
NODE
echo 'LIVE-GATEWAY CHECK PASS'
