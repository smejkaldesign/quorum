import AppKit
import ApplicationServices
import Foundation

// Google Meet's in-call chat through the browser's web accessibility tree. A browser exposes only the active tab of each
// window, so posting raises the Meet tab first; reading STOP and GO works while the Meet tab stays in front, which is
// where the user is during a call. Verified against Meet on 2026-11-08: the composer and its button are both labeled
// "Send a message", bubbles are plain text under a time stamp, and other people's messages carry a sender line above the time
enum MeetChat {
    static let timeRe = try! NSRegularExpression(pattern: #"^\d{1,2}:\d{2}\s?(AM|PM)?$"#, options: .caseInsensitive)
    static let noise: Set<String> = ["Hover over a message to pin it", "Pin message", "keep", "send", "chat", "close", "arrow_back", "In-call messages", "Let participants send messages", "Continuous chat is turned off", "History is on", "History is off", "on", "Back", "Close"]

    static func isTime(_ s: String) -> Bool { timeRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

    static func label(_ el: AXUIElement) -> String {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute].compactMap { AX.str(el, $0) }.joined(separator: " ")
    }

    // the window whose active tab is the live call; with raise, a window holding a background Meet tab is brought forward first
    static func callWindow(raise: Bool) -> (AXUIElement, pid_t)? {
        let meet = MeetProvider()
        for app in Providers.runningApps(prefixes: Providers.browserPrefixes) {
            let (el, wins) = Providers.windows(of: app)
            Providers.enableWebAX(el)
            if let w = wins.first(where: { meet.isCall(window: $0) }) { return (w, app.processIdentifier) }
            guard raise else { continue }
            // several tabs can carry the Meet title (a call left earlier keeps it), so each one is tried until a live call shows
            for w in wins {
                for tab in meetTabButtons(in: w) {
                    AXUIElementPerformAction(tab, kAXPressAction as CFString)
                    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
                    let deadline = Date().addingTimeInterval(2)
                    while Date() < deadline {
                        if meet.isCall(window: w) { return (w, app.processIdentifier) }
                        Thread.sleep(forTimeInterval: 0.15)
                    }
                }
            }
        }
        return nil
    }

    static func meetTabButton(in win: AXUIElement) -> AXUIElement? { meetTabButtons(in: win).first }

    static func meetTabButtons(in win: AXUIElement) -> [AXUIElement] {
        var found: [AXUIElement] = []
        var n = 0
        AX.walk(win, maxDepth: 24) { el, _ in
            n += 1
            if n > 4000 { return false }
            if AX.str(el, kAXSubroleAttribute) == "AXTabButton", let t = AX.str(el, kAXTitleAttribute), MeetProvider.isMeetTitle(t) { found.append(el); return false }
            return true
        }
        return found
    }

    // the composer: labelled "Send a message" for years, and since late 2026 after the history setting ("History is on"); the
    // call page has no other text area, so any text area that is not the browser's address bar is taken when the label is unknown
    static func input(in win: AXUIElement) -> AXUIElement? {
        var found: AXUIElement?
        var fallback: AXUIElement?
        var n = 0
        AX.walk(win, maxDepth: 40) { el, _ in
            if found != nil { return false }
            n += 1
            if n > 6000 { return false }
            let role = AX.role(el)
            guard role == kAXTextAreaRole || role == kAXTextFieldRole else { return true }
            let text = label(el)
            if text.localizedCaseInsensitiveContains("send a message") { found = el; return false }
            if role == kAXTextAreaRole, fallback == nil, !text.localizedCaseInsensitiveContains("address") { fallback = el }
            return true
        }
        return found ?? fallback
    }

    static func sendButton(in win: AXUIElement) -> AXUIElement? {
        Providers.findButton(in: win, where: { $0.localizedCaseInsensitiveContains("send a message") || $0.localizedCaseInsensitiveContains("send message") }, limit: 6000)
    }

    // the chat button toggles the side panel, so it is pressed only when the composer is missing
    @discardableResult
    static func ensureOpen(in win: AXUIElement, timeout: TimeInterval = 3) -> Bool {
        if input(in: win) != nil { return true }
        guard let button = Providers.findButton(in: win, where: { $0.localizedCaseInsensitiveContains("chat with everyone") }, limit: 6000) else { return false }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if input(in: win) != nil { return true }
            Thread.sleep(forTimeInterval: 0.15)
        }
        return false
    }

    // static texts between the panel heading and the composer, in page order. A group is [sender] time text...; the sender
    // line shares a parent with the time stamp, own messages have no sender line
    static func readMessages(in win: AXUIElement) -> [ChatMessage] {
        var items: [(text: String, parent: AXUIElement?)] = []
        var started = false
        var done = false
        var n = 0
        AX.walk(win, maxDepth: 40) { el, _ in
            if done { return false }
            n += 1
            if n > 8000 { return false }
            let role = AX.role(el)
            if role == "AXHeading", (AX.str(el, kAXTitleAttribute) ?? AX.str(el, kAXValueAttribute) ?? "") == "In-call messages" { started = true; return true }
            guard started else { return true }
            if role == kAXTextAreaRole || role == kAXTextFieldRole, label(el).localizedCaseInsensitiveContains("send a message") { done = true; return false }
            if role == kAXStaticTextRole, let v = AX.str(el, kAXValueAttribute)?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty, !noise.contains(v), !v.hasPrefix("Messages will not be saved") {
                items.append((v, AX.attr(el, kAXParentAttribute).map { $0 as! AXUIElement }))
            }
            return true
        }
        let sameParent = { (a: AXUIElement?, b: AXUIElement?) -> Bool in
            guard let a, let b else { return false }
            return CFEqual(a, b)
        }
        var out: [ChatMessage] = []
        var sender = "You"
        var seenTime = false
        var counts: [String: Int] = [:]
        for (i, it) in items.enumerated() {
            if isTime(it.text) {
                sender = i > 0 && !isTime(items[i - 1].text) && sameParent(items[i - 1].parent, it.parent) ? items[i - 1].text : "You"
                seenTime = true
                continue
            }
            if i + 1 < items.count, isTime(items[i + 1].text), sameParent(it.parent, items[i + 1].parent) { continue }
            guard seenTime else { continue }
            let base = "\(sender)|\(it.text)"
            let k = counts[base, default: 0]
            counts[base] = k + 1
            out.append(ChatMessage(sender: sender, text: it.text, key: "\(base)#\(k)"))
        }
        return out
    }

    // raise the tab, open the panel, set the composer's value, press Send, then confirm the bubble appeared
    static func send(_ text: String) -> String? {
        guard let (win, _) = callWindow(raise: true) else { return "no Google Meet call in front" }
        guard ensureOpen(in: win), let field = input(in: win) else { return "couldn't open the Meet chat panel" }
        AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let status = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, text as CFString)
        if status != .success { return "couldn't set text (AXError \(status.rawValue))" }
        Thread.sleep(forTimeInterval: 0.2)
        guard let button = sendButton(in: win) else { return "no Send button in the Meet chat" }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if readMessages(in: win).contains(where: { $0.text == text || text.hasSuffix($0.text) }) { return nil }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return "message didn't appear in the Meet chat"
    }
}
