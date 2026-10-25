import AppKit

/// The companion page's `window.confirm`, answered by a native sheet on the page's own window. OK is
/// true; Cancel, a subframe, a page the route does not approve and a missing window are false, and the
/// last three never show anything. WebKit needs exactly one answer per panel.
@MainActor enum ConfirmPanel {
    typealias Present = @MainActor (_ message: String, _ window: NSWindow, _ answer: @escaping @MainActor (Bool) -> Void) -> Void

    /// The most of a page message the sheet shows.
    static let messageLimit = 500

    static func answer(message: String, fromMainFrame: Bool, approvedPage: Bool, window: NSWindow?,
                       present: Present = sheet, completion: @escaping @MainActor (Bool) -> Void) {
        guard fromMainFrame, approvedPage, let window else { completion(false); return }
        let once = Once()
        present(String(message.prefix(messageLimit)), window) { ok in
            guard once.first() else { return }
            completion(ok)
        }
    }

    /// The real panel: an alert sheet with OK first, so Return confirms and Escape cancels.
    nonisolated static let sheet: Present = { message, window, answer in
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in answer(response == .alertFirstButtonReturn) }
    }

    @MainActor private final class Once {
        private var used = false
        func first() -> Bool { defer { used = true }; return !used }
    }
}
