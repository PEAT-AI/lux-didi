import Foundation
import AVFoundation
import AppKit
import SwiftUI

// Versioned independently of routine launches: only this onboarding build consumes it.
enum NativeGettingStartedOnce {
    static let key = "DidiGettingStarted.v1.shown"
    static func consume(_ defaults: UserDefaults) -> Bool {
        guard !defaults.bool(forKey: key) else { return false }
        defaults.set(true, forKey: key)
        return true
    }
}
struct NativeGettingStartedItem: Identifiable {
    var id: String { title }
    let title: String
    let detail: String
    let command: String?
}
enum NativeGettingStartedItems {
    static func rows(microphone: String, notifications: String, login: String,
                     connections: [(String, String, String?)]) -> [NativeGettingStartedItem] {
        var rows = [
            NativeGettingStartedItem(title: "Microphone", detail: microphone, command: nil),
            NativeGettingStartedItem(title: "Notifications", detail: notifications, command: nil),
            NativeGettingStartedItem(title: "Open at login", detail: login, command: nil),
            NativeGettingStartedItem(title: "Show Didi", detail: "Control Option Space", command: nil),
            NativeGettingStartedItem(title: "Live shortcuts", detail: "Start: Control Option Shift L; mute: Control Option Shift M; stop: Escape", command: nil),
        ]
        rows += connections.map { id, state, reason in
            let step = NativeNextSteps.lookup(id: id, state: state, reason: reason)
            return NativeGettingStartedItem(title: id, detail: "\(state): \(step.text)", command: step.command)
        }
        return rows
    }
    // Recompute from whitelisted mapping, not arbitrary row text or connector data.
    static func command(id: String, state: String, reason: String?) -> String? {
        NativeNextSteps.lookup(id: id, state: state, reason: reason).command
    }
}

struct NativeGettingStartedView: View {
    let load: () async -> [NativeGettingStartedItem]
    let microphone: () -> Void
    let notifications: () -> Void
    let login: () -> Void
    let close: () -> Void
    @State private var rows: [NativeGettingStartedItem] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Getting started").font(.title)
            Text("What is ready, and what needs you. Permissions are requested only when you press a button.")
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title).font(.headline)
                            Text(row.detail).textSelection(.enabled)
                            if row.title == "Microphone" {
                                Button("Set up microphone") { microphone(); reload() }
                            } else if row.title == "Notifications" {
                                Button("Set up notifications") { notifications(); reload() }
                            } else if row.title == "Open at login" {
                                Button("Toggle Open at login") { login(); reload() }
                            }
                            if let command = row.command {
                                Button("Copy command") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(command, forType: .string)
                                }
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button("Refresh status") { reload() }
                Spacer()
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 640, height: 610).task { rows = await load() }
    }
    private func reload() { Task { rows = await load() } }
}

@MainActor enum NativeGettingStartedPermissions {
    static func microphone() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { _ in }
        case .denied, .restricted:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") { NSWorkspace.shared.open(url) }
        default: break
        }
    }
    static func notificationSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
    }
}
