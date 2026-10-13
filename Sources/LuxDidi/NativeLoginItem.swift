import Foundation
import ServiceManagement

enum LoginStatus { case on, off, revoked, approvalRequired }
protocol LoginRegistration: AnyObject {
    var status: LoginStatus { get }
    func setEnabled(_ enabled: Bool) throws
}
final class LoginAvailability {
    private let registration: LoginRegistration
    init(registration: LoginRegistration) { self.registration = registration }
    var status: LoginStatus { registration.status }
    func setEnabled(_ enabled: Bool) throws { try registration.setEnabled(enabled) }
    var text: String {
        switch status {
        case .on: return "Open at login: registered"
        case .off: return "Open at login: off"
        case .revoked: return "Open at login: registration unavailable"
        case .approvalRequired: return "Open at login: approval required in System Settings"
        }
    }
}
@available(macOS 13.0, *) final class SystemLoginRegistration: LoginRegistration {
    var status: LoginStatus {
        switch SMAppService.mainApp.status {
        case .enabled: return .on
        case .notRegistered: return .off
        case .requiresApproval: return .approvalRequired
        case .notFound: return .revoked
        @unknown default: return .revoked
        }
    }
    func setEnabled(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() }
        else { try SMAppService.mainApp.unregister() }
    }
}
enum WindowFrameRestore {
    static func resolve(_ saved: CGRect?, screens: [CGRect]) -> CGRect {
        let screen = screens.first ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        if let saved, saved.width >= 320, saved.height >= 240,
           screens.contains(where: { $0.contains(saved) }) { return saved }
        let width = min(980.0, screen.width), height = min(760.0, screen.height)
        return CGRect(x: screen.midX - width / 2, y: screen.midY - height / 2, width: width, height: height)
    }
}

enum NativeLaunchVisibility {
    static func shouldShow(loginLaunch: Bool) -> Bool { !loginLaunch }
}
