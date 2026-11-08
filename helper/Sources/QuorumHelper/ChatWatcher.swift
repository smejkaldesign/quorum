import AppKit
import ApplicationServices
import Foundation

struct ChatMessage {
    let sender: String
    let text: String
    let key: String
}

// v0 heuristics; tightened once we've seen Zoom's real AX tree via dump-zoom
final class ChatWatcher {
    static let shared = ChatWatcher()
    private var timer: DispatchSourceTimer?
    private var seen = Set<String>()
    private var primed = false
    private let queue = DispatchQueue(label: "quorum.chat")

    func setEnabled(_ on: Bool) {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            guard on else { return }
            ZoomChat.ensureChatOpen()
            self.primed = false
            self.seen.removeAll()
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: .milliseconds(300))
            t.setEventHandler { [weak self] in self?.poll() }
            t.resume()
            self.timer = t
        }
    }

    private var meetingActive = false
    private var lastTitle = ""
    private var lastCount = -1
    private var lastNames: [String] = []
    private var meetingTimer: DispatchSourceTimer?
    private(set) var provider: MeetingProvider?

    // polls every provider; Zoom's meeting window only exists while you're in a meeting, Meet and Teams are read from their windows
    func startMeetingWatch() {
        queue.async {
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: .milliseconds(1500))
            t.setEventHandler { [weak self] in
                guard let self else { return }
                let hit = Providers.detectAny()
                let info = hit?.1
                let active = info != nil
                if active != self.meetingActive {
                    self.meetingActive = active
                    let p = hit?.0 ?? self.provider ?? ZoomProvider()
                    if active { self.provider = p }
                    Emit.send(["event": "meeting", "active": active, "app": p.name, "provider": p.id, "chat": p.canPostNotice])
                }
                if let info, info.title != self.lastTitle || info.participants != self.lastCount || info.names != self.lastNames {
                    self.lastTitle = info.title
                    self.lastCount = info.participants
                    self.lastNames = info.names
                    Emit.send(["event": "meetingInfo", "title": info.title, "participants": info.participants, "names": info.names])
                }
            }
            t.resume()
            self.meetingTimer = t
        }
    }

    private func poll() {
        // the open panel is how Quorum sees STOP, so reopen it if someone closes it
        if chatInput() == nil, ZoomChat.meetingWindow() != nil { ZoomChat.ensureChatOpen(timeout: 1) }
        let messages = readMessages()
        for m in messages where !seen.contains(m.key) {
            seen.insert(m.key)
            // anything already in the chat when watching starts is history, not a command
            if primed { Emit.send(["event": "chat", "sender": m.sender, "text": m.text, "key": m.key]) }
        }
        primed = true
    }

    func chatInput() -> AXUIElement? {
        var found: AXUIElement?
        for win in ZoomChat.windows() {
            AX.walk(win) { el, _ in
                if found != nil { return false }
                let role = AX.role(el)
                if role == kAXTextAreaRole || role == kAXTextFieldRole {
                    let hint = (AX.str(el, kAXDescriptionAttribute) ?? "") + (AX.str(el, kAXPlaceholderValueAttribute) ?? "") + (AX.str(el, kAXTitleAttribute) ?? "")
                    if hint.localizedCaseInsensitiveContains("message") || hint.localizedCaseInsensitiveContains("chat") { found = el }
                }
                return true
            }
        }
        return found
    }

    // the chat list can live in the meeting window or a popped-out chat window
    func chatTable() -> AXUIElement? {
        var found: AXUIElement?
        for win in ZoomChat.windows() {
            AX.walk(win, maxDepth: 6) { el, _ in
                if found != nil { return false }
                if AX.role(el) == kAXTableRole, (AX.str(el, kAXDescriptionAttribute) ?? "").hasPrefix("Chat list") { found = el }
                return true
            }
            if found != nil { break }
        }
        return found
    }

    // Zoom row: ZMTextMessageCellView > [profile button, sender, time, text, ...]; grouped follow-ups omit the sender.
    // thread replies nest inside rows, so search the whole table rather than direct children
    func readMessages() -> [ChatMessage] {
        guard let table = chatTable() else { return [] }
        var cells: [AXUIElement] = []
        AX.walk(table, maxDepth: 12) { el, _ in
            let id = AX.str(el, kAXIdentifierAttribute) ?? ""
            if id.contains("TextMessageCellView") || id.contains("ReplyMessageCellView") { cells.append(el); return false }
            return true
        }
        var out: [ChatMessage] = []
        var lastSender = ""
        var seenCount: [String: Int] = [:]
        for cell in cells {
            let parts = AX.children(cell).filter { AX.role($0) == "AXUnknown" }.compactMap { AX.str($0, kAXValueAttribute) }
            guard let text = parts.last, !text.isEmpty else { continue }
            if parts.count >= 2 { lastSender = parts.first! }
            let base = "\(lastSender)|\(text)|\(AX.str(cell, kAXDescriptionAttribute) ?? "")"
            let n = seenCount[base, default: 0]
            seenCount[base] = n + 1
            out.append(ChatMessage(sender: lastSender, text: text, key: "\(base)#\(n)"))
        }
        return out
    }

    func send(_ text: String, id: String? = nil) {
        queue.async { self.sendNow(text, id: id) }
    }

    func reply(to original: String, text: String, id: String?) {
        queue.async { self.replyNow(to: original, text: text, id: id) }
    }

    // answers inside the thread of an earlier message: find its cell, press its Reply button, type into the box that opens
    private func replyNow(to original: String, text: String, id: String?) {
        let fail = { (why: String) in Emit.send(["event": "chatFailed", "id": id ?? "", "message": why]) }
        guard let (app, pid) = ZoomChat.app() else { return fail("Zoom isn't running") }
        guard ZoomChat.ensureChatOpen(), let table = chatTable() else { return fail("couldn't open the Zoom chat panel") }
        var target: AXUIElement?
        AX.walk(table, maxDepth: 12) { el, _ in
            let id = AX.str(el, kAXIdentifierAttribute) ?? ""
            guard id.contains("TextMessageCellView") else { return true }
            let parts = AX.children(el).filter { AX.role($0) == "AXUnknown" }.compactMap { AX.str($0, kAXValueAttribute) }
            if let t = parts.last, original.hasPrefix(t) || t.hasPrefix(original) { target = el }
            return false
        }
        guard let cell = target else { return fail("couldn't find the original message") }
        var replyButton: AXUIElement?
        AX.walk(cell, maxDepth: 6) { el, _ in
            let label = (AX.str(el, kAXDescriptionAttribute) ?? "") + (AX.str(el, kAXTitleAttribute) ?? "")
            if AX.role(el) == kAXButtonRole, label.localizedCaseInsensitiveContains("reply") { replyButton = el; return false }
            return replyButton == nil
        }
        guard let button = replyButton else { return fail("no Reply button on the original message") }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
        Thread.sleep(forTimeInterval: 0.5)
        guard let focused = AX.attr(app, kAXFocusedUIElementAttribute) else { return fail("reply box didn't open") }
        let input = focused as! AXUIElement
        guard [kAXTextAreaRole, kAXTextFieldRole].contains(AX.role(input)) else { return fail("reply box didn't open") }
        if AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFString) != .success { return fail("couldn't set reply text") }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: down)?.postToPid(pid) }
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if readMessages().contains(where: { $0.text == text || text.hasSuffix($0.text) }) {
                Emit.send(["event": "chatSent", "id": id ?? "", "text": text])
                return
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        fail("reply didn't appear in the chat")
    }

    private func sendNow(_ text: String, id: String?) {
        let fail = { (why: String) in Emit.send(["event": "chatFailed", "id": id ?? "", "message": why]) }
        if let p = provider, meetingActive, !p.canPostNotice { return fail("\(p.name) has no chat Quorum can post in") }
        guard let (_, pid) = ZoomChat.app() else { return fail("Zoom isn't running") }
        guard ZoomChat.ensureChatOpen(), let input = chatInput() else { return fail("couldn't open the Zoom chat panel") }
        AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let status = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFString)
        if status != .success { return fail("couldn't set text (AXError \(status.rawValue))") }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: down)?.postToPid(pid)
        }
        // confirm it actually landed in the chat list before reporting success
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if readMessages().contains(where: { $0.text == text || text.hasSuffix($0.text) }) {
                Emit.send(["event": "chatSent", "id": id ?? "", "text": text])
                return
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        fail("message didn't appear in the chat")
    }
}
