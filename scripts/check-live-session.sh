#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
helper="$(pwd)/scripts/npm-ci-offline.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-live-session.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server
npm run build
# C-RESEARCH-CONTRACT F4: the refusal integration suite is the only proof that a refused argument shape and an
# admission block reach the trace as `refused` and `blocked`, so it runs here against the build it just made.
node test/research-refusal.integration.mjs
# The new owner suite, the live summary suite (#363), the trace store suite, the warm-context pre-assembly
# suite, the debug journal suites and the accepted Live adapter regression suite run together, with the
# voice fault-replay scenarios (release gate F1): the real adapter and the real host, driven over a virtual clock.
# #1021: the connector fields her project hint travels in, refused and accepted by the connector itself.
node_test_files --test-reporter=tap --test-timeout=30000 dist/test/research-knowledge.test.js dist/test/knowledge-connector.test.js dist/test/research-depth.test.js dist/test/context-hygiene.test.js | tee "$work/knowledge.log"
grep -Eq '^# fail 0$' "$work/knowledge.log" || { echo 'Selected knowledge suites failed' >&2; exit 1; }
# The conversation continuity suite (#1021) pins mute, unmute and seeding; the resumption and watchdog suites
# ride along because the seed and the provider lifetime are what they assert.
node_test_files --test-reporter=tap --test-timeout=30000 dist/test/live-continuity.test.js dist/test/live-resumption.test.js dist/test/live-watchdog.test.js dist/test/heard-silence.test.js dist/test/live-mute.test.js dist/test/live-recovery.test.js dist/test/live-voice.test.js dist/test/live-selection.test.js dist/test/live-session.test.js dist/test/stop-phrase.test.js dist/test/live-summary.test.js dist/test/live-memory-note.test.js dist/test/research-steps.test.js dist/test/naya-logs.test.js dist/test/warm-context.test.js dist/test/people.test.js dist/test/trace.test.js dist/test/store-retention.test.js dist/test/timeline.test.js dist/test/research-patience-replay.test.js dist/test/lux-save-natural.test.js dist/test/voice-replay.test.js dist/test/live-rebuild-sweep.test.js dist/test/research-web.test.js dist/test/vault-write.test.js dist/test/research-continuation.test.js dist/test/partial-research-turn-contract-replay.test.js | tee "$work/test.log"

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
(cd "$work/runtime" && npm init -y >/dev/null && bash "$helper" "$work/runtime" install --offline --omit=dev --ignore-scripts --no-audit --no-fund "$work"/*.tgz >/dev/null)
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
