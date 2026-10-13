import Foundation
import UserNotifications

// This boundary lets Mac tests exercise permission and submission without OS alerts.
protocol NativeNotificationCenter {
    func capability() async -> NotificationCapability
    func requestPermission() async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
    func cancel(identifier: String)
}
private struct SystemNativeNotificationCenter: NativeNotificationCenter {
    func cancel(identifier: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [identifier])
    }
    func capability() async -> NotificationCapability {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        default: return .unknown
        }
    }
    func requestPermission() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge])
    }
    func add(_ request: UNNotificationRequest) async throws {
        try await UNUserNotificationCenter.current().add(request)
    }
}

// The owner calls this only for explicit pickup. Validation completes before any
// conversation interruption or capture hook, including on errors and stale clicks.
enum NativeLiveCallPickup {
    static func perform(validate: () async throws -> Bool,
                        stop: () async -> Void, start: () -> Void) async throws -> Bool {
        guard try await validate() else { return false }
        await stop()
        start()
        return true
    }
}

// OS acceptance is not a read receipt. Live callbacks retry on the existing poll,
// at most three submissions per job per app launch, never requesting consent implicitly.
struct NativeLiveCallDelivery {
    private(set) var pendingIDs: [String] = []
    private(set) var isFresh = false
    private(set) var notified = Set<String>()
    private var acknowledged = Set<String>()
    private var attempts: [String: Int] = [:]
    private var inFlight = Set<String>()

    mutating func reconcile(_ ids: [String]?) {
        isFresh = ids != nil
        pendingIDs = (ids ?? []).filter { !acknowledged.contains($0) }
    }
    func canPickUp(_ id: String) -> Bool { isFresh && pendingIDs.contains(id) }
    mutating func beginAttempt(_ id: String, permitted: Bool) -> Bool {
        guard permitted, canPickUp(id), !notified.contains(id),
              !inFlight.contains(id), attempts[id, default: 0] < 3 else { return false }
        attempts[id, default: 0] += 1
        inFlight.insert(id)
        return true
    }
    mutating func completeAttempt(_ id: String, result: AdapterResult) {
        inFlight.remove(id)
        if result == .acknowledged { notified.insert(id) }
    }
    mutating func acknowledge(_ id: String) {
        acknowledged.insert(id)
        pendingIDs.removeAll { $0 == id }
    }
}

final class NativeNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let center: any NativeNotificationCenter
    var onOpen: ((ReminderLink) -> Void)?
    var onLiveCall: ((String) -> Void)?
    init(center: (any NativeNotificationCenter)? = nil) {
        self.center = center ?? SystemNativeNotificationCenter()
        super.init()
        if center == nil { UNUserNotificationCenter.current().delegate = self }
    }
    func capability() async -> NotificationCapability { await center.capability() }
    // Only the explicit UI button invokes this method.
    func requestPermission() async -> AdapterResult {
        do { return try await center.requestPermission() ? .acknowledged : .failed("Notification permission was denied") }
        catch { return .failed(error.localizedDescription) }
    }
    func submit(_ envelope: ReminderEnvelope, at date: Date) async -> AdapterResult {
        guard !envelope.commitmentID.isEmpty, envelope.revision > 0, date > Date() else { return .failed("Invalid reminder identity, revision or future date") }
        guard await capability().canSchedule else { return .failed("Notification permission is not granted") }
        let content = UNMutableNotificationContent()
        content.title = envelope.title; content.body = envelope.body
        content.userInfo = envelope.userInfo
        // Deliberately no sound and no critical/time-sensitive override. Respect Focus.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
        do {
            try await center.add(UNNotificationRequest(identifier: envelope.identifier, content: content, trigger: trigger))
            return .acknowledged
        } catch { return .failed(error.localizedDescription) }
    }
    func submitLiveCall(jobID: String) async -> AdapterResult {
        guard await capability().canSchedule else { return .failed("Notification permission is not granted") }
        let content = UNMutableNotificationContent()
        content.title = "Naya is calling"
        content.body = "Your background task is ready. Pick up when you want."
        content.sound = nil
        content.userInfo = ["liveJobId": jobID]
        do {
            try await center.add(UNNotificationRequest(identifier: "live-call:" + jobID, content: content, trigger: nil))
            return .acknowledged
        } catch { return .failed(error.localizedDescription) }
    }
    func cancel(identifier: String) { center.cancel(identifier: identifier) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
        }
        if let jobID = info["liveJobId"] { DispatchQueue.main.async { self.onLiveCall?(jobID) } }
        else if let link = ReminderEnvelope.decode(info) { DispatchQueue.main.async { self.onOpen?(link) } }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
}
