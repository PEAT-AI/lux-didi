import AVFoundation
import Foundation

func audioRequire(_ value: Bool, _ message: String) throws {
    if !value { throw NSError(domain: message, code: 1) }
}

@main struct NativeLiveAudioRunner {
    static func tone(_ format: AVAudioFormat, start: Int, count: Int) -> AVAudioPCMBuffer {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
        buffer.frameLength = AVAudioFrameCount(count)
        for i in 0..<count {
            let sample = Float(sin(Double(start + i) * 2 * .pi * 440 / 44100) * 0.25)
            buffer.floatChannelData![0][i] = sample
            buffer.floatChannelData![1][i] = sample
        }
        return buffer
    }
    @MainActor static func main() async {
        do {
            let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
            let reference = try NativePCMConverter(input: format)
            var expected = try reference.append(tone(format, start: 0, count: 44100))
            expected.append(try reference.finish())
            let converter = try NativePCMConverter(input: format)
            var actual = Data(), offset = 0, index = 0
            let chunks = [127, 701, 11, 1024, 83]
            while offset < 44100 {
                let count = min(chunks[index % chunks.count], 44100 - offset)
                actual.append(try converter.append(tone(format, start: offset, count: count)))
                offset += count; index += 1
            }
            actual.append(try converter.finish())
            try audioRequire(converter.output.sampleRate == 16000 && converter.output.channelCount == 1 && converter.output.commonFormat == .pcmFormatInt16, "mono PCM16 16k output")
            try audioRequire(actual == expected, "streaming converter continuity against whole-input reference")
            var assembler = NativePCMFrameAssembler()
            let frames = assembler.append(actual)
            try audioRequire(!frames.isEmpty && frames.allSatisfy { $0.count == 640 }, "complete 640-byte frames")
            try audioRequire(frames.reduce(into: Data()) { $0.append($1) } == actual.prefix(frames.count * 640), "frame continuity")
            try audioRequire(assembler.discardPartial() == actual.count % 640, "final partial frame discarded, never padded")
            var ring = NativePCMFrameRing()
            for i in 0..<10 { ring.push(Data(repeating: UInt8(i), count: 640)) }
            try audioRequire(ring.drops == 2 && ring.pop()?.first == 2, "eight-frame ring drops oldest and counts")
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: format))
            capture.append(tone(format, start: 0, count: 4410))
            try audioRequire(capture.next().0?.count == 640, "capture produces complete frames")
            capture.setMuted(true)
            capture.append(tone(format, start: 4410, count: 4410))
            try audioRequire(capture.next().0 == nil, "mute discards queued frames and suppresses new frames")
            capture.setMuted(false)
            capture.append(tone(format, start: 8820, count: 4410))
            try audioRequire(capture.next().0?.count == 640, "unmute resumes the same converter and capture buffer")
            capture.stop(); capture.stop()
            let device = NativeLiveAudioDevice()
            try audioRequire(!device.hasEngine && !device.isCapturing, "construction does not create audio engine")
            device.stop(); device.stop()
            try audioRequire(!device.hasEngine, "teardown idempotent")
            print("PASS silent real AVAudioConverter irregular stereo tone, frame continuity, partial discard, ring overflow, lazy device")
            print("UNVERIFIED hardware: voice processing on both IO nodes and physical device loss; Start verifies both enabled flags")
        } catch { print("FAIL native audio: \(error)"); exit(1) }
    }
}
