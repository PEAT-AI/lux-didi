import AppKit
import Foundation

// Real protected-host wire, actual native field/actions, and deterministic failure UI.
// Synthetic data only. The existing companion producer owns the hardware lease.
@MainActor enum OwnerProfileEditorTests {
    private static func require(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "SyntheticPersonaEditor", code: 1,
            userInfo: [NSLocalizedDescriptionKey: label]) }
        print("PASS: persona editor \(label)")
    }
    static func run(node: String, proof: URL) async throws {
        guard let root = ProcessInfo.processInfo.environment["LUX_COMPANION_SOURCE_ROOT"] else {
            throw NSError(domain: "SyntheticPersonaEditorSetup", code: 1)
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-persona-synthetic-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = Pipe(), output = Pipe(), errors = Pipe(), host = Process()
        host.executableURL = URL(fileURLWithPath: node)
        host.arguments = [root + "/server/dist/host/index.js", "--supervised", "--data-dir", directory.appendingPathComponent("state").path,
                          "--web-root", root + "/web/dist", "--port", "0"]
        host.standardInput = input; host.standardOutput = output; host.standardError = errors
        try host.run()
        defer {
            try? input.fileHandleForWriting.close()
            if host.isRunning { host.terminate() }
            host.waitUntilExit()
        }
        let start = try JSONSerialization.data(withJSONObject: ["type": "start", "schemaVersion": 1, "nonce": UUID().uuidString])
        try input.fileHandleForWriting.write(contentsOf: start + Data([10]))
        var ready: [String: Any]?
        for try await line in output.fileHandleForReading.bytes.lines {
            ready = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            break
        }
        guard let origin = ready?["origin"] as? String else { throw NSError(domain: "SyntheticPersonaEditorSetup", code: 2) }
        let token = try String(contentsOf: directory.appendingPathComponent("state/admin-credential"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let descriptor = try ServiceDescriptor(origin: origin, credentialService: "synthetic", credentialAccount: "persona-fixture")
        guard let url = URL(string: origin + "/api/v1/owner-profile"), descriptor.allows(url) else {
            throw NSError(domain: "SyntheticPersonaEditorSetup", code: 3)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try require((response as? HTTPURLResponse)?.statusCode == 200, "native bearer reads actual owner editor state")
        try require((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Cache-Control") == "no-store", "private response is no-store")
        let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let document = envelope?["data"] as? [String: Any]
        let active = document?["active"] as? [String: Any], profile = active?["profile"] as? [String: Any]
        try require(profile?["displayName"] as? String == "Lux Didi", "truthful active default remains Lux Didi")
        try require(document?["pendingActivation"] as? Bool == false, "initial state is not falsely pending")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        let (_, denied) = try await session.data(for: request)
        try require([401, 403].contains((denied as? HTTPURLResponse)?.statusCode ?? 0), "native profile rejects Origin even with bearer")
        let client = CompanionClient(descriptor: descriptor, credential: { token })
        let editor = OwnerProfileEditor(client: client); editor.open(); await editor.operation?.value
        try require(editor.window?.isVisible == true && editor.document?.valid == true, "actual native form is rendered from guarded client data")
        try require(editor.nameField.stringValue == "Lux Didi" && !editor.publicBase.isEditable && !editor.activeContent.isEditable && !editor.savedContent.isEditable,
                    "actual saved prepopulation and generic active saved readonly panes")
        try require(editor.styleClass.titleOfSelectedItem == "Private" && editor.loreClass.titleOfSelectedItem == "Private"
                    && editor.privacyChoice.state == .off && !editor.saveButton.isEnabled, "first save requires visible initially private choice")
        try edit(editor, name: "Naya", character: "SYNTHETIC_CHARACTER_EDIT", about: "SYNTHETIC_ABOUT_EDIT")
        editor.privacyChoice.performClick(nil)
        try require(editor.saveButton.isEnabled, "actual field edits and explicit privacy confirmation enable save")
        try snapshot(editor, proof.appendingPathComponent("persona-editor-draft.png"))
        editor.saveButton.performClick(nil); await editor.operation?.value
        let saved = try await client.readOwnerProfile()
        try require(saved.saved.profile.displayName == "Naya" && saved.saved.profile.style?.text == "SYNTHETIC_CHARACTER_EDIT"
                    && saved.saved.profile.lore?.text == "SYNTHETIC_ABOUT_EDIT" && saved.saved.profile.style?.dataClass == .privateData,
                    "actual CompanionClient PUT persists all editable fields and classification")
        try require(saved.active.profile.displayName == "Lux Didi" && saved.pendingActivation
                    && editor.activeContent.string.contains("Lux Didi") && editor.savedContent.string.contains("Naya"), "save does not activate captured host and visible saved active content is truthful")
        let path = directory.appendingPathComponent("state/owner-profile.json")
        let permissions = try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber
        try require(permissions?.intValue == 0o600 && saved.saved.profile.ownerId == saved.active.profile.ownerId, "actual saved file is protected and stable owner ID is unchanged")
        try snapshot(editor, proof.appendingPathComponent("persona-editor-saved.png"))
        // Same native form/action with deterministic errors, not extra servers or timeout waits.
        editor.close()
        try await lostReply(saved: saved, descriptor: descriptor, proof: proof)
        for (failure, marker, uncertain) in [(CompanionError.rejected(409), "Conflict", true),
                                            (CompanionError.rejected(503), "uncertain", true),
                                            (CompanionError.invalidResponse, "unknown", true),
                                            (CompanionError.rejected(400), "validation", false),
                                            (CompanionError.rejected(500), "could not", false),
                                            (CompanionError.unavailable, "unknown", true)] {
            let transport = SyntheticProfileTransport(saved, failure)
            let form = OwnerProfileEditor(client: transport); form.open(); await form.operation?.value
            try edit(form, name: "Unsaved synthetic name", character: "SYNTHETIC_RETAIN_CHARACTER", about: "SYNTHETIC_RETAIN_ABOUT")
            let draft = form.edits
            form.saveButton.performClick(nil); await form.operation?.value
            try require(form.edits == draft && form.notice.stringValue.contains(marker) && transport.saves == 1,
                        "failure retains all unsaved fields and shows explicit outcome without automatic retry")
            try require(form.saveButton.isEnabled == !uncertain, "unknown conflict or durability state requires intentional readback")
            if uncertain {
                form.readbackButton.performClick(nil); await form.operation?.value
                try require(form.edits == draft && transport.reads == 2 && transport.saves == 1
                            && form.savedContent.string.contains("Naya"), "readback exposes actual saved content while keeping unsaved fields")
            }
            form.reloadButton.performClick(nil)
            try require(form.edits == draft && form.reloadButton.title.contains("Discard"), "reload cannot silently discard unsaved edits")
            if marker == "uncertain" { try snapshot(form, proof.appendingPathComponent("persona-editor-readback.png")) }
            form.reloadButton.performClick(nil); await form.operation?.value
            try require(form.edits == saved.saved.profile.edits, "intentional confirmed reload returns actual saved fields")
            form.close()
        }
        let reopened = OwnerProfileEditor(client: client); reopened.open(); await reopened.operation?.value
        try require(reopened.nameField.stringValue == "Naya" && reopened.characterField.string == "SYNTHETIC_CHARACTER_EDIT",
                    "reopened native editor loads actual saved content without activation")
        try edit(reopened, name: "Second synthetic name", character: "SYNTHETIC_SECOND_CHARACTER", about: "SYNTHETIC_SECOND_ABOUT")
        reopened.saveButton.performClick(nil); await reopened.operation?.value
        try require(reopened.restoreButton.isEnabled, "second save exposes a real protected previous good copy")
        reopened.restoreButton.performClick(nil)
        try require(reopened.edits.displayName == "Naya" && reopened.notice.stringValue.contains("nothing has been restored"),
                    "previous good action changes RAM fields only")
        reopened.saveButton.performClick(nil); await reopened.operation?.value
        try require((try await client.readOwnerProfile()).saved.profile.displayName == "Naya", "restoration uses ordinary revision guarded save")
        try edit(reopened, name: "Never saved synthetic", character: "SYNTHETIC_CANCEL", about: "SYNTHETIC_CANCEL")
        reopened.cancelButton.performClick(nil)
        let afterClose = try await client.readOwnerProfile()
        try require(reopened.document == nil && reopened.nameField.stringValue.isEmpty
                    && afterClose.saved.profile.displayName == "Naya", "cancel discards volatile draft only and does not write")
    }
    private static func lostReply(saved: OwnerProfileDocumentView, descriptor: ServiceDescriptor, proof: URL) async throws {
        let profile = OwnerProfileSnapshotView(schemaVersion: 1, kind: "profile", ownerId: saved.active.profile.ownerId,
            profileVersion: "synthetic-lost-reply-version", displayName: "Lost reply synthetic name",
            style: OwnerProfilePart(text: "SYNTHETIC_COMMITTED_CHARACTER", dataClass: .privateData),
            lore: OwnerProfilePart(text: "SYNTHETIC_COMMITTED_ABOUT", dataClass: .privateData))
        let advanced = OwnerProfileDocumentView(publicBase: saved.publicBase, active: saved.active,
            saved: OwnerProfileSavedView(profile: profile, revision: String(repeating: "f", count: 64), present: true),
            previous: saved.saved.profile, pendingActivation: true)
        func envelope(_ value: OwnerProfileDocumentView) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["data": JSONSerialization.jsonObject(with: JSONEncoder().encode(value))])
        }
        try LostProfileReply.prepare(initial: envelope(saved), advanced: envelope(advanced))
        let client = CompanionClient(descriptor: descriptor, credential: { "SYNTHETIC_LOST_REPLY_AUTHORITY" }, testingProtocol: LostProfileReply.self)
        let form = OwnerProfileEditor(client: client); form.open(); await form.operation?.value
        try edit(form, name: profile.displayName, character: profile.style!.text, about: profile.lore!.text)
        let draft = form.edits
        form.saveButton.performClick(nil); await form.operation?.value
        try require(LostProfileReply.putCount == 1 && form.edits == draft && !form.saveButton.isEnabled
                    && form.notice.stringValue.contains("unknown"), "actual URLSession transport mapping after dispatched committed PUT is unknown and cannot auto retry")
        try require(form.document?.saved.profile.displayName == "Naya", "lost reply cannot falsely report committed state before intentional readback")
        form.readbackButton.performClick(nil); await form.operation?.value
        try require(form.document?.saved.profile.displayName == profile.displayName && form.savedContent.string.contains(profile.displayName)
                    && form.edits == draft && form.saveButton.isEnabled && LostProfileReply.putCount == 1,
                    "successful readback shows advanced committed state and preserves draft before another Save")
        try snapshot(form, proof.appendingPathComponent("persona-editor-lost-reply.png"))
        form.close()
    }
    private static func edit(_ form: OwnerProfileEditor, name: String, character: String, about: String) throws {
        form.nameField.selectText(nil)
        guard let field = form.nameField.currentEditor() as? NSTextView else { throw NSError(domain: "SyntheticPersonaEditorUI", code: 1) }
        field.insertText(name, replacementRange: NSRange(location: 0, length: field.string.utf16.count))
        form.window?.makeFirstResponder(form.characterField)
        form.characterField.insertText(character, replacementRange: NSRange(location: 0, length: form.characterField.string.utf16.count))
        form.window?.makeFirstResponder(form.aboutField)
        form.aboutField.insertText(about, replacementRange: NSRange(location: 0, length: form.aboutField.string.utf16.count))
        form.window?.makeFirstResponder(nil)
    }
    private static func snapshot(_ form: OwnerProfileEditor, _ url: URL) throws {
        guard let view = form.window?.contentView else { throw NSError(domain: "SyntheticPersonaEditorUI", code: 2) }
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        guard let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw NSError(domain: "SyntheticPersonaEditorUI", code: 3) }
        view.cacheDisplay(in: view.bounds, to: image)
        guard let data = image.representation(using: .png, properties: [:]), data.count > 1000 else { throw NSError(domain: "SyntheticPersonaEditorUI", code: 4) }
        try data.write(to: url); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try require(image.pixelsWide > 500 && image.pixelsHigh > 500, "actual owned native form screenshot captured with synthetic fields only")
    }
}
@MainActor private final class SyntheticProfileTransport: OwnerProfileTransport {
    let document: OwnerProfileDocumentView
    let failure: CompanionError
    var reads = 0, saves = 0
    init(_ document: OwnerProfileDocumentView, _ failure: CompanionError) { self.document = document; self.failure = failure }
    func readOwnerProfile() async throws -> OwnerProfileDocumentView { reads += 1; return document }
    func saveOwnerProfile(_ edits: OwnerProfileEdits, revision: String) async throws -> OwnerProfileDocumentView { saves += 1; throw failure }
}

// Synchronous synthetic URLSession protocol: the server state advances before
// NetworkConnectionLost. This exercises CompanionClient's real error mapping.
private final class LostProfileReply: URLProtocol {
    private static let lock = NSLock()
    private static var current = Data(), committed = Data(), puts = 0
    static func prepare(initial: Data, advanced: Data) {
        lock.lock(); defer { lock.unlock() }
        current = initial; committed = advanced; puts = 0
    }
    static var putCount: Int { lock.lock(); defer { lock.unlock() }; return puts }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/api/v1/owner-profile" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        if request.httpMethod == "PUT" {
            Self.current = Self.committed; Self.puts += 1; Self.lock.unlock()
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
        }
        let data = Self.current; Self.lock.unlock()
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json", "Cache-Control": "no-store"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
