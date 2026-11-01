#!/usr/bin/env bash
# The single runner for the live suites. Every group runs to the end, each result is printed as it
# happens, and the complete fail list is printed before the script exits non-zero (#805), so one red
# group never hides the reds behind it. scripts/lib/check-groups-selftest.sh proves that property, and
# the first group below runs it so the property keeps a real call site.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/check-groups.sh"
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
root="$(pwd)"
helper="$root/scripts/npm-ci-offline.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-live-session.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd server

# Each command carries its own failure back to the group with || return 1, because a group runs under
# a status test and therefore inherits no errexit of its own.

# The public tree is vanilla (C-VANILLA): no owner mailbox and no owner home path in any tracked file.
# Historical comparative proof runs when the pinned release is available; current behavior tests below always run.
group_build() {
  node test/vanilla-tree.integration.mjs || return 1
  npm run build || return 1
  if git cat-file -e c77491b713808192e6314babd8b0bdbb3154cbdf^{commit} 2>/dev/null; then
  node test/direct102-red-base.integration.mjs || return 1
  else
  printf '%s\n' 'DIRECT102_BASE_HISTORY_UNAVAILABLE: current behavior tests remain mandatory below' || return 1
  fi
}

# Alarm cases are imported by the registry-wide intent suite, so release CI executes both.
# Public tool guidance is also composed by text, memory and summary surfaces.
group_guidance() {
  node_test_files --test-reporter=tap --test-timeout=30000 dist/test/tools-builtin-intent.test.js dist/test/research-calendar.test.js || return 1
  node_test_files --test-reporter=tap --test-timeout=30000 dist/test/prompt.test.js dist/test/live-persona.test.js dist/test/chat.test.js dist/test/memory-context.test.js dist/test/memory-import.test.js dist/test/summaries.test.js || return 1
  node test/prompt-content.integration.mjs || return 1
}

# admission block reach the trace as `refused` and `blocked`, so it runs here against the build it just made.
# Contract regressions run first so a red boundary fails before the broader live replay.
group_boundary() {
  node_test_files --test-reporter=tap --test-timeout=30000 dist/test/vault-write.test.js dist/test/lux-note.test.js dist/test/live-remember.test.js dist/test/tools-builtin-intent.test.js dist/test/research-calendar.test.js || return 1
  node test/research-refusal.integration.mjs || return 1
}

# The new owner suite, the live summary suite (#363), the trace store suite, the warm-context pre-assembly
# suite, the debug journal suites and the accepted Live adapter regression suite run together, with the
# voice fault-replay scenarios (release gate F1): the real adapter and the real host, driven over a virtual clock.
# #1021: the connector fields her project hint travels in, refused and accepted by the connector itself.
group_knowledge() {
  node_test_files --test-reporter=tap --test-timeout=30000 dist/test/research-knowledge.test.js dist/test/knowledge-connector.test.js dist/test/research-depth.test.js dist/test/context-hygiene.test.js | tee "$work/knowledge.log" || return 1
  grep -Eq '^# fail 0$' "$work/knowledge.log" || { echo 'Selected knowledge suites failed' >&2; return 1; }
}

# The conversation continuity suite (#1021) pins mute, unmute and seeding; the resumption and watchdog suites
# ride along because the seed and the provider lifetime are what they assert.
group_live() {
  node_test_files --test-reporter=tap --test-timeout=30000 dist/test/live-continuity.test.js dist/test/live-dead-air.test.js dist/test/live-resumption.test.js dist/test/live-watchdog.test.js dist/test/heard-silence.test.js dist/test/live-mute.test.js dist/test/live-recovery.test.js dist/test/live-voice.test.js dist/test/live-selection.test.js dist/test/live-session.test.js dist/test/stop-phrase.test.js dist/test/live-summary.test.js dist/test/live-memory-note.test.js dist/test/research-steps.test.js dist/test/naya-logs.test.js dist/test/warm-context.test.js dist/test/people.test.js dist/test/trace.test.js dist/test/store-retention.test.js dist/test/timeline.test.js dist/test/research-patience-replay.test.js dist/test/lux-save-natural.test.js dist/test/voice-replay.test.js dist/test/live-rebuild-sweep.test.js dist/test/research-web.test.js dist/test/research-continuation.test.js dist/test/partial-research-turn-contract-replay.test.js dist/test/continuity-replay.test.js | tee "$work/test.log" || return 1
  grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected live session tests' >&2; return 1; }
  grep -Eq '^# fail 0$' "$work/test.log" || { echo 'Selected live session tests failed' >&2; return 1; }
}

# The canonical files inventory must publish the live production root, offline.
group_package() {
  npm pack --offline --ignore-scripts --pack-destination "$work" --json > "$work/pack.json" || return 1
  node --input-type=module - "$work/pack.json" <<'NODE' || return 1
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pack = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = pack[0].files.map(entry => entry.path);
assert.ok(files.some(path => path.startsWith('dist/live/')), 'published tarball must include dist/live');
NODE
  mkdir "$work/runtime" || return 1
  (cd "$work/runtime" && npm init -y >/dev/null && bash "$helper" "$work/runtime" install --offline --omit=dev --ignore-scripts --no-audit --no-fund "$work"/*.tgz >/dev/null) || return 1
  node --input-type=module - "$work/runtime" <<'NODE' || return 1
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
}

group_canary() {
  node --test test/canary.test.mjs || return 1
}

# The runner's own proof: a red in group 1 must not hide a red in group 3. Synthetic shell groups only,
# no build and no network, so it runs first and cheaply on every execution of this check.
group_selftest() { bash "$root/scripts/lib/check-groups-selftest.sh" || return 1; }

# Every group runs even when an earlier one failed; the fail list is complete before the exit.
group selftest group_selftest
group build group_build
group guidance group_guidance
group boundary group_boundary
group knowledge group_knowledge
group live group_live
group package group_package
group canary group_canary
group_report
