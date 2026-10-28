import Foundation

// Headless supervisor lifecycle assertions shared with the companion target.
@MainActor enum SupervisorGraceProof {
    private static func expect(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "SupervisorGraceProof: " + label, code: 1) }
        print("PASS: " + label)
    }
    // C-START10: virtual child lifetime, no sleep, audio, installed app or real process signals.
    static func run() async throws {
        var running = true
        var elapsed: UInt64 = 0
        var signals: [String] = []
        try await NativeServiceStop.escalate(sleep: { budget in
            // The synthetic summary completes eight seconds after stdin closes.
            elapsed += min(budget, 8_000_000_000)
            if budget >= 8_000_000_000 { running = false }
        }, isRunning: { running }, terminate: { signals.append("TERM") }, forceKill: { signals.append("KILL") })
        try expect(elapsed == 8_000_000_000 && signals.isEmpty,
            "C-START10: app quit lets an eight-second summary finish without TERM or KILL")
        running = true; signals = []
        var waits: [UInt64] = []
        try await NativeServiceStop.escalate(sleep: { waits.append($0) }, isRunning: { running },
            terminate: { signals.append("TERM") }, forceKill: { signals.append("KILL") })
        try expect(waits == [30_000_000_000, 500_000_000] && signals == ["TERM", "KILL"],
            "C-START10: an unresponsive child has a bounded summary grace then targeted escalation")
        signals = []
        try await NativeServiceStop.escalate(sleep: { _ in }, isRunning: { running },
            terminate: { running = false; signals.append("TERM") }, forceKill: { signals.append("KILL") })
        try expect(signals == ["TERM"], "C-START10: a child that exits on TERM is never killed")
    }
}
