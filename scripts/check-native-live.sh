#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
root="$(pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-native-live.XXXXXX")
cleanup() {
  status=$?
  if [ "$status" -eq 0 ]; then rm -rf "$work"; else printf 'FAILED ARTIFACTS: %s\n' "$work" >&2; fi
}
trap cleanup EXIT
printf '# isolated synthetic test user config\n' > "$work/npm-user"
printf '# isolated synthetic test global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
printf 'NATIVE-LIVE source=%s UTC=%s\n' "$(git rev-parse HEAD)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
# Committed locks, offline only; canonical web/dist is intentionally separate from all fixture state.
npm --prefix server ci --offline --ignore-scripts --no-audit --no-fund
npm --prefix server run build
npm --prefix web ci --offline --ignore-scripts --no-audit --no-fund
npm --prefix web run build
# R2: existing authority owner uses its production compiler policy, once.
# enable-testing exports existing constructors only to test fixtures, not new production code.
swiftc -j 1 -num-threads 1 -whole-module-optimization -parse-as-library \
  -emit-module -emit-library -enable-testing -module-name DidiOwner \
  -emit-module-path "$work/DidiOwner.swiftmodule" \
  Sources/LuxDidi/CompanionClient.swift Sources/LuxDidi/NativeKeychainPolicy.swift -o "$work/libDidiOwner.dylib"
owner_flags=(-D DIDI_OWNER_MODULE -I "$work" -L "$work" -lDidiOwner -Xlinker -rpath -Xlinker "$work")
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Stage0.swift -o "$work/stage0"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift -o "$work/native-live"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/NativeLiveAudioRunner.swift -o "$work/native-audio"
"$work/native-audio"
# Compile the actual app source surface without launching audio or installing an app.
swiftc -parse-as-library Sources/LuxDidi/*.swift -o "$work/native-app"
# Isolated mutation sensitivity: compile a scratch copy, never alter the committed source or weaken a gate.
python3 - "$work/MutatedTransport.swift" <<'PY'
import pathlib, sys
source = pathlib.Path('Sources/LuxDidi/LiveSocketTransport.swift').read_text()
needle = '["cookie", "origin", "sec-websocket-protocol", "proxy-authorization"]'
assert source.count(needle) == 1
pathlib.Path(sys.argv[1]).write_text(source.replace(needle, '["origin", "sec-websocket-protocol", "proxy-authorization"]'))
PY
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "$work/MutatedTransport.swift" Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift -o "$work/native-live-mutated"
# Accepted dependency tests exercise real one-attach races, durable 1013, isolated revoke, journal exclusion and supervised cleanup.
node --test --test-reporter=tap --test-timeout=30000 \
  server/dist/test/live-gateway.test.js server/dist/test/live-session.test.js
# Independent gates all run even when an upstream owner defect fails one; any failure remains producer failure.
status=0
node Tests/DidiLiveTests/process.mjs "$work/native-live" "$work" || status=1
node Tests/DidiLiveTests/gateway.mjs "$work/stage0" "$work" "$work/native-live" "$work/native-live-mutated" || status=1
if [ "$status" -ne 0 ]; then exit "$status"; fi
echo 'NATIVE-LIVE CHECK PASS'
