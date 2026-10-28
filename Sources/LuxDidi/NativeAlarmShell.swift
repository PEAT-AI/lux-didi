import AppKit
import Foundation
import IOKit.pwr_mgt
import UserNotifications

/// A provider-independent local subscription. It never selects a device or writes system volume.
@MainActor final class NativeAlarmShell {
    private struct Frame: Decodable { let type: String; let alarm: ShellAlarm?; let alarms: [ShellAlarm]? }
    private let authority: (origin: URL, request: NativeLiveRequestBuilder)
    private let ring: ConnectingRing
    private let onDue: (String) -> Void
    private let onCaption: (String?) -> Void
    private var task: Task<Void, Never>?
    private var assertion = IOPMAssertionID(0)
    private var epoch: String?
    private var alarms: [ShellAlarm] = []
    private var notificationsAllowed = false
    private var permissionRequested = false
    private var attempted = Set<String>()
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
         onDue: @escaping (String) -> Void, onCaption: @escaping (String?) -> Void) {
        self.authority = authority; self.ring = ring; self.onDue = onDue; self.onCaption = onCaption
    }
    func start() {
        guard task == nil else { return }
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
    private func receive(_ frame: Frame) {
        if let rows = frame.alarms {
            alarms = rows
            policy.apply(rows, notificationsAllowed: notificationsAllowed)
            onCaption(policy.caption)
            let deadlines = rows.filter { $0.state == "ringing" }.compactMap(\.ringDeadlineUtc)
            if let deadline = deadlines.max() { ring.startAlarm(deadlineMs: deadline) } else { ring.stopAlarm() }
            report()
            if !permissionRequested && rows.contains(where: { $0.state == "pending" || $0.state == "ringing" }) {
                permissionRequested = true
                Task { [weak self] in
                    guard let self else { return }
                    self.notificationsAllowed = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert])) == true
                    // Re-register pending rows after permission resolves, never more than one request per id.
                    self.policy.stop()
                    self.policy.apply(self.alarms, notificationsAllowed: self.notificationsAllowed)
                    self.onCaption(self.policy.caption); self.report()
                }
            }
        }
        if frame.type == "alarm_due", let alarm = frame.alarm, let deadline = alarm.ringDeadlineUtc,
           deadline > Int(Date().timeIntervalSince1970 * 1000) {
            ring.startAlarm(deadlineMs: deadline)
            if attempted.insert(alarm.id).inserted {
                post("ring-started", body: ["id": alarm.id])
                onDue(alarm.id)
            }
        }
    }
    private func report() { post("shell", body: ["assertion": alarms.isEmpty || policy.assertionHeld, "notifications": notificationsAllowed]) }
    func noteLiveSession(_ id: String) {
        // W11-R5: this reserves the occurrence and records live_session_no_channel; no injected text.
        post("session", body: ["id": id, "ownerDisplayName": NSFullUserName()])
    }
    private func post(_ route: String, body: [String: Any]) {
        guard var request = try? authority.request(authority.origin.appendingPathComponent("api/v1/alarms/" + route), epoch),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        request.httpMethod = "POST"; request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Task { _ = try? await session.data(for: request) }
    }
    private func register(_ alarm: ShellAlarm) {
        guard notificationsAllowed else { return }
        let content = UNMutableNotificationContent(); content.title = "Alarm"; content.body = "Your alarm is due."
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: Double(alarm.fireAtUtc) / 1000))
        date.timeZone = calendar.timeZone
        let request = UNNotificationRequest(identifier: "alarm:" + alarm.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: date, repeats: false))
        Task { [weak self] in
            do { try await UNUserNotificationCenter.current().add(request) }
            catch {
                guard let self else { return }
                self.notificationsAllowed = false; self.policy.apply(self.alarms, notificationsAllowed: false)
                self.onCaption(self.policy.caption); self.report()
            }
        }
    }
}
