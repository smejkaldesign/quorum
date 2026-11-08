import AppKit
import ApplicationServices
import Foundation

struct MeetingInfo {
    let title: String
    let participants: Int
    let names: [String]
}

// one meeting app Quorum can notice. detect() returns nil outside a call; bundlePrefixes narrow the audio tap;
// canPostNotice says whether the STOP/GO notice can go into the app's chat (only Zoom today)
protocol MeetingProvider {
    var id: String { get }
    var name: String { get }
    var bundlePrefixes: [String] { get }
    var canPostNotice: Bool { get }
    func running() -> Bool
    func detect() -> MeetingInfo?
}

extension MeetingProvider {
    var canPostNotice: Bool { false }
}

enum Providers {
    static let all: [MeetingProvider] = [ZoomProvider(), MeetProvider(), TeamsProvider()]

    static func named(_ id: String) -> MeetingProvider? { all.first { $0.id == id } }

    // the first provider with a live call wins; Zoom first because its detection is the most exact
    static func detectAny() -> (MeetingProvider, MeetingInfo)? {
        for p in all { if let info = p.detect() { return (p, info) } }
        return nil
    }

    static func runningMap() -> [String: Bool] {
        Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0.running()) })
    }

    // browsers Meet and Teams run in; audio comes from their helper processes, so these are prefixes
    static let browserPrefixes = ["com.google.Chrome", "com.apple.Safari", "com.apple.WebKit", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser", "org.mozilla", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]

    static func runningApps(prefixes: [String]) -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { app in
            guard let b = app.bundleIdentifier else { return false }
            return prefixes.contains { b.hasPrefix($0) }
        }
    }

    // Chromium only builds its web accessibility tree once a client asks for it; this attribute asks without the
    // window management side effects of AXEnhancedUserInterface. Safari and Firefox expose the tree anyway
    static func enableWebAX(_ app: AXUIElement) {
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    static func windows(of app: NSRunningApplication) -> (AXUIElement, [AXUIElement]) {
        let el = AXUIElementCreateApplication(app.processIdentifier)
        return (el, (AX.attr(el, kAXWindowsAttribute) as? [AXUIElement]) ?? [])
    }

    // first button under the window whose label matches; capped so a big web page can't stall the poll
    static func findButton(in win: AXUIElement, where match: (String) -> Bool, limit: Int = 3000) -> AXUIElement? {
        var found: AXUIElement?
        var count = 0
        AX.walk(win, maxDepth: 30) { el, _ in
            if found != nil { return false }
            count += 1
            if count > limit { return false }
            if AX.role(el) == kAXButtonRole {
                let label = [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute].compactMap { AX.str(el, $0) }.joined(separator: " ")
                if match(label) { found = el; return false }
            }
            return true
        }
        return found
    }

    // participant count shown next to the people button; both apps render it as a bare number beside it
    static func countNear(_ button: AXUIElement) -> Int {
        guard let parent = AX.attr(button, kAXParentAttribute) else { return 0 }
        var n = 0
        AX.walk(parent as! AXUIElement, maxDepth: 4) { el, _ in
            if n > 0 { return false }
            let s = (AX.str(el, kAXValueAttribute) ?? AX.str(el, kAXTitleAttribute) ?? AX.str(el, kAXDescriptionAttribute) ?? "").trimmingCharacters(in: .whitespaces)
            if let v = Int(s), v > 0, v < 10000 { n = v }
            return true
        }
        return n
    }

    static func dump(prefix: String) -> String {
        var out = ""
        for app in runningApps(prefixes: [prefix]) {
            let (el, wins) = windows(of: app)
            enableWebAX(el)
            out += "### \(app.bundleIdentifier ?? "?") pid \(app.processIdentifier) windows \(wins.count)\n"
            out += AX.dumpTree(wins)
        }
        return out.isEmpty ? "no running app with bundle id prefix \(prefix)\n" : out
    }
}

extension AX {
    static func dumpTree(_ windows: [AXUIElement]) -> String {
        var out = ""
        for (i, win) in windows.enumerated() {
            out += "=== window \(i): \(AX.str(win, kAXTitleAttribute) ?? "")\n"
            var count = 0
            AX.walk(win) { el, depth in
                count += 1
                if count > 6000 { return false }
                var line = String(repeating: "  ", count: depth) + AX.role(el)
                if let s = AX.str(el, kAXSubroleAttribute) { line += " [\(s)]" }
                if let s = AX.str(el, kAXIdentifierAttribute), !s.isEmpty { line += " id=\(s)" }
                if let s = AX.str(el, kAXTitleAttribute), !s.isEmpty { line += " title=\(s.prefix(80))" }
                if let s = AX.str(el, kAXDescriptionAttribute), !s.isEmpty { line += " desc=\(s.prefix(80))" }
                if let s = AX.str(el, kAXValueAttribute), !s.isEmpty { line += " value=\(s.prefix(120).replacingOccurrences(of: "\n", with: "⏎"))" }
                out += line + "\n"
                return true
            }
        }
        return out
    }
}

struct ZoomProvider: MeetingProvider {
    let id = "zoom"
    let name = "Zoom"
    let bundlePrefixes = ["us.zoom"]
    var canPostNotice: Bool { true }
    func running() -> Bool { ZoomChat.app() != nil }
    func detect() -> MeetingInfo? {
        guard let i = ZoomChat.meetingInfo() else { return nil }
        return MeetingInfo(title: i.title, participants: i.participants, names: i.names)
    }
}

// Meet lives in a browser tab or the Chrome PWA (bundle id com.google.Chrome.app.<id>). The tab title is
// "Meet – abc-defg-hij" from the lobby onward, so the Leave call button tells the lobby from the call when
// the browser exposes its web tree; without it the title alone counts
struct MeetProvider: MeetingProvider {
    let id = "meet"
    let name = "Google Meet"
    var bundlePrefixes: [String] { Providers.browserPrefixes }
    static let title = try! NSRegularExpression(pattern: #"^Meet\s[–-]\s(.+?)(\s[-—]\s(Google Chrome|Brave|Microsoft.?Edge|Mozilla Firefox|Vivaldi|Opera).*)?$"#)
    static let code = try! NSRegularExpression(pattern: #"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b"#)

    func running() -> Bool { !matchingWindows().isEmpty }

    func matchingWindows() -> [(AXUIElement, String)] {
        var out: [(AXUIElement, String)] = []
        for app in Providers.runningApps(prefixes: Providers.browserPrefixes) {
            let (el, wins) = Providers.windows(of: app)
            Providers.enableWebAX(el)
            for w in wins {
                let t = AX.str(w, kAXTitleAttribute) ?? ""
                let range = NSRange(t.startIndex..., in: t)
                guard let m = Self.title.firstMatch(in: t, range: range), let r = Range(m.range(at: 1), in: t) else { continue }
                out.append((w, String(t[r])))
            }
        }
        return out
    }

    func detect() -> MeetingInfo? {
        for (win, rest) in matchingWindows() {
            let leave = Providers.findButton(in: win) { $0.localizedCaseInsensitiveContains("leave call") }
            let lobby = Providers.findButton(in: win) { $0.localizedCaseInsensitiveContains("join now") || $0.localizedCaseInsensitiveContains("ask to join") }
            if leave == nil, lobby != nil { continue }
            // the title only carries the call code; the meeting name is shown in the page and read when exposed
            let people = Providers.findButton(in: win) { $0.localizedCaseInsensitiveContains("people") || $0.localizedCaseInsensitiveContains("show everyone") }
            let count = people.map(Providers.countNear) ?? 0
            let range = NSRange(rest.startIndex..., in: rest)
            let title = Self.code.firstMatch(in: rest, range: range).flatMap { Range($0.range, in: rest) }.map { String(rest[$0]) } ?? rest
            return MeetingInfo(title: title, participants: count, names: [])
        }
        return nil
    }
}

// Teams desktop (com.microsoft.teams2, WebView2 shell) or a browser tab titled "... | Microsoft Teams".
// the main window exists all day, so a call is only counted when a Leave or Hang up button is exposed
struct TeamsProvider: MeetingProvider {
    let id = "teams"
    let name = "Microsoft Teams"
    static let appPrefixes = ["com.microsoft.teams"]
    var bundlePrefixes: [String] { Self.appPrefixes + Providers.browserPrefixes }

    func running() -> Bool {
        !Providers.runningApps(prefixes: Self.appPrefixes).isEmpty || !browserWindows().isEmpty
    }

    func browserWindows() -> [AXUIElement] {
        var out: [AXUIElement] = []
        for app in Providers.runningApps(prefixes: Providers.browserPrefixes) {
            let (el, wins) = Providers.windows(of: app)
            Providers.enableWebAX(el)
            out += wins.filter { (AX.str($0, kAXTitleAttribute) ?? "").contains("Microsoft Teams") }
        }
        return out
    }

    func detect() -> MeetingInfo? {
        var wins: [AXUIElement] = []
        for app in Providers.runningApps(prefixes: Self.appPrefixes) {
            let (el, w) = Providers.windows(of: app)
            Providers.enableWebAX(el)
            wins += w
        }
        wins += browserWindows()
        for win in wins {
            guard Providers.findButton(in: win, where: { l in
                let s = l.trimmingCharacters(in: .whitespaces)
                return s.hasPrefix("Leave") || s.localizedCaseInsensitiveContains("hang up")
            }) != nil else { continue }
            let people = Providers.findButton(in: win) { $0.localizedCaseInsensitiveContains("people") || $0.localizedCaseInsensitiveContains("participants") }
            let count = people.map(Providers.countNear) ?? 0
            var title = AX.str(win, kAXTitleAttribute) ?? ""
            for suffix in [" | Microsoft Teams", " - Microsoft Teams", "Microsoft Teams"] { title = title.replacingOccurrences(of: suffix, with: "") }
            title = title.components(separatedBy: " - Google Chrome").first ?? title
            return MeetingInfo(title: title.trimmingCharacters(in: .whitespaces), participants: count, names: [])
        }
        return nil
    }
}
