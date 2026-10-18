#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# Gate: stdout is the supervised protocol pipe. The only stdout writer in supervised mode is
# writeProtocolFrame in server/host/index.ts, and it uses process.stdout.write. A console.log in
# server/ non-test source can reach the native supervisor's stdout after the ready frame, which
# NativeServiceSupervisor reads as invalidOutput and restarts the service.
console_log=$(grep -rn --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist 'console\.log(' server | grep -v '/test/' || true)
if [ -n "$console_log" ]; then
  echo 'console.log is forbidden in server/ non-test source: stdout is the supervised protocol pipe; only writeProtocolFrame may write it.' >&2
  echo "$console_log" >&2
  exit 1
fi
# Exercise the documented build producer, using the current compiler layout.
bash scripts/run-local.sh --build-only
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for file in server/dist/test/host.test.js server/dist/test/http.test.js server/dist/test/host-stdout.test.js server/dist/test/connector-publication.test.js server/dist/test/host-log.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
http_status=0
node_test_files --test-reporter=tap --test-timeout=15000 server/dist/test/host.test.js server/dist/test/http.test.js server/dist/test/host-stdout.test.js server/dist/test/connector-publication.test.js server/dist/test/host-log.test.js | tee "$log" || http_status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'Zero selected tests' >&2; exit 1; }
# Preserve every HTTP failure while still collecting discriminating real-browser proof.
# Deliberately not the web fixture producer: this drives the shipped UI on the real host.
browser_status=0
lux-browser-slot run --priority worker --want 1 --wait 1800 -- node server/test/host-browser.mjs || browser_status=$?
if [ "$http_status" -ne 0 ]; then exit "$http_status"; fi
exit "$browser_status"
