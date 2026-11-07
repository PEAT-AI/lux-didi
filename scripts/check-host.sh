#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
. "$(cd "$(dirname "$0")" && pwd)/lib-toolchain.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
toolchain_blocked || exit $?
# Gate: stdout is the supervised protocol pipe. The only stdout writer in supervised mode is
# writeProtocolFrame in server/host/index.ts, and it uses process.stdout.write. A console.log in
# server/ non-test source can reach the native supervisor's stdout after the ready frame, which
# NativeServiceSupervisor reads as invalidOutput and restarts the service.
console_log=$(grep -rn --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist 'console\.log(' server | grep -v '/test/' | grep -v '^server/eval/' || true)
if [ -n "$console_log" ]; then
  echo 'console.log is forbidden in server/ non-test source: stdout is the supervised protocol pipe; only writeProtocolFrame may write it.' >&2
  echo "$console_log" >&2
  exit 1
fi
# server/eval is excluded above because it is a developer tool, never compiled into the service
# (its own tsconfig.eval.json): its console.log can never reach the supervised stdout.
# The exclusion holds only while no production source imports from eval/, so gate that here.
eval_imports=$(grep -rn --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=eval --exclude-dir=test "from '[^']*eval/" server || true)
if [ -n "$eval_imports" ]; then
  echo 'no production source may import from server/eval: the eval harness is a developer tool outside the service build.' >&2
  echo "$eval_imports" >&2
  exit 1
fi
# Exercise the documented build producer, using the current compiler layout.
bash scripts/run-local.sh --build-only
# BOX-R1: the Swift steps below (native canary, Mac app build, installed alarm check) need macOS with a
# Swift compiler. Where it is absent the check says so once and still runs every Node test, which is the part
# a non-macOS host owns; on a Mac with swiftc every step runs unchanged.
swift_steps=1
if [ "$(uname -s)" = Darwin ] && command -v swiftc >/dev/null 2>&1; then
  swift_steps=0
else
  echo "check-host: the Swift steps need macOS with swiftc, so this host skips them; every Node test below still runs" >&2
fi
# Pure fake canary records: no installed app, provider or native shell is contacted.
node --test server/test/canary.test.mjs
# Compile the complete shell, including its idle alarm subscription, without launching it.
if [ "$swift_steps" -eq 0 ]; then
  (
    native_work=$(mktemp -d "${TMPDIR:-/tmp}/didi-alarm-build.XXXXXX")
    trap 'rm -rf "$native_work"' EXIT
    scripts/with-compile-lock.sh -- swiftc -j 1 -num-threads 1 -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
      Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
      server/test/canary-native.swift -o "$native_work/canary-native"
    "$native_work/canary-native"
    bash scripts/build-macos-app.sh "$native_work/LuxDidi.app" --cache "$native_work/cache"
  )
fi
# Exercise the discovered installed alarm check against its offline staged package.
if [ "$swift_steps" -eq 0 ]; then bash scripts/check-installed-alarm.sh; fi
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for file in server/dist/test/host.test.js server/dist/test/http.test.js server/dist/test/host-stdout.test.js server/dist/test/connector-publication.test.js server/dist/test/host-compose-wire.test.js server/dist/test/host-log.test.js server/dist/test/log-envelope.test.js server/dist/test/trello-board.test.js server/dist/test/connector-recovery.test.js server/dist/test/trello-guidance.test.js server/dist/test/wire-envelope.test.js server/dist/test/open-actions.test.js server/dist/test/tools-builtin-intent.test.js server/dist/test/live-summary.test.js server/dist/test/timeline.test.js server/dist/test/alarm-mode.test.js server/dist/test/alarm-shell.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
http_status=0
node_test_files --test-reporter=tap --test-timeout=15000 server/dist/test/host.test.js server/dist/test/http.test.js server/dist/test/host-stdout.test.js server/dist/test/connector-publication.test.js server/dist/test/host-compose-wire.test.js server/dist/test/host-log.test.js server/dist/test/log-envelope.test.js server/dist/test/trello-board.test.js server/dist/test/connector-recovery.test.js server/dist/test/trello-guidance.test.js server/dist/test/wire-envelope.test.js server/dist/test/open-actions.test.js server/dist/test/tools-builtin-intent.test.js server/dist/test/live-summary.test.js server/dist/test/timeline.test.js server/dist/test/alarm-mode.test.js server/dist/test/alarm-shell.test.js | tee "$log" || http_status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
# The CLI sign-in (--mongoose-login) on the built host, against the live discovery shape.
node server/test/mongoose-login.integration.mjs || http_status=$?
# Preserve every HTTP failure while still collecting discriminating real-browser proof.
# Deliberately not the web fixture producer: this drives the shipped UI on the real host.
browser_status=0
lux-browser-slot run --priority worker --want 1 --wait 1800 -- node server/test/host-browser.mjs || browser_status=$?
if [ "$http_status" -ne 0 ]; then exit "$http_status"; fi
exit "$browser_status"
