import Foundation

/// A child-lifecycle policy. It cannot create a Live session or acquire audio.
@MainActor final class NativeServiceRecovery {
    typealias Schedule = (Double, @escaping () -> Void) -> () -> Void
    private let schedule: Schedule
    private let launch: (UInt64) -> Void
    private let lost: () -> Void
    private let reconcile: () -> Void
    private let status: (Bool) -> Void
    private var cancel: (() -> Void)?
    private var active = false, running = false, inFlight = false
    private var attempts = 0
    private(set) var generation: UInt64 = 0
    var exhausted: Bool { active && !running && attempts == 3 && cancel == nil }
    init(schedule: @escaping Schedule, launch: @escaping (UInt64) -> Void,
         lost: @escaping () -> Void, reconcile: @escaping () -> Void,
         status: @escaping (Bool) -> Void = { _ in }) {
        self.schedule = schedule; self.launch = launch; self.lost = lost
        self.reconcile = reconcile; self.status = status
    }
    @discardableResult func activate() -> UInt64 {
        cancel?(); cancel = nil; generation &+= 1
        active = true; running = true; inFlight = false; attempts = 0; status(false)
        return generation
    }
    func childExited(_ token: UInt64) {
        guard active, running, generation == token else { return }
        running = false; generation &+= 1; lost(); next()
    }
    private func next() {
        guard active, attempts < 3 else { status(false); return }
        let delay = Double(1 << attempts)
        attempts += 1; status(true)
        let token = generation
        cancel = schedule(delay) { [weak self] in
            guard let self, self.active, self.generation == token else { return }
            self.cancel = nil; self.inFlight = true; self.launch(token)
        }
    }
    func finished(_ token: UInt64, success: Bool) {
        guard active, inFlight, generation == token else { return }
        inFlight = false
        if success { running = true; generation &+= 1; status(false) }
        else { next() }
    }
    func wake() { if active && running { reconcile() } }
    func stop() {
        active = false; running = false; inFlight = false; generation &+= 1
        cancel?(); cancel = nil; status(false)
    }
}

/// App ownership seam: only owner Start invokes the factory; service events release capture.
@MainActor final class NativeLiveAuthorityOwner<Session> {
    private var authority: String?
    private var retained: Session?
    private let release: (Session) -> Void
    private let publish: (Session?) -> Void
    init(release: @escaping (Session) -> Void, publish: @escaping (Session?) -> Void) {
        self.release = release; self.publish = publish
    }
    func rebind(_ authority: String) { self.authority = authority }
    func unavailable() { if let retained { release(retained) } }
    func ownerStart(make: () -> Session) -> Session {
        if let retained { return retained }
        let session = make(); retained = session; publish(session); return session
    }
    func clear() {
        if let retained { release(retained) }
        retained = nil; publish(nil)
    }
}
