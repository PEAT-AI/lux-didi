import AppKit
import Foundation
import IOKit.pwr_mgt
import UserNotifications

/// A provider-independent local subscription. It never selects a device or writes system volume.
@MainActor final class NativeAlarmShell {
    struct Frame: Decodable { let type: String; let alarm: ShellAlarm?; let alarms: [ShellAlarm]? }

    /// #107: the shell reports the permission it observed, never one it assumed.
    enum NotificationPermission: String { case notAsked = "not_asked", denied, allowed }
    private let authority: (origin: URL, request: NativeLiveRequestBuilder)
    private let ring: ConnectingRing
    private let onDue: (String) -> Void
    /// #107: alarm routing reads the conversation's session state, never capture state.
    private let sessionState: () -> NativeLiveConversation.State
    private let onCaption: (String?) -> Void
    private var task: Task<Void, Never>?
    private var stopped = false
    private var assertion = IOPMAssertionID(0)
    private var epoch: String?
    private var alarms: [ShellAlarm] = []
    private var notificationsAllowed = false
    private var notificationState: NotificationPermission = .notAsked
    private var permissionRequested = false
    private var attempted = Set<String>()
    /// #107: every alarm mutation reaches the relaunch agent through this one callback.
    var onAlarms: (([ShellAlarm]) -> Void)?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private let session = URLSession(configuration: .ephemeral)
    private lazy var policy = AlarmShellPolicy(acquire: { [weak self] in
        guard let self else { return false }
        return IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "Lux Didi pending alarm" as CFString, &self.assertion) == kIOReturnSuccess
    }, release: { [weak self] in
        guard let self, self.assertion != 0 else { return }
        IOPMAssertionRelease(self.assertion); self.assertion = 0
    }, register: { [weak self] alarm in self?.register(alarm) }, remove: { id in
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["alarm:" + id])
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["alarm:" + id])
    })

    init(authority: (origin: URL, request: NativeLiveRequestBuilder), ring: ConnectingRing,
         sessionState: @escaping () -> NativeLiveConversation.State = { .idle },
         onDue: @escaping (String) -> Void, onCaption: @escaping (String?) -> Void) {
        self.authority = authority; self.ring = ring; self.sessionState = sessionState; self.onDue = onDue; self.onCaption = onCaption
    }
    func start() {
        guard task == nil, !stopped else { return }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.didWakeNotification, reason: "wake")
        observe(.default, .NSSystemClockDidChange, reason: "clock_changed")
        observe(.default, .NSSystemTimeZoneDidChange, reason: "timezone_changed")
        task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let statusRequest = try self.authority.request(self.authority.origin.appendingPathComponent("api/v1/status"), nil)
                    let (data, _) = try await self.session.data(for: statusRequest)
                    let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    let status = root?["data"] as? [String: Any] ?? root
                    self.epoch = status?["authorityEpoch"] as? String
                    var request = try self.authority.request(self.authority.origin.appendingPathComponent("api/v1/alarms/events"), self.epoch)
                    request.timeoutInterval = 65
                    let (bytes, response) = try await self.session.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        guard line.hasPrefix("data: "), let body = line.dropFirst(6).data(using: .utf8) else { continue }
                        self.receive(try JSONDecoder().decode(Frame.self, from: body))
                    }
                } catch { if Task.isCancelled { return } }
                self.onCaption(self.policy.caption.map { $0.hasSuffix(" !") ? $0 : $0 + " !" })
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
    }
    func stop() {
        stopped = true
        task?.cancel(); task = nil
        for (center, token) in observers { center.removeObserver(token) }
        observers.removeAll(); policy.stop(); ring.stopAlarm(); onCaption(nil)
        session.invalidateAndCancel()
    }
    private func observe(_ center: NotificationCenter, _ name: Notification.Name, reason: String) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.post("recheck", body: ["reason": reason]) }
        }
        observers.append((center, token))
    }
    func receive(_ frame: Frame) {
        guard !stopped else { return }
        if let rows = frame.alarms {
            alarms = rows
            onAlarms?(rows)
            policy.apply(rows, notificationsAllowed: notificationsAllowed)
            onCaption(policy.caption)
            let deadlines = rows.filter { $0.state == "ringing" }.compactMap(\.ringDeadlineUtc)
            if let deadline = deadlines.max() { ring.startAlarm(deadlineMs: deadline) } else { ring.stopAlarm() }
            // #107: the permission is never a guess: the pending state is reported as not_asked
            // while the request runs, and the resolved state replaces it.
            if !permissionRequested && rows.contains(where: { $0.state == "pending" || $0.state == "ringing" }) {
                permissionRequested = true
                report()
                Task { [weak self] in
                    guard let self else { return }
                    let allowed = (try? await UNUserNotificationCenter.current().requestAuthorization(options: Self.notificationAuthorizationOptions)) == true
                    guard !self.stopped else { return }
                    self.notificationsAllowed = allowed; self.notificationState = Self.permissionState(authorized: allowed)
                    // Re-register pending rows after permission resolves, never more than one request per id.
                    self.policy.refreshNotifications(self.alarms, notificationsAllowed: self.notificationsAllowed)
                    self.onCaption(self.policy.caption); self.report()
                }
            }
            else { report() }
        }
        if frame.type == "alarm_due", let alarm = frame.alarm, let deadline = alarm.ringDeadlineUtc,
           deadline > Int(Date().timeIntervalSince1970 * 1000) {
            // #107: a live session gets the existing alarm-mode host note; nothing chimes into it.
            let live = Self.sessionIsLive(sessionState())
            let started = !live && ring.startAlarm(deadlineMs: deadline)
            if live { ring.stopAlarm() }
            if attempted.insert(alarm.id).inserted {
                if live { noteLiveSession(alarm.id) }
                else {
                    if started { post("ring-started", body: ["id": alarm.id]) }
                    onDue(alarm.id)
                }
            }
        }
    }
    /// #107: the report carries the permission the shell observed, never one it assumed.
    static func shellReport(assertion: Bool, notificationsAllowed: Bool, state: NotificationPermission) -> [String: Any] {
        ["assertion": assertion, "notifications": notificationsAllowed, "notificationState": state.rawValue]
    }
    private func report() {
        post("shell", body: Self.shellReport(assertion: alarms.isEmpty || policy.assertionHeld,
                                             notificationsAllowed: notificationsAllowed, state: notificationState))
    }
    /// #107: the host log carries the relaunch agent's state, observed rather than assumed.
    func reportRelaunch(_ event: AlarmRelaunchEvent) {
        switch event {
        case .scheduled(let dueInS): post("relaunch", body: ["action": "scheduled", "dueInS": dueInS])
        case .removed: post("relaunch", body: ["action": "removed"])
        case .failed: post("relaunch", body: ["action": "failed"])
        }
    }
    func noteLiveSession(_ id: String) {
        // Route the occurrence into the live call without a competing chime.
        post("session", body: ["id": id, "ownerDisplayName": NSFullUserName()])
    }
    private func post(_ route: String, body: [String: Any]) {
        guard var request = try? authority.request(authority.origin.appendingPathComponent("api/v1/alarms/" + route), epoch),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        request.httpMethod = "POST"; request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Task { _ = try? await session.data(for: request) }
    }
    /// C-ALARMSPEECH: the one path a failed alarm takes. The chime keeps ringing, the host log names the
    /// closed reason, and one immediate notification says so.
    func speechFailed(_ alarmID: String, reason: String) {
        post("speech-failed", body: ["id": alarmID, "reason": reason])
        guard notificationsAllowed else { return }
        let request = UNNotificationRequest(identifier: Self.speechFailedIdentifier(alarmID),
                                            content: Self.speechFailedContent(), trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
    /// #107: the conversation is live in every state but idle, ended and failed, so an alarm that
    /// arrives while she is thinking or speaking stays inside that call.
    static func sessionIsLive(_ state: NativeLiveConversation.State) -> Bool {
        state != .idle && state != .ended && state != .failed
    }
    static func permissionState(authorized: Bool) -> NotificationPermission { authorized ? .allowed : .denied }
    /// C-ALARMSPEECH: a sound is part of the alarm's authorization, so a notification that says she could
    /// not start is not silent even when the chime has already been dismissed.
    nonisolated static let notificationAuthorizationOptions: UNAuthorizationOptions = [.alert, .sound]
    /// C-ALARMSPEECH: she could not open. The line never carries the alarm label and never carries the
    /// private note text, and its own identifier is what keeps the ringing sweep from removing it.
    nonisolated static func speechFailedContent() -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Alarm"; content.body = "Naya could not start. Your alarm is still ringing."
        content.sound = .default
        return content
    }
    nonisolated static func speechFailedIdentifier(_ alarmID: String) -> String { "alarm-failed:" + alarmID }
    static func notificationContent() -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Alarm"; content.body = "Your alarm is due."
        content.sound = .default
        return content
    }
    private func register(_ alarm: ShellAlarm) {
        guard notificationsAllowed else { return }
        let content = Self.notificationContent()
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: Double(alarm.fireAtUtc) / 1000))
        date.timeZone = calendar.timeZone
        let request = UNNotificationRequest(identifier: "alarm:" + alarm.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: date, repeats: false))
        Task { [weak self] in
            do {
                try await UNUserNotificationCenter.current().add(request)
                if self?.stopped != false || self?.alarms.contains(where: { $0.id == alarm.id && $0.state == "pending" }) != true {
                    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [request.identifier])
                }
            }
            catch {
                guard let self, !self.stopped else { return }
                self.notificationsAllowed = false; self.policy.apply(self.alarms, notificationsAllowed: false)
                self.onCaption(self.policy.caption); self.report()
            }
        }
    }
}
