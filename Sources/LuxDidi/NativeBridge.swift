import AppKit
import Foundation

// MARK: - Outbound messages (native -> web)

/// The address-and-voice bridge contract (`BRIDGE.md`). Every value here is pure so the
/// encode/decode and queueing rules can be proven without a window or a live audio graph.
enum BridgeOutbound: Equatable {
    case hydrate(BridgeHydrate)
    case liveState(BridgeLiveState)
    case route(BridgeRoute)
    case levels(input: [Double], output: [Double])
    case requestStart
    case requestStop

    var jsonObject: [String: Any] {
        switch self {
        case .hydrate(let hydrate): return ["type": "hydrate"].merging(hydrate.jsonObject) { _, new in new }
        case .liveState(let state): return ["type": "liveState"].merging(state.jsonObject) { _, new in new }
        case .route(let route): return ["type": "route"].merging(route.jsonObject) { _, new in new }
        case .levels(let input, let output): return ["type": "levels", "input": input, "output": output]
        case .requestStart: return ["type": "requestStart"]
        case .requestStop: return ["type": "requestStop"]
        }
    }

    var jsonString: String {
        guard let data = try? JSONSerialization.data(withJSONObject: jsonObject, options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

struct BridgeHydrate: Equatable {
    var consent: Bool
    var mic: String
    var live: BridgeLiveState
    var route: BridgeRoute?
    var theme: String
    var lastSessionEndedAt: String?
    var trafficLightsMaxX: Double

    static let empty = BridgeHydrate(consent: false, mic: "undetermined", live: BridgeLiveState(state: "idle", error: nil, reason: nil),
                                     route: nil, theme: BridgeTheme.dark.rawValue, lastSessionEndedAt: nil, trafficLightsMaxX: 0)

    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "consent": consent,
            "mic": mic,
            "live": live.jsonObject,
            "theme": theme,
            "trafficLightsMaxX": trafficLightsMaxX,
        ]
        object["route"] = route?.jsonObject ?? NSNull()
        object["lastSessionEndedAt"] = lastSessionEndedAt ?? NSNull()
        return object
    }
}

struct BridgeLiveState: Equatable {
    var state: String
    var error: String?
    var reason: String?

    var jsonObject: [String: Any] {
        var object: [String: Any] = ["state": state]
        if let error { object["error"] = error }
        if let reason { object["reason"] = reason }
        return object
    }
}

struct BridgeRoute: Equatable {
    var input: String
    var output: String
    var voiceProcessing: Bool

    var jsonObject: [String: Any] { ["input": input, "output": output, "voiceProcessing": voiceProcessing] }

    /// The audio owner exposes its human route sentence (`"Microphone: X · Output: Y"`); the bridge
    /// only splits it, it never touches the device. `voiceProcessing` is passed through from the owner.
    static func parse(_ sentence: String, voiceProcessing: Bool = false) -> BridgeRoute? {
        let separator = " · Output: "
        let parts = sentence.components(separatedBy: separator)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        let input = parts[0].hasPrefix("Microphone: ") ? String(parts[0].dropFirst("Microphone: ".count)) : parts[0]
        return BridgeRoute(input: input, output: parts[1], voiceProcessing: voiceProcessing)
    }
}

/// Maps the release 2b conversation lifecycle (`NativeLiveConversation.State.rawValue`) onto the
/// five bridge states the web understands. Pure string mapping so it is testable without audio.
enum BridgeLiveStateMapping {
    static func state(from raw: String) -> String {
        switch raw {
        case "connecting", "rebuilding": return "starting"
        case "listening", "speaking", "pausedForInput": return "live"
        case "muted": return "muted"
        case "failed": return "error"
        case "ended", "outcomeUnknown", "idle": return "idle"
        default: return "idle"
        }
    }

    static func error(from raw: String) -> String? { raw == "failed" ? "providerError" : nil }
}

// MARK: - Inbound messages (web -> native)

enum BridgeInbound: Equatable {
    case ready
    case start
    case stop
    case mute
    case unmute
    case consentGranted
    case theme(String)
    case openExternal(String)
    case unknown(String)

    static func decode(_ body: Any) -> BridgeInbound {
        let object: [String: Any]?
        if let dictionary = body as? [String: Any] {
            object = dictionary
        } else if let string = body as? String, let data = string.data(using: .utf8),
                  let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            object = dictionary
        } else {
            object = nil
        }
        guard let type = object?["type"] as? String else { return .unknown("") }
        switch type {
        case "ready": return .ready
        case "start": return .start
        case "stop": return .stop
        case "mute": return .mute
        case "unmute": return .unmute
        case "consentGranted": return .consentGranted
        case "theme": return .theme(object?["mode"] as? String ?? "")
        case "openExternal": return .openExternal(object?["url"] as? String ?? "")
        default: return .unknown(type)
        }
    }
}

// MARK: - State helpers

struct ConsentStore {
    static let key = "liveConsentGranted"
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var granted: Bool { defaults.bool(forKey: Self.key) }
    func grant() { defaults.set(true, forKey: Self.key) }
}

enum BridgeTheme: String {
    case dark
    case light

    var appearanceName: NSAppearance.Name { self == .dark ? .darkAqua : .aqua }
    var backgroundColor: NSColor { self == .dark ? NSColor(calibratedWhite: 0.05, alpha: 1) : .white }
}

/// Messages produced before the web says it is ready are held; the first ready flushes them and
/// every later ready only re-sends hydrate. `reset` runs on every navigation so a reload queues again.
struct BridgeOutbox {
    private(set) var ready = false
    private(set) var pendingCount = 0
    private var pending: [BridgeOutbound] = []

    mutating func markReady() -> [BridgeOutbound] {
        guard !ready else { return [] }
        ready = true
        let flush = pending
        pending = []
        pendingCount = 0
        return flush
    }

    mutating func enqueue(_ message: BridgeOutbound) -> Bool {
        guard ready else { pending.append(message); pendingCount = pending.count; return false }
        return true
    }

    mutating func reset() { ready = false; pending = []; pendingCount = 0 }
}

/// One side of the orb's band frame (#283): linear RMS 0...1 of the whole signal and of the low
/// (vowel body), mid and high bands, plus an onset value 0...1. Numbers only.
struct BridgeOrbBands: Equatable {
    var level: Double = 0, low: Double = 0, mid: Double = 0, high: Double = 0, flux: Double = 0
    static let silent = BridgeOrbBands()
    var isSilent: Bool { level <= 0 && low <= 0 && mid <= 0 && high <= 0 && flux <= 0 }
    fileprivate var json: String {
        func number(_ value: Double) -> String {
            let bounded = value.isFinite ? min(1, max(0, value)) : 0
            return String(format: "%.4f", bounded)
        }
        return "{\"level\":\(number(level)),\"low\":\(number(low)),\"mid\":\(number(mid)),\"high\":\(number(high)),\"flux\":\(number(flux))}"
    }
}

/// The orb's display-rate frame: owner input and model output apart, posted straight to the
/// renderer's own `window.didiOrbLevel` hook at 60 Hz. It is a renderer-only channel at display
/// rate (never one call per audio buffer) and carries no transcript, route or control data; the
/// batched 20 Hz `levels` contract below is unchanged.
struct BridgeOrbFrame: Equatable {
    var input: BridgeOrbBands
    var output: BridgeOrbBands
    var isSilent: Bool { input.isSilent && output.isSilent }
    var script: String { "window.didiOrbLevel&&window.didiOrbLevel({\"v\":2,\"input\":\(input.json),\"output\":\(output.json)})" }
}

/// Caps the orb level stream at the contract's 20 Hz by batching every sample seen since the last
/// flush; the web receives arrays, never one message per audio buffer.
struct LevelBatcher {
    static let maxHz: Double = 20
    static let interval: TimeInterval = 1.0 / maxHz
    private var inputs: [Double] = []
    private var outputs: [Double] = []
    private var lastFlush: TimeInterval?

    mutating func offer(input: Double, output: Double, now: TimeInterval) -> (input: [Double], output: [Double])? {
        inputs.append(input)
        outputs.append(output)
        if let lastFlush, now - lastFlush < Self.interval { return nil }
        lastFlush = now
        let batch = (input: inputs, output: outputs)
        inputs = []
        outputs = []
        return batch
    }

    mutating func reset() { inputs = []; outputs = []; lastFlush = nil }
}

// MARK: - Coordinator

/// Owns the native side of the bridge: decode inbound web messages, hold outbound messages until
/// the web is ready, throttle levels, and persist consent. It never starts capture by itself.
@MainActor final class NativeBridge {
    let consent: ConsentStore
    private var outbox = BridgeOutbox()
    private var batcher = LevelBatcher()
    private(set) var theme: BridgeTheme = .dark

    /// Wired to `WKWebView.evaluateJavaScript` by `CompanionWeb`; a closure seam keeps the bridge
    /// testable with no web view.
    var sendJS: ((String) -> Void)?
    var onCommand: ((BridgeInbound) -> Void)?
    var onTheme: ((BridgeTheme) -> Void)?
    var hydrateProvider: (() -> BridgeHydrate)?
    /// Where the unknown-type diagnostic goes (the same `native-live.log` the live lane writes).
    var logFile: URL?

    init(consent: ConsentStore = ConsentStore()) { self.consent = consent }

    func handle(_ body: Any) {
        let message = BridgeInbound.decode(body)
        switch message {
        case .ready:
            let flush = outbox.markReady()
            for pending in flush { emit(pending) }
            if let hydrateProvider { emit(.hydrate(hydrateProvider())) }
        case .consentGranted:
            consent.grant()
            onCommand?(message)
        case .theme(let mode):
            if let parsed = BridgeTheme(rawValue: mode) {
                theme = parsed
                onTheme?(parsed)
            }
            onCommand?(message)
        case .unknown(let name):
            logUnknown(name)
        case .start, .stop, .mute, .unmute, .openExternal:
            onCommand?(message)
        }
    }

    /// Called on every navigation so messages before the reloaded page's ready are held again.
    func markReload() {
        outbox.reset()
        batcher.reset()
    }

    func send(_ message: BridgeOutbound) {
        if outbox.enqueue(message) { emit(message) }
    }

    func requestStart() { send(.requestStart) }
    func requestStop() { send(.requestStop) }

    func pushLevels(input: Double, output: Double, now: TimeInterval) {
        guard let batch = batcher.offer(input: input, output: output, now: now) else { return }
        send(.levels(input: batch.input, output: batch.output))
    }

    /// #283: one orb band frame to the renderer. Dropped (not queued) before the web is ready: a
    /// stale level has no value once the page loads.
    func pushOrbFrame(_ frame: BridgeOrbFrame) {
        guard outbox.ready else { return }
        sendJS?(frame.script)
    }

    func pushLiveState(_ state: BridgeLiveState) { send(.liveState(state)) }
    func pushRoute(_ route: BridgeRoute) { send(.route(route)) }

    private func emit(_ message: BridgeOutbound) {
        sendJS?("window.didiNative&&window.didiNative.receive(\(message.jsonString))")
    }

    private func logUnknown(_ name: String) {
        guard !name.isEmpty else { return }
        guard let logFile else { print("[native-bridge] unknown message type \(name)"); return }
        let fields: [String: Any] = ["event": "native_bridge_unknown_message", "type": name]
        do {
            try FileManager.default.createDirectory(at: logFile.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if !FileManager.default.fileExists(atPath: logFile.path) {
                guard FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
            }
            let handle = try FileHandle(forWritingTo: logFile)
            defer { try? handle.close() }
            try handle.seekToEnd()
            var record = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            record.append(10)
            try handle.write(contentsOf: record)
        } catch { print("[native-bridge] unknown message type \(name)") }
    }
}

/// The native menu and shortcut target for Start/Stop. It holds only the bridge, so it has no
/// route to the capture path: a shortcut asks the web state machine instead of starting audio.
@MainActor final class NativeMenuBridge {
    private let bridge: NativeBridge
    init(bridge: NativeBridge) { self.bridge = bridge }
    func start() { bridge.requestStart() }
    func stop() { bridge.requestStop() }
}

// MARK: - Window drag band

/// WKWebView does not support `-webkit-app-region`, so with a hidden-inset titlebar the content view
/// covers the titlebar band and the band stops dragging the window. This transparent strip is pinned to
/// the top of the content (the rail/header top band, which the web keeps non-interactive) and starts a
/// window drag from it; every point outside its own frame falls through (`hitTest` returns nil), so web
/// controls below the band keep receiving clicks.
@MainActor final class WindowDragBandView: NSView {
    static let bandHeight: CGFloat = 28
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return bounds.contains(local) ? self : nil
    }
}

/// Mounts the band above a plain container. `NSHostingView` overrides `hitTest` and does not route
/// mouse events to an AppKit sibling added to it, so the hosting view must sit inside this container
/// and the band must be a sibling of the hosting view, not its subview.
@MainActor enum WindowDragBand {
    /// Width reserved for the close/minimize/zoom buttons when the window's real
    /// button frames are not available yet. The band starts after this zone so the
    /// traffic lights always receive their own clicks.
    static let trafficLightReserve: CGFloat = 80

    static func trafficLightInset(for window: NSWindow?) -> CGFloat {
        guard let zoom = window?.standardWindowButton(.zoomButton) else { return trafficLightReserve }
        let maxX = zoom.frame.maxX
        return maxX >= 20 ? maxX + 6 : trafficLightReserve
    }

    @discardableResult
    static func attach(to container: NSView, afterTrafficLights trafficLightsMaxX: CGFloat = trafficLightReserve) -> WindowDragBandView {
        let band = WindowDragBandView()
        band.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(band)
        NSLayoutConstraint.activate([
            band.topAnchor.constraint(equalTo: container.topAnchor),
            band.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: max(trafficLightsMaxX, 0)),
            band.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            band.heightAnchor.constraint(equalToConstant: WindowDragBandView.bandHeight),
        ])
        return band
    }
}
