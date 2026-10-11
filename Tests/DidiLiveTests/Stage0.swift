import Foundation

@main struct Stage0 {
    static func main() async {
        var phase = "bootstrap"
        do {
            let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
            let session = isolatedSession()
            defer { session.invalidateAndCancel() }
            let http = ProbeHTTP(fixture: fixture, session: session)
            for header in ["Cookie", "Origin", "Host", "x-didi-authority-epoch", "x-didi-live-profile"] {
                phase = "reject " + header
                let id = try await http.create("stage0-bad-" + header)
                var request = http.request(id)
                request.setValue("synthetic-invalid", forHTTPHeaderField: header)
                let socket = session.webSocketTask(with: request)
                socket.resume()
                var rejected = false
                do { _ = try await socket.receive() } catch { rejected = true }
                socket.cancel(with: .goingAway, reason: nil)
                try require(rejected, "bad header was not rejected")
            }
            phase = "valid attach"
            let id = try await http.create("stage0-good")
            let socket = session.webSocketTask(with: http.request(id))
            socket.resume()
            let frame = try await socket.receive()
            guard case .string(let marker) = frame else { throw ProbeError.assertion("expected ready marker") }
            let object = try JSONSerialization.jsonObject(with: Data(marker.utf8)) as? [String: Any]
            try require(object?["type"] as? String == "ready", "actual ready grammar")
            try await socket.send(.data(Data(repeating: 0, count: 8)))
            try await socket.send(.string("{\"type\":\"endAudioStream\"}"))
            try await socket.send(.string("{\"type\":\"close\"}"))
            socket.cancel(with: .normalClosure, reason: nil)
            print("PASS Stage0 actual URLSession request + five rejected headers")
            phase = "redirect"
            let redirectSocket = session.webSocketTask(with: http.request(fixture.redirectSessionID))
            redirectSocket.resume()
            var redirectRejected = false
            do { _ = try await redirectSocket.receive() } catch { redirectRejected = true }
            redirectSocket.cancel(with: .goingAway, reason: nil)
            try require(redirectRejected, "redirect was followed")
            print("PASS Stage0 redirect rejected (trap counter verified by parent fixture)")
        } catch {
            // No raw URLSession/HTTP error or response payload is printed.
            let reason: String
            if case ProbeError.assertion(let message) = error { reason = message }
            else if let failure = error as? URLError { reason = "URLSession code " + String(failure.code.rawValue) }
            else { reason = "controlled transport failure" }
            FileHandle.standardError.write(Data(("FAIL Stage0 " + phase + ": " + reason + "\n").utf8))
            exit(1)
        }
    }
}
