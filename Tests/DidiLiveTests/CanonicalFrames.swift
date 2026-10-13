import Foundation

private struct Case: Decodable {
    let label: String
    let wire: String
    let partial: Bool?
}
private struct Input: Decodable { let canonical: [Case]; let malformed: [Case] }

@main struct CanonicalFrames {
    static func main() throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        var rejected: [String] = [], malformedAccepted: [String] = []
        var partialStayedUnknown = true
        for item in input.canonical {
            do {
                let frame = try LiveSocketTransport.decode(.string(item.wire))
                if item.partial == true {
                    guard case .marker(let marker) = frame, marker.finished == nil else {
                        partialStayedUnknown = false; continue
                    }
                }
            } catch { rejected.append(item.label) }
        }
        for item in input.malformed {
            do { _ = try LiveSocketTransport.decode(.string(item.wire)); malformedAccepted.append(item.label) }
            catch LiveClientError.invalidFrame { }
        }
        let pass = rejected.isEmpty && malformedAccepted.isEmpty && partialStayedUnknown
        let receipt: [String: Any] = ["canonicalCount": input.canonical.count, "canonicalRejected": rejected,
            "malformedCount": input.malformed.count, "malformedAccepted": malformedAccepted,
            "partialStayedUnknown": partialStayedUnknown, "success": pass]
        try FileHandle.standardOutput.write(contentsOf: JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]))
        try FileHandle.standardOutput.write(contentsOf: Data([10]))
        exit(pass ? 0 : 1)
    }
}
