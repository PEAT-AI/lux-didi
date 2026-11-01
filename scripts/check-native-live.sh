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
# One compiler job per invocation: swift-driver must never fan out one frontend per core.
swift_serial=(-j 1 -num-threads 1)
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
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -whole-module-optimization -parse-as-library \
  -target "$target" \
  -emit-module -emit-library -enable-testing -module-name DidiOwner \
  -emit-module-path "$work/DidiOwner.swiftmodule" \
  Sources/LuxDidi/CompanionClient.swift Sources/LuxDidi/NativeKeychainPolicy.swift \
  Sources/LuxDidi/NativeServiceRecovery.swift -o "$work/libDidiOwner.dylib"
owner_flags=(-D DIDI_OWNER_MODULE -I "$work" -L "$work" -lDidiOwner -Xlinker -rpath -Xlinker "$work")
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -target "$target" \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Stage0.swift -o "$work/stage0"
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  Tests/DidiLiveTests/CanonicalFrames.swift "$work/avfaudio-guard.o" -o "$work/canonical-frames"
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift "$work/avfaudio-guard.o" -o "$work/native-live"
xcrun clang -fobjc-arc -target "$target" -c Tests/DidiLiveTests/AudioCallbackBridge.m -o "$work/audio-callback-bridge.o"
# The AVFAudio boundary guard: Objective-C, because only it can catch what AVFAudio raises.
xcrun clang -fobjc-arc -target "$target" -c Sources/LuxDidi/AVFAudioGuard.m -o "$work/avfaudio-guard.o"
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/NativeLiveAudioRunner.swift \
  Tests/DidiLiveTests/VoiceProcessingSnapshotTests.swift Tests/DidiLiveTests/HeadphoneRouteTests.swift \
  Tests/DidiLiveTests/MicWatchdogTests.swift \
  "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/native-audio"
"$work/native-audio"
# Deterministic playback-scheduling schedule replay: no engine, no tap, no permission request.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/PlaybackSchedulingTests.swift "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/playback-scheduling"
"$work/playback-scheduling"
# Contract C1 wait-cue scheduler replay: pure events in, cue times out. No clock, engine or audio.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/WaitCueTests.swift "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/wait-cue"
"$work/wait-cue"
# Issue #529 connecting ring: presence in, ring schedule and PCM out. No engine and no audio device.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/ConnectingRing.swift \
  Tests/DidiLiveTests/ConnectingRingTests.swift "$work/avfaudio-guard.o" -o "$work/connecting-ring"
"$work/connecting-ring"
# #283 orb band analyzer and playback-aligned output timeline: synthetic PCM only, no engine or audio.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/OrbEnvelopeTests.swift "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/orb-envelope"
"$work/orb-envelope"
# Presence state machine replay (council-presence-1017): an injected clock and injected
# effects only. No socket, no engine, no panel and no wait.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativePresence.swift Tests/DidiLiveTests/NativePresenceTests.swift "$work/avfaudio-guard.o" -o "$work/native-presence"
"$work/native-presence"
# #613: the owner-stop latch and the cold path of an uncertain session. Injected effects only.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/ConnectingRing.swift \
  Sources/LuxDidi/NativeLiveConversation.swift Sources/LuxDidi/SingleInstanceGuard.swift \
  Sources/LuxDidi/NativeAlarmRelaunch.swift \
  Tests/DidiLiveTests/NativeStopLatchTests.swift "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/native-stop-latch"
"$work/native-stop-latch"
# The held-mute race (D5): a fake host delivers every session callback late. No socket,
# no engine, no panel and no wait.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativePresence.swift Tests/DidiLiveTests/MuteRaceTests.swift "$work/avfaudio-guard.o" -o "$work/mute-race"
"$work/mute-race"
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/NativeLiveConversation.swift Tests/DidiLiveTests/Fixture.swift \
  Tests/DidiLiveTests/NativeLifetime.swift "$work/avfaudio-guard.o" -o "$work/native-lifetime"
# Physical-device proof uses the production graph with no tap, output or permission request.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/NativeLiveEngineProbe.swift "$work/avfaudio-guard.o" -o "$work/native-engine-probe"
"$work/native-engine-probe"
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library -import-objc-header Tests/DidiLiveTests/DidiNativeBridges.h \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Sources/LuxDidi/LiveSocketTransport.swift Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" \
  Sources/LuxDidi/NativeLiveOperatorHTTP.swift Sources/LuxDidi/AudioOwner.swift Sources/LuxDidi/NativeLiveAudioDevice.swift \
  Sources/LuxDidi/NativeLiveJournal.swift Tests/DidiLiveTests/AudioOwnerTests.swift "$work/audio-callback-bridge.o" "$work/avfaudio-guard.o" -o "$work/native-audio-owner"
"$work/native-audio-owner"
# T2: the exception mechanism itself, as its own executable: if the guard ever stops protecting the
# concurrency runtime, this process dies instead of failing one line inside a longer run.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -import-objc-header Sources/LuxDidi/AVFAudioGuard.h \
  -target "$target" \
  Tests/DidiLiveTests/NativeExecutorMechanism.swift "$work/avfaudio-guard.o" -o "$work/native-executor-mechanism"
"$work/native-executor-mechanism"
# The closed native-live end reasons, their timestamps and the diagnostics snapshot fields, no audio or supervisor.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  Sources/LuxDidi/NativeLiveJournal.swift Sources/LuxDidi/NativeDiagnosticsSnapshot.swift \
  Tests/DidiLiveTests/NativeLiveJournalTests.swift "$work/avfaudio-guard.o" -o "$work/native-live-journal"
"$work/native-live-journal"
# Bridge contract proofs run without a window or audio device.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeBridge.swift Sources/LuxDidi/NativeMicMode.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Tests/DidiLiveTests/NativeBridgeTests.swift "$work/avfaudio-guard.o" -o "$work/native-bridge-tests"
"$work/native-bridge-tests"
# The Mic Mode names, the receipt shape and the once-per-version prompt (#352) run on injected values.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeMicMode.swift Tests/DidiLiveTests/NativeMicModeTests.swift "$work/avfaudio-guard.o" -o "$work/native-mic-mode-tests"
"$work/native-mic-mode-tests"
# Native open allowlist, symlink escape, app resolution and the rate limit run with an injected opener.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift Tests/DidiLiveTests/NativeActionsTests.swift "$work/avfaudio-guard.o" -o "$work/native-actions"
"$work/native-actions"
# Launch visibility, single-instance guard and drag-band geometry run without a window.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/SingleInstanceGuard.swift Sources/LuxDidi/NativeBridge.swift Sources/LuxDidi/NativeMicMode.swift \
  Sources/LuxDidi/NativeLiveJournal.swift Sources/LuxDidi/NativeAlarmRelaunch.swift \
  Tests/DidiLiveTests/LaunchVisibilityTests.swift "$work/avfaudio-guard.o" -o "$work/launch-visibility-tests"
"$work/launch-visibility-tests"
# #107: the alarm shell's routing, its permission honesty and its one relaunch agent. Headless:
# a recorder instead of launchctl, a synthetic session state, and no window or audio.
bash Tests/DidiAlarmTests/check-alarm-shell.sh
# #619 and #620: the launch and reopen matrix, the deferred startup prompts and the orb
# screen-change frame. Recording fakes only: no window is shown and no display is changed.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/SingleInstanceGuard.swift Sources/LuxDidi/PresentationCoordinator.swift Sources/LuxDidi/NativeAlarmRelaunch.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativeMiniOrb.swift Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/ConnectingRing.swift \
  Tests/DidiLiveTests/WindowRoutingTests.swift "$work/avfaudio-guard.o" -o "$work/window-routing-tests"
"$work/window-routing-tests"
# C-QUIT: the status item is visible and its menu carries target and action without app activation,
# every click and quit stage reaches the native file log, and a clean quit beats the three second net.
# Virtual clock and a fake host: no app, window, audio device or installed host is touched.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/SingleInstanceGuard.swift Sources/LuxDidi/PresentationCoordinator.swift \
  Sources/LuxDidi/NativeAlarmRelaunch.swift \
  Sources/LuxDidi/NativeLiveJournal.swift \
  Sources/LuxDidi/NativeMiniOrb.swift Sources/LuxDidi/NativePresence.swift Sources/LuxDidi/ConnectingRing.swift \
  Tests/DidiLiveTests/QuitSurfaceTests.swift "$work/avfaudio-guard.o" -o "$work/quit-surface-tests"
"$work/quit-surface-tests"
# Compile the actual app source surface without launching audio or installing an app.
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library Sources/LuxDidi/*.swift -target "$target" "$work/avfaudio-guard.o" -o "$work/native-app"
# Isolated mutation sensitivity: compile a scratch copy, never alter the committed source or weaken a gate.
python3 - "$work/MutatedTransport.swift" <<'PY'
import pathlib, sys
source = pathlib.Path('Sources/LuxDidi/LiveSocketTransport.swift').read_text()
needle = '["cookie", "origin", "sec-websocket-protocol", "proxy-authorization"]'
assert source.count(needle) == 1
pathlib.Path(sys.argv[1]).write_text(source.replace(needle, '["origin", "sec-websocket-protocol", "proxy-authorization"]'))
PY
scripts/with-compile-lock.sh -- swiftc "${swift_serial[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -import-objc-header Sources/LuxDidi/AVFAudioGuard.h -parse-as-library \
  -target "$target" \
  Sources/LuxDidi/NativeActions.swift "$work/MutatedTransport.swift" Sources/LuxDidi/LiveSessionCoordinator.swift \
  "${owner_flags[@]}" Sources/LuxDidi/NativeLiveOperatorHTTP.swift \
  Tests/DidiLiveTests/Fixture.swift Tests/DidiLiveTests/Runner.swift "$work/avfaudio-guard.o" -o "$work/native-live-mutated"
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
