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
    static func terms(bundlePrefixes: [String]) async -> [String] {
        guard CGPreflightScreenCaptureAccess() else { return [] }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let wins = content.windows.filter { $0.isOnScreen && $0.frame.width > 300 && $0.frame.height > 200 && $0.windowLayer == 0 }
            let pick = wins.first { w in bundlePrefixes.contains { p in (w.owningApplication?.bundleIdentifier ?? "").hasPrefix(p) } }
                ?? wins.first { $0.owningApplication?.processID == front }
                ?? wins.first
            guard let win = pick else { return [] }
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
            return extract(text)
        } catch {
            Emit.log("screen context: \(error.localizedDescription)")
            return []
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
