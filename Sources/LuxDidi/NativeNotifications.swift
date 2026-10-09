import Foundation
import UserNotifications

// No retry queue: the core outbox owns retries. OS acceptance is not a read receipt.
final class NativeNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    var onOpen: ((ReminderLink) -> Void)?
    override init() { super.init(); center.delegate = self }
    func capability() async -> NotificationCapability {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        default: return .unknown
        }
    }
    // Only the explicit UI button invokes this method.
    func requestPermission() async -> AdapterResult {
        do { return try await center.requestAuthorization(options: [.alert, .badge]) ? .acknowledged : .failed("Notification permission was denied") }
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
    func cancel(identifier: String) { center.removePendingNotificationRequests(withIdentifiers: [identifier]) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
        }
        if let link = ReminderEnvelope.decode(info) { DispatchQueue.main.async { self.onOpen?(link) } }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
}
