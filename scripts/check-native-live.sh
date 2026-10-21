#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
root="$(pwd)"
# Every compile targets the app's declared minimum (same source as build-macos-app.sh), so
# SDK deprecations newer than the minimum stay warnings under -warnings-as-errors.
minimum_macos="$(/usr/bin/plutil -extract LSMinimumSystemVersion raw Resources/Info.plist)"
[[ "$minimum_macos" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo 'check-native-live.sh: macOS minimum must be a numeric version' >&2; exit 2; }
target="arm64-apple-macosx$minimum_macos"
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
bash scripts/npm-ci-offline.sh server
npm --prefix server run build
bash scripts/npm-ci-offline.sh web
npm --prefix web run build
# R2: existing authority owner uses its production compiler policy, once.
# enable-testing exports existing constructors only to test fixtures, not new production code.
swiftc -j 1 -num-threads 1 -whole-module-optimization -parse-as-library \
  -target "$target" \
  -emit-module -emit-library -enable-testing -module-name DidiOwner \
  -emit-module-path "$work/DidiOwner.swiftmodule" \
  Sources/LuxDidi/CompanionClient.swift Sources/LuxDidi/NativeKeychainPolicy.swift \
  Sources/LuxDidi/NativeServiceRecovery.swift -o "$work/libDidiOwner.dylib"
owner_flags=(-D DIDI_OWNER_MODULE -I "$work" -L "$work" -lDidiOwner -Xlinker -rpath -Xlinker "$work")
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Stage0.swift -o "$work/stage0"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  Tests/DidiLiveTests/CanonicalFrames.swift -o "$work/canonical-frames"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift -o "$work/native-live"
xcrun clang -fobjc-arc -target "$target" -c Tests/DidiLiveTests/AudioCallbackBridge.m -o "$work/audio-callback-bridge.o"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/AudioCallbackBridge.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/NativeLiveAudioRunner.swift "$work/audio-callback-bridge.o" -o "$work/native-audio"
"$work/native-audio"
# Deterministic playback-scheduling schedule replay: no engine, no tap, no permission request.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/AudioCallbackBridge.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/PlaybackSchedulingTests.swift "$work/audio-callback-bridge.o" -o "$work/playback-scheduling"
"$work/playback-scheduling"
# Contract C1 wait-cue scheduler replay: pure events in, cue times out. No clock, engine or audio.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/AudioCallbackBridge.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/WaitCueTests.swift "$work/audio-callback-bridge.o" -o "$work/wait-cue"
"$work/wait-cue"
# #283 orb band analyzer and playback-aligned output timeline: synthetic PCM only, no engine or audio.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/AudioCallbackBridge.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/OrbEnvelopeTests.swift "$work/audio-callback-bridge.o" -o "$work/orb-envelope"
"$work/orb-envelope"
# Presence state machine replay (council-presence-1017): an injected clock and injected
# effects only. No socket, no engine, no panel and no wait.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativePresence.swift Tests/DidiLiveTests/NativePresenceTests.swift -o "$work/native-presence"
"$work/native-presence"
# The held-mute race (D5): a fake host delivers every session callback late, and the tap
# receipt word comes from the same outcome the key builds. No socket, no engine, no wait.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/SingleKeyTrigger.swift \
  Tests/DidiLiveTests/MuteRaceTests.swift -o "$work/mute-race"
"$work/mute-race"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/Fixture.swift \
  Tests/DidiLiveTests/NativeLifetime.swift -o "$work/native-lifetime"
# Physical-device proof uses the production graph with no tap, output or permission request.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/NativeLiveEngineProbe.swift -o "$work/native-engine-probe"
"$work/native-engine-probe"
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeLiveJournal.swift Sources/LuxDidi/AudioOwner.swift Tests/DidiLiveTests/AudioOwnerTests.swift -o "$work/native-audio-owner"
"$work/native-audio-owner"
# The closed native-live end reasons, their timestamps and the diagnostics snapshot fields, no audio or supervisor.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  Sources/LuxDidi/NativeLiveJournal.swift Sources/LuxDidi/NativeDiagnosticsSnapshot.swift \
  Tests/DidiLiveTests/NativeLiveJournalTests.swift -o "$work/native-live-journal"
"$work/native-live-journal"
# Bridge contract proofs run without a window or audio device.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeBridge.swift Sources/LuxDidi/NativeMicMode.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/NativeBridgeTests.swift -o "$work/native-bridge-tests"
"$work/native-bridge-tests"
# The Mic Mode names, the receipt shape and the once-per-version prompt (#352) run on injected values.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeMicMode.swift Tests/DidiLiveTests/NativeMicModeTests.swift -o "$work/native-mic-mode-tests"
"$work/native-mic-mode-tests"
# Native open allowlist, symlink escape, app resolution and the rate limit run with an injected opener.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Tests/DidiLiveTests/NativeActionsTests.swift -o "$work/native-actions"
"$work/native-actions"
# Launch visibility, single-instance guard and drag-band geometry run without a window.
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/SingleInstanceGuard.swift Sources/LuxDidi/NativeBridge.swift Sources/LuxDidi/NativeMicMode.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/LaunchVisibilityTests.swift -o "$work/launch-visibility-tests"
"$work/launch-visibility-tests"
# Compile the actual app source surface without launching audio or installing an app.
swiftc -parse-as-library Sources/LuxDidi/*.swift -target "$target" -o "$work/native-app"
# Isolated mutation sensitivity: compile a scratch copy, never alter the committed source or weaken a gate.
python3 - "$work/MutatedTransport.swift" <<'PY'
import pathlib, sys
source = pathlib.Path('Sources/LuxDidi/LiveSocketTransport.swift').read_text()
needle = '["cookie", "origin", "sec-websocket-protocol", "proxy-authorization"]'
assert source.count(needle) == 1
pathlib.Path(sys.argv[1]).write_text(source.replace(needle, '["origin", "sec-websocket-protocol", "proxy-authorization"]'))
PY
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift "$work/MutatedTransport.swift" Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift -o "$work/native-live-mutated"
# Accepted dependency tests exercise real one-attach races, durable 1013, isolated revoke, journal exclusion and supervised cleanup.
node_test_files --test-reporter=tap --test-timeout=30000 \
  server/dist/test/live-gateway.test.js server/dist/test/live-session.test.js
# Independent gates all run even when an upstream owner defect fails one; any failure remains producer failure.
status=0
node Tests/DidiLiveTests/canonical-frames.mjs "$work/canonical-frames" "$work/canonical-frames-work" || status=1
node Tests/DidiLiveTests/process.mjs "$work/native-live" "$work" || status=1
node Tests/DidiLiveTests/gateway.mjs "$work/stage0" "$work" "$work/native-live" "$work/native-live-mutated" || status=1
for mode in production-native-request native-lifetime-retained native-lifetime-fresh native-listening-late; do
  mkdir "$work/$mode"
  node Tests/DidiLiveTests/gateway.mjs "$work/native-lifetime" "$work/$mode" unused unused "--$mode" || status=1
done
if [ "$status" -ne 0 ]; then exit "$status"; fi
echo 'NATIVE-LIVE CHECK PASS'
