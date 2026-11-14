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

    // a video tile's accessibility description: the display name, an optional role list in parentheses ("(Host, me)",
    // "(Co-host)", "(me)"), then states after commas ("Video on", "Muted", ...). The role list comes off first and "me"
    // in it marks your own tile; only trailing parts that are known states are split off, so a name with a comma
    // ("Lovelace, Ada") stays whole. Zoom's wording for the speaking state is not documented; "talking", "speaking"
    // and "active speaker" are treated as the active speaker
    static let roleWords: Set<String> = ["host", "co-host", "cohost", "me", "you", "guest", "organizer", "presenter"]
    static let stateWords: Set<String> = ["video on", "video off", "camera on", "camera off", "audio on", "audio off", "muted", "unmuted", "audio muted", "audio unmuted", "screen sharing", "sharing screen", "pinned", "spotlighted", "hand raised"]
    static let speakingWords = ["talking", "speaking", "active speaker"]

    static func tile(_ desc: String) -> (name: String, active: Bool, me: Bool)? {
        var text = desc.trimmingCharacters(in: .whitespaces)
        var me = false
        if let r = text.range(of: #"\s*\(([^()]*)\)"#, options: .regularExpression) {
            let roles = text[r].trimmingCharacters(in: CharacterSet(charactersIn: " ()")).components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            if !roles.isEmpty, roles.allSatisfy({ roleWords.contains($0) }) {
                me = roles.contains("me") || roles.contains("you")
                text.removeSubrange(r)
            }
        }
        var parts = text.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        var active = false
        while parts.count > 1, let last = parts.last?.lowercased() {
            let speaking = speakingWords.contains { last.contains($0) }
            guard speaking || stateWords.contains(last) else { break }
            if speaking { active = true }
            parts.removeLast()
        }
        let name = parts.joined(separator: ", ").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : (name, active, me)
    }

    // Record's Screen option during a Zoom call: the names on the other people's video tiles, and which of them is
    // speaking. Your own tile is left out
    static func speakers() -> (names: [String], active: [String])? {
        guard let win = meetingWindow() else { return nil }
        var names: [String] = [], active: [String] = []
        for el in AX.children(win) where AX.role(el) == kAXTabGroupRole {
            for button in AX.children(el) where AX.role(button) == kAXButtonRole {
                guard let t = tile(AX.str(button, kAXDescriptionAttribute) ?? ""), !t.me else { continue }
                if !names.contains(t.name) { names.append(t.name) }
                if t.active, !active.contains(t.name) { active.append(t.name) }
            }
        }
        return (names, active)
    }

    static func dump() -> String { AX.dumpTree(windows()) }
}
