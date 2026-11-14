import AppKit
import ScreenCaptureKit
import Vision

// what is on screen, as spelling hints for the recognizer: the names, product words and acronyms visible in the front
// window (the meeting app's window during a call) become contextual strings, so a name shown on a slide or in the chat
// is written the way it appears. One screenshot per start, recognized on this Mac with Vision, never stored or sent;
// nothing happens without the Screen Recording permission
enum ScreenContext {
    static func access(prompt: Bool) -> Bool { prompt ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess() }

    // the front window of an app whose bundle id starts with one of the prefixes, else the frontmost app's front window
    static func terms(bundlePrefixes: [String], excludePids: [Int32] = []) async -> [String] {
        guard let shot = await read(bundlePrefixes: bundlePrefixes, excludePids: excludePids) else { return [] }
        return extract(shot.text)
    }

    // Quorum's own windows are never read: the app's bundle, the process that started this helper, and any process
    // the app names
    static let ownBundles = ["design.smejkal.quorum"]

    // one on-screen window as the window server lists it, front to back
    struct Candidate: Equatable {
        let id: CGWindowID
        let pid: Int32
        let bundle: String
        let layer: Int
        let width: Double
        let height: Double
    }

    // the window to read: the frontmost window of an app named by a prefix, else the frontmost window that is not
    // Quorum's. Small windows and anything off the normal layer (menus, the Dock, overlays) are skipped. nil when
    // nothing is left, so a read never falls back to Quorum itself
    static func pick(_ windows: [Candidate], bundlePrefixes: [String], excludePids: Set<Int32>, excludeBundles: [String] = ownBundles) -> CGWindowID? {
        let ok = windows.filter { w in
            w.layer == 0 && w.width > 300 && w.height > 200 && !excludePids.contains(w.pid) && !excludeBundles.contains { w.bundle.hasPrefix($0) }
        }
        return (ok.first { w in bundlePrefixes.contains { w.bundle.hasPrefix($0) } } ?? ok.first)?.id
    }

    // the window server's on-screen list, which comes front to back
    static func candidates() -> [Candidate] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var bundles: [Int32: String] = [:]
        return list.compactMap { info in
            guard let id = info[kCGWindowNumber as String] as? CGWindowID, let pid = info[kCGWindowOwnerPID as String] as? Int32 else { return nil }
            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            if bundles[pid] == nil { bundles[pid] = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "" }
            return Candidate(id: id, pid: pid, bundle: bundles[pid] ?? "", layer: info[kCGWindowLayer as String] as? Int ?? 0,
                             width: (bounds?["Width"] as? Double) ?? 0, height: (bounds?["Height"] as? Double) ?? 0)
        }
    }

    // one screenshot of the picked window, recognized with Vision: the lines of text, the app's name and the window
    // title. Record's Screen option adds these to the open note; nothing is stored here, and the image is dropped once read
    static func read(bundlePrefixes: [String], excludePids: [Int32] = []) async -> (text: String, app: String, title: String)? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        do {
            let skip = Set(excludePids + [getpid(), getppid()])
            guard let id = pick(candidates(), bundlePrefixes: bundlePrefixes, excludePids: skip) else { return nil }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let win = content.windows.first(where: { $0.windowID == id }) else { return nil }
            let config = SCStreamConfiguration()
            let scale = 2.0
            config.width = Int(win.frame.width * scale)
            config.height = Int(win.frame.height * scale)
            config.showsCursor = false
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: win), configuration: config)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            return (text, win.owningApplication?.applicationName ?? "", win.title ?? "")
        } catch {
            Emit.log("screen context: \(error.localizedDescription)")
            return nil
        }
    }

    // words a recognizer would otherwise mishear or misspell: capitalized words and two-word names, inner-capital
    // product words, short acronyms, letter-digit mixes. Plain sentence words and common capitalized function words
    // are left out, and the list is capped so the recognizer's context stays small
    static let skip: Set<String> = ["The", "A", "An", "And", "Or", "But", "If", "In", "On", "At", "To", "For", "Of", "By", "With", "From", "As", "Is", "Are", "Was", "Were", "Be", "This", "That", "These", "Those", "It", "We", "You", "They", "He", "She", "I", "My", "Our", "Your", "Their", "Not", "No", "Yes", "So", "Then", "When", "Where", "What", "Who", "How", "Why", "Can", "Will", "Would", "Should", "Could", "Do", "Does", "Did", "Have", "Has", "Had", "New", "All", "Any", "Some", "More", "Most", "Other", "Only", "Also", "Just", "Now", "Here", "There", "Today", "Tomorrow", "Yesterday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "File", "Edit", "View", "Window", "Help", "Search", "Settings", "Home", "Chat", "Share", "Leave", "Join", "Mute", "Unmute", "Camera", "Microphone", "People", "Everyone", "Message", "Send", "Open", "Close", "Save", "Cancel", "Done", "Next", "Back", "Start", "Stop", "Record", "Recording", "Meeting", "Call", "Zoom", "Google", "Meet", "Teams", "Microsoft", "Apple", "Chrome", "Safari"]

    static func extract(_ text: String, cap: Int = 150) -> [String] {
        let letters = CharacterSet.letters
        var seen = Set<String>()
        var out: [String] = []
        let add = { (s: String) in
            let t = s.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?()[]{}\"'“”‘’<>|/\\-_*#@"))
            guard t.count >= 2, t.count <= 40, t.rangeOfCharacter(from: letters) != nil, !skip.contains(t), !seen.contains(t.lowercased()) else { return }
            seen.insert(t.lowercased())
            out.append(t)
        }
        for line in text.split(whereSeparator: \.isNewline) {
            let words = line.split(separator: " ").map(String.init).filter { !$0.isEmpty }
            var i = 0
            while i < words.count {
                let w = words[i].trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?()[]{}\"'“”‘’<>|/\\*#@"))
                let isCap = w.first?.isUppercase == true && w.dropFirst().contains(where: \.isLowercase)
                let innerCap = w.first?.isLowercase == true && w.dropFirst().contains(where: \.isUppercase)
                let acronym = w.count >= 2 && w.count <= 8 && w.allSatisfy { $0.isUppercase || $0.isNumber } && w.contains(where: \.isLetter)
                let mixed = w.contains(where: \.isLetter) && w.contains(where: \.isNumber) && w.count <= 12
                // Ada Lovelace, Smejkal Design: two or three capitalized words in a row become one phrase as well
                if isCap, i + 1 < words.count {
                    var j = i + 1
                    var phrase = [w]
                    while j < words.count, j - i < 3 {
                        let n = words[j].trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?()[]{}\"'“”‘’<>|/\\*#@"))
                        guard n.first?.isUppercase == true, n.dropFirst().contains(where: \.isLowercase), !skip.contains(n) else { break }
                        phrase.append(n)
                        j += 1
                    }
                    if phrase.count > 1 { add(phrase.joined(separator: " ")) }
                }
                if isCap || innerCap || acronym || mixed { add(w) }
                i += 1
            }
            if out.count >= cap { break }
        }
        return Array(out.prefix(cap))
    }
}
