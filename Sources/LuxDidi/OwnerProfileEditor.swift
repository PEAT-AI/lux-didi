import AppKit
import Foundation

enum OwnerProfileClass: String, Codable, CaseIterable { case ordinary, privateData = "private", sensitive }
struct OwnerProfilePart: Codable, Equatable {
    var text: String
    var dataClass: OwnerProfileClass
}
struct OwnerProfileSnapshotView: Codable, Equatable {
    let schemaVersion: Int
    let kind: String
    let ownerId: String
    let profileVersion: String?
    let displayName: String
    let style: OwnerProfilePart?
    let lore: OwnerProfilePart?
    var valid: Bool {
        guard schemaVersion == 1, UUID(uuidString: ownerId) != nil, validProfileName(displayName) else { return false }
        if kind == "default" { return displayName == "Lux Didi" && profileVersion == nil && style == nil && lore == nil }
        return kind == "profile" && !(profileVersion ?? "").isEmpty && (profileVersion?.utf16.count ?? 81) <= 80
            && style != nil && lore != nil && style!.text.utf16.count <= 4096 && lore!.text.utf16.count <= 4096
    }
    var edits: OwnerProfileEdits {
        OwnerProfileEdits(displayName: displayName, style: style ?? OwnerProfilePart(text: "", dataClass: .privateData),
                          lore: lore ?? OwnerProfilePart(text: "", dataClass: .privateData))
    }
}
struct OwnerProfileActiveView: Codable, Equatable { let profile: OwnerProfileSnapshotView; let revision: String }
struct OwnerProfileSavedView: Codable, Equatable { let profile: OwnerProfileSnapshotView; let revision: String; let present: Bool }
struct OwnerProfileDocumentView: Codable {
    let publicBase: String
    let active: OwnerProfileActiveView
    let saved: OwnerProfileSavedView
    let previous: OwnerProfileSnapshotView?
    let pendingActivation: Bool
    var valid: Bool {
        let revision = { (value: String) in value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) } }
        return !publicBase.isEmpty && active.profile.valid && saved.profile.valid
            && revision(active.revision) && revision(saved.revision) && active.profile.ownerId == saved.profile.ownerId
            && saved.present == (saved.profile.kind == "profile")
            && (previous == nil || (previous!.valid && previous!.kind == "profile" && previous!.ownerId == active.profile.ownerId))
    }
}
struct OwnerProfileEdits: Equatable {
    var displayName: String
    var style: OwnerProfilePart
    var lore: OwnerProfilePart
    var valid: Bool { validProfileName(displayName) && style.text.utf16.count <= 4096 && lore.text.utf16.count <= 4096 }
    func body(revision: String) -> [String: Any] {
        ["expectedRevision": revision, "displayName": displayName,
         "style": ["text": style.text, "dataClass": style.dataClass.rawValue],
         "lore": ["text": lore.text, "dataClass": lore.dataClass.rawValue]]
    }
}
private func validProfileName(_ value: String) -> Bool {
    !value.isEmpty && value.utf16.count <= 80 && value.trimmingCharacters(in: .whitespacesAndNewlines) == value
        && !value.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
}
@MainActor private final class ProfileDocumentView: NSView { override var isFlipped: Bool { true } }
@MainActor protocol OwnerProfileTransport {
    func readOwnerProfile() async throws -> OwnerProfileDocumentView
    func saveOwnerProfile(_ edits: OwnerProfileEdits, revision: String) async throws -> OwnerProfileDocumentView
}

/** Native-only volatile form. No pointer, draft file, browser bridge or restart. */
@MainActor final class OwnerProfileEditor: NSWindowController, NSWindowDelegate, NSTextFieldDelegate, NSTextViewDelegate {
    let nameField = NSTextField()
    let characterField = NSTextView()
    let aboutField = NSTextView()
    let styleClass = NSPopUpButton(frame: .zero, pullsDown: false)
    let loreClass = NSPopUpButton(frame: .zero, pullsDown: false)
    let privacyChoice = NSButton(checkboxWithTitle: "I reviewed the Character and About me privacy choices above.", target: nil, action: nil)
    let saveButton = NSButton(title: "Save for next app start", target: nil, action: nil)
    let reloadButton = NSButton(title: "Reload saved fields", target: nil, action: nil)
    let readbackButton = NSButton(title: "Read back; keep my edits", target: nil, action: nil)
    let restoreButton = NSButton(title: "Use previous good fields", target: nil, action: nil)
    let cancelButton = NSButton(title: "Close / discard unsaved draft", target: nil, action: nil)
    let notice = NSTextField(wrappingLabelWithString: "Loading protected profile…")
    let savedState = NSTextField(wrappingLabelWithString: "Saved for next app start")
    let savedContent = NSTextView()
    let activeContent = NSTextView()
    let publicBase = NSTextView()
    private(set) var document: OwnerProfileDocumentView?
    private(set) var operation: Task<Void, Never>?
    var onClose: (() -> Void)?
    private let client: any OwnerProfileTransport
    private var busy = false, needsReadback = false, confirmReload = false, closed = false

    init(client: any OwnerProfileTransport) {
        self.client = client
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 860),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Persona · Lux Didi"
        window.minSize = NSSize(width: 600, height: 800)
        super.init(window: window)
        window.delegate = self
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(); window.contentView = content
        let outer = NSScrollView(); outer.hasVerticalScroller = true; outer.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(outer)
        NSLayoutConstraint.activate([outer.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                                     outer.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                                     outer.topAnchor.constraint(equalTo: content.topAnchor), outer.bottomAnchor.constraint(equalTo: content.bottomAnchor)])
        let page = ProfileDocumentView(); page.translatesAutoresizingMaskIntoConstraints = false
        outer.documentView = page; page.addSubview(stack)
        NSLayoutConstraint.activate([page.widthAnchor.constraint(equalTo: outer.contentView.widthAnchor),
                                     page.leadingAnchor.constraint(equalTo: outer.contentView.leadingAnchor),
                                     page.topAnchor.constraint(equalTo: outer.contentView.topAnchor),
                                     stack.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 16),
                                     stack.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -16),
                                     stack.topAnchor.constraint(equalTo: page.topAnchor, constant: 16),
                                     stack.bottomAnchor.constraint(equalTo: page.bottomAnchor, constant: -16)])
        func label(_ value: String) { stack.addArrangedSubview(NSTextField(labelWithString: value)) }
        func textBox(_ view: NSTextView, height: CGFloat, editable: Bool) {
            view.isEditable = editable; view.isSelectable = true; view.isRichText = false
            view.font = .systemFont(ofSize: 13); view.isHorizontallyResizable = false; view.isVerticallyResizable = true
            view.textContainer?.widthTracksTextView = true
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
            scroll.documentView = view; stack.addArrangedSubview(scroll)
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            scroll.heightAnchor.constraint(equalToConstant: height).isActive = true
            view.frame = NSRect(x: 0, y: 0, width: 640, height: height)
            view.autoresizingMask = [.width]
        }
        label("Public generic base · read only")
        textBox(publicBase, height: 80, editable: false)
        label("Active now · captured by the running host")
        textBox(activeContent, height: 80, editable: false)
        stack.addArrangedSubview(savedState)
        textBox(savedContent, height: 80, editable: false)
        label("Editable fields · unsaved until Save")
        label("Name")
        nameField.delegate = self; nameField.setAccessibilityIdentifier("persona.name")
        stack.addArrangedSubview(nameField); nameField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        func classRow(_ title: String, _ picker: NSPopUpButton) {
            for value in OwnerProfileClass.allCases { picker.addItem(withTitle: value.rawValue.capitalized) }
            picker.selectItem(withTitle: "Private"); picker.target = self; picker.action = #selector(classChanged)
            let row = NSStackView(views: [NSTextField(labelWithString: title), picker]); row.orientation = .horizontal
            stack.addArrangedSubview(row)
        }
        classRow("Character · privacy", styleClass)
        characterField.delegate = self; characterField.setAccessibilityIdentifier("persona.character")
        textBox(characterField, height: 115, editable: true)
        classRow("About me · privacy", loreClass)
        aboutField.delegate = self; aboutField.setAccessibilityIdentifier("persona.about")
        textBox(aboutField, height: 100, editable: true)
        privacyChoice.target = self; privacyChoice.action = #selector(choiceChanged); stack.addArrangedSubview(privacyChoice)
        let warning = NSTextField(wrappingLabelWithString: "Authored context is not recalled memory or tool authority. Save changes only local JSON, not this host. Finish current work before restarting the full app; unfinished work is not promised to survive.")
        stack.addArrangedSubview(warning); warning.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.addArrangedSubview(notice); notice.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        for (button, action) in [(saveButton, #selector(savePressed)), (reloadButton, #selector(reloadPressed)),
                                 (readbackButton, #selector(readbackPressed)), (restoreButton, #selector(restorePressed)),
                                 (cancelButton, #selector(closePressed))] {
            button.target = self; button.action = action; button.bezelStyle = .rounded
        }
        let first = NSStackView(views: [saveButton, cancelButton]); first.orientation = .horizontal; stack.addArrangedSubview(first)
        let second = NSStackView(views: [reloadButton, readbackButton, restoreButton]); second.orientation = .horizontal; stack.addArrangedSubview(second)
        refresh()
    }
    required init?(coder: NSCoder) { fatalError("Native programmatic form only") }
    func open() {
        showWindow(nil); window?.center(); window?.makeKeyAndOrderFront(nil)
        operation = Task { [weak self] in await self?.read(discardEdits: true) }
    }
    private func selected(_ picker: NSPopUpButton) -> OwnerProfileClass {
        OwnerProfileClass(rawValue: picker.titleOfSelectedItem?.lowercased() ?? "private") ?? .privateData
    }
    var edits: OwnerProfileEdits {
        OwnerProfileEdits(displayName: nameField.stringValue,
                          style: OwnerProfilePart(text: characterField.string, dataClass: selected(styleClass)),
                          lore: OwnerProfilePart(text: aboutField.string, dataClass: selected(loreClass)))
    }
    private var requiresChoice: Bool {
        guard let document else { return true }
        let prior = document.saved.profile.edits
        return !document.saved.present || (prior.style.dataClass != .ordinary && edits.style.dataClass == .ordinary)
            || (prior.lore.dataClass != .ordinary && edits.lore.dataClass == .ordinary)
    }
    private func refresh() {
        privacyChoice.isHidden = !requiresChoice
        saveButton.isEnabled = document != nil && !busy && !needsReadback && edits.valid && (!requiresChoice || privacyChoice.state == .on)
        reloadButton.isEnabled = !busy; readbackButton.isEnabled = !busy && document != nil
        restoreButton.isEnabled = !busy && document?.previous != nil
    }
    func controlTextDidChange(_ obj: Notification) { refresh() }
    func textDidChange(_ notification: Notification) { refresh() }
    @objc private func classChanged() { privacyChoice.state = .off; refresh() }
    @objc private func choiceChanged() { refresh() }
    private func populate(_ value: OwnerProfileEdits) {
        nameField.stringValue = value.displayName; characterField.string = value.style.text; aboutField.string = value.lore.text
        styleClass.selectItem(withTitle: value.style.dataClass.rawValue.capitalized)
        loreClass.selectItem(withTitle: value.lore.dataClass.rawValue.capitalized)
    }
    private func update(_ value: OwnerProfileDocumentView) {
        document = value; publicBase.string = value.publicBase
        func summary(_ profile: OwnerProfileSnapshotView) -> String {
            "Name: \(profile.displayName)\nCharacter: \(profile.style?.text ?? "(No authored character)")\nAbout me: \(profile.lore?.text ?? "(No authored about me)")"
        }
        activeContent.string = summary(value.active.profile)
        savedContent.string = summary(value.saved.profile)
        savedState.stringValue = value.pendingActivation ? "Saved for next app start · pending activation (not active now)" : "Saved state matches Active now"
        privacyChoice.state = .off; confirmReload = false; reloadButton.title = "Reload saved fields"
    }
    private func read(discardEdits: Bool) async {
        busy = true; refresh(); defer { busy = false; refresh() }
        do {
            let value = try await client.readOwnerProfile()
            guard !closed && !Task.isCancelled else { return }
            update(value); if discardEdits { populate(value.saved.profile.edits) }
            needsReadback = false
            notice.stringValue = discardEdits ? "Loaded actual active and saved content. Saving does not restart or activate the host."
                : "Read back actual saved state. Your unsaved edits are retained; review before another save."
        } catch {
            guard !closed else { return }
            notice.stringValue = "Profile read failed. Existing edits are retained. Reload intentionally after checking the connection and protected file."
        }
    }
    @objc private func savePressed() { operation = Task { [weak self] in await self?.save() } }
    private func save() async {
        window?.makeFirstResponder(nil)
        guard let document, !busy, !needsReadback, edits.valid, !requiresChoice || privacyChoice.state == .on else { refresh(); return }
        let draft = edits
        busy = true; refresh(); defer { busy = false; refresh() }
        do {
            let value = try await client.saveOwnerProfile(draft, revision: document.saved.revision)
            guard !closed && !Task.isCancelled else { return }
            update(value)
            notice.stringValue = "Saved for next app start. Active now is unchanged. No automatic restart."
        } catch {
            guard !closed else { return }
            switch error {
            case CompanionError.rejected(409):
                needsReadback = true; notice.stringValue = "Conflict: saved profile changed. Your edits are retained. Read back, or confirm discard and reload."
            case CompanionError.rejected(503):
                needsReadback = true; notice.stringValue = "Save durability is uncertain. Your edits are retained. Read back before another save; do not automatically retry."
            case CompanionError.rejected(400):
                notice.stringValue = "Save validation failed. Your fields remain editable; check name, text limits, privacy and protected-file validity."
            case CompanionError.rejected(_), CompanionError.unavailable, CompanionError.credentialUnavailable, CompanionError.invalidConfiguration:
                notice.stringValue = "Save could not complete. Your fields remain editable. Check the connection and protected profile."
            default:
                needsReadback = true; notice.stringValue = "Save outcome is unknown after a lost reply. Your edits are retained. Read back before another save."
            }
        }
    }
    @objc private func reloadPressed() {
        if let document, edits != document.saved.profile.edits, !confirmReload {
            confirmReload = true; reloadButton.title = "Discard edits and reload"
            notice.stringValue = "Reload would discard unsaved edits. Click Discard edits and reload to confirm, or keep editing."
            return
        }
        operation = Task { [weak self] in await self?.read(discardEdits: true) }
    }
    @objc private func readbackPressed() { operation = Task { [weak self] in await self?.read(discardEdits: false) } }
    @objc private func restorePressed() {
        guard let previous = document?.previous else { return }
        populate(previous.edits); privacyChoice.state = .off
        notice.stringValue = "Previous good fields copied into this form only. Save uses the current revision; nothing has been restored yet."
        refresh()
    }
    @objc private func closePressed() { close() }
    func windowWillClose(_ notification: Notification) {
        closed = true; operation?.cancel(); document = nil
        nameField.stringValue = ""; characterField.string = ""; aboutField.string = ""; activeContent.string = ""; savedContent.string = ""; publicBase.string = ""
        onClose?()
    }
}
