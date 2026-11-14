import AppKit
import ApplicationServices
import Foundation

enum AX {
    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    static func str(_ el: AXUIElement, _ name: String) -> String? {
        attr(el, name) as? String
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    static func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute) ?? "?" }

    static func walk(_ el: AXUIElement, depth: Int = 0, maxDepth: Int = 40, _ visit: (AXUIElement, Int) -> Bool) {
        guard depth <= maxDepth, visit(el, depth) else { return }
        for child in children(el) { walk(child, depth: depth + 1, maxDepth: maxDepth, visit) }
    }

    static func trusted(prompt: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
    }
}

enum ZoomChat {
    static let bundleID = "us.zoom.xos"

    static func app() -> (AXUIElement, pid_t)? {
        guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return nil }
        return (AXUIElementCreateApplication(running.processIdentifier), running.processIdentifier)
    }

    static func windows() -> [AXUIElement] {
        guard let (app, _) = app() else { return [] }
        return (AX.attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    }

    static func meetingWindow() -> AXUIElement? {
        windows().first { AX.str($0, kAXIdentifierAttribute) == "zm.meeting.window.main" }
    }

    // the chat button is a toggle, so only press it when it says "Open", then wait for the panel to exist.
    // callers must be on ChatWatcher's queue; two concurrent presses open and immediately close it
    @discardableResult
    static func ensureChatOpen(timeout: TimeInterval = 4) -> Bool {
        if ChatWatcher.shared.chatInput() != nil { return true }
        guard let win = meetingWindow(), let (_, pid) = app() else { return false }
        if let button = AX.children(win).first(where: { AX.str($0, kAXIdentifierAttribute) == "chat" }) {
            if (AX.str(button, kAXDescriptionAttribute) ?? "").localizedCaseInsensitiveContains("open chat") {
                AXUIElementPerformAction(button, kAXPressAction as CFString)
            }
        } else {
            // toolbar not built yet or auto-hidden: Zoom's Cmd+Shift+H toggles the chat panel
            let src = CGEventSource(stateID: .hidSystemState)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: 0x04, keyDown: down)
                e?.flags = [.maskCommand, .maskShift]
                e?.postToPid(pid)
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if ChatWatcher.shared.chatInput() != nil { return true }
            Thread.sleep(forTimeInterval: 0.15)
        }
        return false
    }

    // topic comes from the top-bar info button; the participants button reads "N participants"
    // video tiles sit in a tab group; each tile button is labeled with the participant's display name
    static func meetingInfo() -> (title: String, participants: Int, names: [String])? {
        guard let win = meetingWindow() else { return nil }
        var title = "", count = 0
        var names: [String] = []
        for el in AX.children(win) {
            let id = AX.str(el, kAXIdentifierAttribute) ?? "", desc = AX.str(el, kAXDescriptionAttribute) ?? ""
            if id == "MeetingTopBarInfoButton" { title = desc }
            if AX.role(el) == kAXTabGroupRole {
                for tile in AX.children(el) where AX.role(tile) == kAXButtonRole {
                    let name = (AX.str(tile, kAXDescriptionAttribute) ?? "").components(separatedBy: ",")[0].trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty, !names.contains(name) { names.append(name) }
                }
            }
            if id == "participant", let n = desc.range(of: #"(\d+) participant"#, options: .regularExpression) {
                count = Int(desc[n].split(separator: " ").first ?? "") ?? 0
            }
        }
        // the pre-join preview reuses the meeting window but has no topic or participants button; that isn't a meeting yet
        let inMeeting = !title.isEmpty || AX.children(win).contains { AX.str($0, kAXIdentifierAttribute) == "participant" }
        return inMeeting ? (title, count, names) : nil
    }

    // a video tile's accessibility description: the display name first, then states after commas. Zoom's wording for the
    // speaking state is not documented; "talking", "speaking" and "active speaker" are treated as the active speaker
    static func tile(_ desc: String) -> (name: String, active: Bool)? {
        let parts = desc.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let name = parts.first, !name.isEmpty else { return nil }
        let rest = parts.dropFirst().joined(separator: " ").lowercased()
        return (name, ["talking", "speaking", "active speaker"].contains { rest.contains($0) })
    }

    // Record's Screen option during a Zoom call: the names on the video tiles, and which of them is speaking
    static func speakers() -> (names: [String], active: [String])? {
        guard let win = meetingWindow() else { return nil }
        var names: [String] = [], active: [String] = []
        for el in AX.children(win) where AX.role(el) == kAXTabGroupRole {
            for button in AX.children(el) where AX.role(button) == kAXButtonRole {
                guard let t = tile(AX.str(button, kAXDescriptionAttribute) ?? "") else { continue }
                if !names.contains(t.name) { names.append(t.name) }
                if t.active, !active.contains(t.name) { active.append(t.name) }
            }
        }
        return (names, active)
    }

    static func dump() -> String { AX.dumpTree(windows()) }
}
