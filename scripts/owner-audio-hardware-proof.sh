#!/usr/bin/env bash
# Owner-only command. It is the one place real voice processing is still exercised, because the
# routine checks now use the fake input seam (Sources/LuxDidi/NativeLiveAudioDevice.swift) and never
# enable voice processing, read a real input node, pin a device or run a real engine lifecycle.
#
# What it proves on this Mac, in one run, with no engine start and therefore no sound:
#  1. the real input node's format,
#  2. voice processing can be enabled on the input node and is then on for both IO nodes,
#  3. what the enable leaves the other-audio ducking at, and what minimum ducking reads back after
#     it, which is the read-back the app journals as audio_ducking_applied,
#  4. voice processing can be turned off again.
#
# No check, gate or agent calls this script. Enabling voice processing rebuilds the speaker DSP
# graph on this Mac, so it runs only when the owner asks for it:
#   DIDI_OWNER_HARDWARE_PROOF=1 bash scripts/owner-audio-hardware-proof.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${DIDI_OWNER_HARDWARE_PROOF:-}" != "1" ]; then
  printf 'owner-audio-hardware-proof: this enables real voice processing on this Mac.\n' >&2
  printf 'owner-audio-hardware-proof: no engine is started and nothing is audible.\n' >&2
  printf 'owner-audio-hardware-proof: re-run as DIDI_OWNER_HARDWARE_PROOF=1 bash %s\n' "$0" >&2
  exit 2
fi
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
minimum_macos="$(/usr/bin/plutil -extract LSMinimumSystemVersion raw Resources/Info.plist)"
target="arm64-apple-macosx$minimum_macos"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-owner-hardware.XXXXXX")
trap 'rm -rf "$work"' EXIT
cat > "$work/proof.swift" <<'SWIFT'
import AVFoundation
import Foundation

@main struct Proof {
    static func main() {
        let engine = AVAudioEngine()
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        print("input_format sampleRate=\(Int(format.sampleRate)) channels=\(format.channelCount)")
        do { try node.setVoiceProcessingEnabled(true) } catch {
            print("enable_failed domain=\((error as NSError).domain) code=\((error as NSError).code)")
            exit(1)
        }
        print("voice_processing input=\(node.isVoiceProcessingEnabled) output=\(engine.outputNode.isVoiceProcessingEnabled)")
        let afterEnable = node.voiceProcessingOtherAudioDuckingConfiguration
        print("ducking_after_enable advanced=\(afterEnable.enableAdvancedDucking.boolValue) level=\(afterEnable.duckingLevel.rawValue)")
        var configuration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration()
        configuration.enableAdvancedDucking = false
        configuration.duckingLevel = .min
        node.voiceProcessingOtherAudioDuckingConfiguration = configuration
        let applied = node.voiceProcessingOtherAudioDuckingConfiguration
        print("ducking_requested advanced=false level=\(configuration.duckingLevel.rawValue)")
        print("ducking_applied advanced=\(applied.enableAdvancedDucking.boolValue) level=\(applied.duckingLevel.rawValue)")
        try? node.setVoiceProcessingEnabled(false)
        print("voice_processing_released=\(!node.isVoiceProcessingEnabled)")
    }
}
SWIFT
scripts/with-compile-lock.sh -- swiftc -j 1 -num-threads 1 -swift-version 6 -parse-as-library \
  -target "$target" "$work/proof.swift" -o "$work/proof"
"$work/proof"
