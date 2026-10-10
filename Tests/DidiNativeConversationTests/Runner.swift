import Foundation
import Darwin

struct Failure: Error { let message: String }
func require(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
let assistant = "11111111-1111-4111-8111-111111111111"
let epoch = "22222222-2222-4222-8222-222222222222"
let sessionA = "33333333-3333-4333-8333-333333333333"
let sessionB = "44444444-4444-4444-8444-444444444444"
func selection(_ id: String? = sessionA, _ title: String? = "A") -> Data {
    try! JSONSerialization.data(withJSONObject: ["data": ["sessionId": id as Any? ?? NSNull(), "title": title as Any? ?? NSNull()], "requestId": "request", "authorityEpoch": epoch])
}
func snapshot(_ request: ConnectedChatRequest, session: String? = nil, outcome: String = "outcome_unknown") -> Data {
    try! JSONSerialization.data(withJSONObject: ["data": ["runId": UUID().uuidString, "sessionId": session ?? request.sessionId,
        "userEntryId": UUID().uuidString, "finalEntryId": NSNull(), "finalText": NSNull(), "retryOf": request.retryOf as Any? ?? NSNull(),
        "authorityEpoch": request.authorityEpoch, "provider": "gemini", "model": "synthetic", "promptVersion": "v1", "state": "terminal", "outcome": outcome,
        "sequence": 1, "partialText": "", "partialTruncated": false, "acceptedAt": "2026-10-10T00:00:00Z", "intentAt": "2026-10-10T00:00:00Z", "terminalAt": "2026-10-10T00:00:00Z", "mayHaveBeenSent": true], "requestId": "request", "authorityEpoch": request.authorityEpoch])
}
actor Page: ConnectedConversationTransport {
    var selections: [Data] = []
    var calls: [ConnectedChatRequest] = []
    var selectionCount = 0
    var held: [CheckedContinuation<Data, any Error>] = []
    var holdSelection = false
    var response: Data?
    let store: PendingRequestStore
    init(_ store: PendingRequestStore) { self.store = store }
    func configure(selections: [Data] = [], response: Data? = nil, hold: Bool = false) {
        self.selections = selections; self.response = response; holdSelection = hold
    }
    func selection() async throws -> Data {
        selectionCount += 1
        if holdSelection { return try await withCheckedThrowingContinuation { held.append($0) } }
        return selections.isEmpty ? Foundation.Data() : selections.removeFirst()
    }
    func release(_ index: Int, _ data: Data) { held.remove(at: index).resume(returning: data) }
    func counts() -> (Int, Int) { (selectionCount, calls.count) }
    func requests() -> [ConnectedChatRequest] { calls }
    func send(_ request: ConnectedChatRequest) async throws -> Data {
        guard case .current(let saved) = try await store.load(assistantId: assistant, authorityEpoch: epoch) else { throw Failure(message: "wire before prepare") }
        try require(saved.phase == .dispatchUnknown, "wire before durable markDispatchUnknown")
        try require(saved.frozenText.utf8.elementsEqual(request.text.utf8) && saved.identity.idempotencyKey == request.idempotencyKey, "wire changed frozen bytes/key")
        calls.append(request)
        return response ?? Data("lost response".utf8)
    }
}
@MainActor func tempStore() throws -> (String, PendingRequestStore) {
    let parent = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DIDI_TEST_FIXTURE_PARENT"] ?? NSTemporaryDirectory()).resolvingSymlinksInPath()
    let dir = parent.appendingPathComponent("didi-coordinator-" + UUID().uuidString).path
    return (dir, PendingRequestStore(directory: dir))
}
@MainActor func testBarrierAndReplay() async throws {
    let (dir, store) = try tempStore(); defer { try? FileManager.default.removeItem(atPath: dir) }
    let page = Page(store); await page.configure(selections: [selection()])
    let draft = ConnectedDraft(store: store)
    await draft.connect(authority: .init(assistantId: assistant, authorityEpoch: epoch), transport: page)
    try require(await page.counts() == (0, 0), "restore dispatched")
    await draft.beginDraft(); draft.setText("e\u{301}\r\n synthetic 🎙️ ")
    await draft.send()
    guard let saved = draft.pending else { throw Failure(message: "malformed response lost pending") }
    try require(saved.phase == .dispatchUnknown, "missing durable dispatch marker")
    try require(saved.frozenText.utf8.elementsEqual("e\u{301}\r\n synthetic 🎙️ ".utf8), "text normalized")
    draft.setText("replacement"); await draft.send()
    try require(await page.counts() == (1, 1), "duplicate Send dispatched")
    let restored = ConnectedDraft(store: store)
    await restored.connect(authority: .init(assistantId: assistant, authorityEpoch: epoch), transport: page)
    try require(await page.counts() == (1, 1), "rebootstrap dispatched")
    await restored.replay()
    let calls = await page.requests()
    try require(calls.count == 2 && calls[0].idempotencyKey == calls[1].idempotencyKey && calls[0].body == calls[1].body, "replay changed identity/body")
    let object = try JSONSerialization.jsonObject(with: calls[0].body) as! [String: Any]
    try require(object["retryOf"] == nil && object.count == 2, "absent retryOf not omitted")
    await page.configure(response: snapshot(calls[0], session: sessionB))
    await restored.replay(); try require(restored.pending != nil, "wrong-session snapshot acknowledged")
    await page.configure(response: snapshot(calls[0], outcome: "invented"))
    await restored.replay(); try require(restored.pending != nil, "unknown outcome acknowledged")
    await page.configure(response: snapshot(calls[0]))
    await restored.replay(); try require(restored.pending == nil && restored.state == .accepted, "outcome_unknown not accepted")
    try require(try await store.load(assistantId: assistant, authorityEpoch: epoch) == .empty, "ack did not remove own record")
}
@MainActor func testLateSelection() async throws {
    let (dir, store) = try tempStore(); defer { try? FileManager.default.removeItem(atPath: dir) }
    let page = Page(store); await page.configure(hold: true)
    let draft = ConnectedDraft(store: store)
    await draft.connect(authority: .init(assistantId: assistant, authorityEpoch: epoch), transport: page)
    let old = Task { await draft.beginDraft() }
    while await page.counts().0 < 1 { await Task.yield() }
    let new = Task { await draft.beginDraft() }
    while await page.counts().0 < 2 { await Task.yield() }
    await page.release(1, selection(sessionB, "B")); await new.value
    await page.release(0, selection()); await old.value
    try require(draft.target?.sessionId == sessionB, "late A retargeted B")
    let cancelled = Task { await draft.beginDraft() }
    while await page.counts().0 < 3 { await Task.yield() }
    draft.cancelDraft(); await page.release(0, selection()); await cancelled.value
    try require(draft.target == nil && draft.state == .idle, "cancelled resolution became editable")
    await page.configure(selections: [selection(nil, nil)])
    await draft.beginDraft(); draft.setText("blocked"); await draft.send()
    let noneCalls = await page.counts(); try require(draft.state == .unavailable && noneCalls.1 == 0, "none selection allowed send")
}
@MainActor func testFailuresAndCleanup() async throws {
    let (dir, store) = try tempStore(); defer { try? FileManager.default.removeItem(atPath: dir) }
    let page = Page(store); let authority = ConnectedAuthority(assistantId: assistant, authorityEpoch: epoch)
    await page.configure(selections: [selection()]); let draft = ConnectedDraft(store: store)
    await draft.connect(authority: authority, transport: page); await draft.beginDraft(); draft.setText(String(repeating: "x", count: 16001)); await draft.send()
    let failedCalls = await page.counts(); try require(draft.state == .storageFailure && failedCalls.1 == 0, "oversized text dispatched")
    draft.setText("recovered text"); await draft.send()
    guard let saved = draft.pending else { throw Failure(message: "send recovery missing") }
    let wrong = PendingRequestIdentity(assistantId: assistant, authorityEpoch: epoch, sessionId: sessionB, idempotencyKey: saved.identity.idempotencyKey)
    await draft.discard(wrong); try require(draft.pending != nil, "wrong identity discarded")
    let other = ConnectedDraft(store: store)
    await other.connect(authority: .init(assistantId: sessionB, authorityEpoch: epoch), transport: page)
    let before = await page.counts(); await other.replay()
    let orphanCalls = await page.counts(); try require(other.state == .orphan && orphanCalls == before, "orphan dispatched")
    await draft.discard(saved.identity); try require(draft.pending == nil, "own explicit discard failed")
    try Data("{broken".utf8).write(to: URL(fileURLWithPath: dir + "/pending-request.json")); chmod(dir + "/pending-request.json", 0o600)
    await draft.connect(authority: authority, transport: page); await draft.beginDraft(); await draft.send(); await draft.replay()
    let corruptCalls = await page.counts(); try require(draft.state == .storageFailure && corruptCalls == before, "corrupt pending dispatched")
    try Data(repeating: 65, count: 131073).write(to: URL(fileURLWithPath: dir + "/pending-request.json"))
    await draft.connect(authority: authority, transport: page)
    try require(draft.state == .storageFailure, "oversized pending allowed")
}

// Test-only implementation of the accepted HTTP wire. Production injects its page seam.
struct HTTPPage: ConnectedConversationTransport {
    let config: [String: String]
    func call(_ path: String, body: Data? = nil, request: ConnectedChatRequest? = nil) async throws -> Data {
        if request != nil && config["barrier"] == "before-wire" {
            FileHandle.standardOutput.write(Data("BARRIER\n".utf8))
            _ = readLine() // orchestrator kills this actual child after inspecting durable storage
        }
        var wire = URLRequest(url: URL(string: config["base"]! + "/api/v1" + path)!)
        wire.httpMethod = body == nil ? "GET" : "POST"; wire.httpBody = body
        wire.setValue(config["cookie"], forHTTPHeaderField: "Cookie")
        wire.setValue(config["origin"], forHTTPHeaderField: "Origin")
        wire.setValue(config["csrf"], forHTTPHeaderField: "X-Didi-CSRF")
        wire.setValue(request?.authorityEpoch ?? config["epoch"], forHTTPHeaderField: "X-Didi-Authority-Epoch")
        wire.setValue(request?.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        wire.setValue("application/json", forHTTPHeaderField: "Content-Type")
        wire.timeoutInterval = 4
        let (data, response) = try await URLSession.shared.data(for: wire)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw Failure(message: "HTTP denied") }
        return data
    }
    func selection() async throws -> Data { try await call("/conversation-selection") }
    func send(_ request: ConnectedChatRequest) async throws -> Data { try await call("/chat", body: request.body, request: request) }
}
@MainActor func child(_ mode: String) async throws {
    let env = ProcessInfo.processInfo.environment
    let config = try JSONDecoder().decode([String: String].self, from: Data(env["DIDI_TEST_PAGE"]!.utf8))
    let store = PendingRequestStore(directory: env["DIDI_TEST_PENDING"]!)
    let draft = ConnectedDraft(store: store)
    await draft.connect(authority: .init(assistantId: config["assistant"]!, authorityEpoch: config["epoch"]!), transport: HTTPPage(config: config))
    if mode == "send" { await draft.beginDraft(); draft.setText(env["DIDI_TEST_TEXT"]!); await draft.send() }
    if mode == "replay" { await draft.replay() }
    if mode == "discard", let pending = draft.pending { await draft.discard(pending.identity) }
    let result: [String: Any] = ["state": draft.state.rawValue, "text": draft.text, "sessionId": draft.target?.sessionId as Any? ?? NSNull(), "pending": draft.pending != nil]
    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}
@main struct Runner {
    @MainActor static func main() async {
        do {
            if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "--child" { try await child(CommandLine.arguments[2]); return }
            let tests: [(String, @MainActor () async throws -> Void)] = [("barrier/exact replay/snapshot validation", testBarrierAndReplay), ("late selection/replacement/cancel/none", testLateSelection), ("persistence/orphan/corrupt/identity cleanup", testFailuresAndCleanup)]
            var durations: [(String, Double)] = []
            for (name, test) in tests { let start = Date(); try await test(); durations.append((name, Date().timeIntervalSince(start))); print("PASS \(name)") }
            if CommandLine.arguments.contains("--durations=10") { for (name, duration) in durations.sorted(by: { $0.1 > $1.1 }) { print(String(format: "%.3fs %@", duration, name)) } }
        } catch { print("FAIL \(error)"); exit(1) }
    }
}
