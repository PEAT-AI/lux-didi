import AppKit
import Foundation

/// Host control frames through the real native decoder, allowlist, opener and reply encoder.
@main struct NativeActionsRoundTripTests {
    actor Recorder {
        var urls: [String] = []
        func open(_ url: URL) -> Bool { urls.append(url.absoluteString); return true }
    }
    static func main() async throws {
        let recorder = Recorder()
        let actions = NativeActions(opener: { url, _ in await recorder.open(url) }, clock: { Date(timeIntervalSince1970: 1000) })
        let targets = [
            "https://www.google.com/maps/search/?api=1&query=Odemira",
            "https://www.google.com/maps/dir/?api=1&destination=Odemira",
            "https://plantix.net/",
            "https://www.google.com/search?q=drip+irrigation"
        ]
        for (index, target) in targets.enumerated() {
            let id = "synthetic-\(index)"
            let data = try JSONSerialization.data(withJSONObject: ["type": "native_action", "id": id, "action": "open_url", "target": target])
            guard let frame = NativeActionFrame.control(String(decoding: data, as: UTF8.self)) else { fatalError("A4 decode \(index)") }
            let result = await actions.perform(frame.action, target: frame.target)
            guard result.code == .opened else { fatalError("A4 open \(index): \(result.code)") }
            let reply = try JSONSerialization.jsonObject(with: Data(NativeActionReply(id: frame.id, result: result).json.utf8)) as! [String: Any]
            guard reply["type"] as? String == "native_action_result", reply["id"] as? String == id,
                  reply["ok"] as? Bool == true, reply["code"] as? String == "opened" else { fatalError("A4 ack \(index)") }
        }
        guard await recorder.urls == targets else { fatalError("A4 opener URLs") }
        guard await actions.perform(.openURL, target: targets[0]).code == .opened else { fatalError("A4 fifth open") }
        guard await actions.perform(.openURL, target: targets[0]).code == .notAllowed else { fatalError("A4 sixth open must be rate limited") }
        guard await recorder.urls.count == 5 else { fatalError("A4 refused open reached opener") }
        print("A4 PASS: maps, directions, site, search native round trips; sixth open refused")
    }
}
