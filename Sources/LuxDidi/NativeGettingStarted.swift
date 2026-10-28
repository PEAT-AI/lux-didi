import Foundation
import AVFoundation
import AppKit
import SwiftUI
import Combine

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
    var guideURL: URL? = nil
}
enum NativeGettingStartedItems {
    /// W2-R1 / F4: a connection row carries the reads a refused approval would add, so the sentence can name them.
    static func rows(microphone: String, notifications: String, login: String,
                     connections: [(String, String, String?, [String])]) -> [NativeGettingStartedItem] {
        var rows = [
            NativeGettingStartedItem(title: "Microphone", detail: microphone, command: nil),
            NativeGettingStartedItem(title: "Notifications", detail: notifications, command: nil),
            NativeGettingStartedItem(title: "Open at login", detail: login, command: nil),
            NativeGettingStartedItem(title: "Open Naya app", detail: "Menu bar, or Control Option Space", command: nil),
            NativeGettingStartedItem(title: "Live shortcuts", detail: "Start: Control Option Shift L; mute: Control Option Shift M; stop: Escape", command: nil),
        ]
        rows += connections.map { id, state, reason, added in
            let step = NativeNextSteps.lookup(id: id, state: state, reason: reason, added: added)
            return NativeGettingStartedItem(title: id, detail: "\(state): \(step.text)", command: step.command, guideURL: step.guideURL)
        }
        return rows
    }
    // Recompute from whitelisted mapping, not arbitrary row text or connector data.
    static func command(id: String, state: String, reason: String?) -> String? {
        NativeNextSteps.lookup(id: id, state: state, reason: reason).command
    }
}

@MainActor final class NativeGettingStartedProjection: ObservableObject {
    @Published var rows: [NativeGettingStartedItem] = []
}

struct NativeGettingStartedView: View {
    let load: () async -> [NativeGettingStartedItem]
    let microphone: () -> Void
    let notifications: () -> Void
    let login: () -> Void
    let close: () -> Void
    @ObservedObject private var projection = NativeGettingStartedProjection()
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Getting started").font(.title)
            Text("What is ready, and what needs you. Permissions are requested only when you press a button.")
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(projection.rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title).font(.headline)
                            Text(row.detail).textSelection(.enabled)
                            if let guide = row.guideURL { Link("Setup guide", destination: guide) }
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
        }.padding(24).frame(width: 640, height: 610).task { projection.rows = await load() }
    }
    private func reload() { Task { projection.rows = await load() } }
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
