import AVFAudio
import Foundation

final class Session {
    private let mic = MicCapture()
    private let tap = SystemTap()
    private let me = ChannelTranscriber(channel: "me")
    private let them = ChannelTranscriber(channel: "them")
    private let meter = LevelMeter()
    private(set) var running = false

    // streamPcm: skip SpeechAnalyzer and emit 16 kHz PCM per channel instead; the app forwards it to the relay
    func start(dir: URL?, echoCancel: Bool, locale id: String = "en-US", tapBundles: [String] = [], terms: [String] = [], streamPcm: Bool = false) async throws {
        guard !running else { return }
        Emit.status("requesting microphone permission")
        guard await AVAudioApplication.requestRecordPermission() else {
            throw NSError(domain: "quorum", code: 3, userInfo: [NSLocalizedDescriptionKey: "microphone permission denied"])
        }
        if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let locale = Locale(identifier: id)
        if streamPcm {
            Emit.status("streaming audio to managed transcription")
            try me.startStreaming(audioURL: dir?.appendingPathComponent("me.caf"))
            try them.startStreaming(audioURL: dir?.appendingPathComponent("them.caf"))
        } else {
            Emit.status("starting on-device transcribers")
            try await me.start(locale: locale, audioURL: dir?.appendingPathComponent("me.caf"), terms: terms)
            try await them.start(locale: locale, audioURL: dir?.appendingPathComponent("them.caf"), terms: terms)
        }
        let me = self.me, them = self.them, meter = self.meter
        try mic.start(echoCancel: echoCancel) { me.feed($0); meter.feed($0) }
        Emit.status("mic on, starting system audio tap")
        try tap.start(bundles: tapBundles) { them.feed($0); meter.feed($0) }
        running = true
        Emit.status("capturing")
    }

    func stop() async {
        guard running else { return }
        running = false
        mic.stop()
        tap.stop()
        await me.stop()
        await them.stop()
        Emit.send(["event": "stopped"])
    }

    // offline path for the eval harness: the same transcribers, fed from files instead of the mic and the tap.
    // Both files start at audio time zero, so a two-channel pair must share one timeline.
    func transcribeFiles(me meURL: URL, them themURL: URL?, locale id: String = "en-US", terms: [String] = []) async throws {
        let locale = Locale(identifier: id)
        try await me.start(locale: locale, audioURL: nil, terms: terms)
        if themURL != nil { try await them.start(locale: locale, audioURL: nil, terms: terms) }
        for (transcriber, url) in [(me, meURL), (them, themURL)] {
            guard let url else { continue }
            let file = try AVAudioFile(forReading: url)
            while file.framePosition < file.length {
                guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16384) else { break }
                try file.read(into: buf)
                if buf.frameLength == 0 { break }
                transcriber.feed(buf)
            }
        }
        await me.stop()
        if themURL != nil { await them.stop() }
        Emit.send(["event": "stopped"])
    }
}

let session = Session()
let dictation = Dictation()
let args = CommandLine.arguments

func handle(_ line: String) async {
    guard let data = line.data(using: .utf8),
          let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let name = cmd["cmd"] as? String else { return }
    switch name {
    case "start":
        let dir = (cmd["sessionDir"] as? String).map { URL(fileURLWithPath: $0) }
        do { try await session.start(dir: dir, echoCancel: cmd["echoCancel"] as? Bool ?? false, locale: cmd["locale"] as? String ?? "en-US", tapBundles: cmd["tapBundles"] as? [String] ?? [], terms: cmd["terms"] as? [String] ?? [], streamPcm: cmd["streamPcm"] as? Bool ?? false) }
        catch { Emit.error("start: \(error.localizedDescription)") }
    case "stop":
        await session.stop()
    case "dictateStart":
        await dictation.start(locale: cmd["locale"] as? String ?? "en-US", terms: cmd["terms"] as? [String] ?? [])
    case "dictateStop":
        await dictation.stop()
    case "audioRoute":
        Emit.send(AudioRoute.current())
    case "chatWatch":
        ChatWatcher.shared.setEnabled(cmd["on"] as? Bool ?? true)
    case "meetingWatch":
        // call detection for Zoom, Meet and Teams; off until the app asks for it
        ChatWatcher.shared.setMeetingWatch(cmd["on"] as? Bool ?? true)
    case "chatSend":
        if let text = cmd["text"] as? String { ChatWatcher.shared.send(text, id: cmd["id"] as? String) }
    case "chatReply":
        if let text = cmd["text"] as? String, let to = cmd["to"] as? String { ChatWatcher.shared.reply(to: to, text: text, id: cmd["id"] as? String) }
    case "screenAccess":
        // the Screen Recording permission: a check, or the system prompt when the app asks for it
        Emit.send(["event": "screenAccess", "id": cmd["id"] as? String ?? "", "granted": ScreenContext.access(prompt: cmd["prompt"] as? Bool ?? false)])
    case "screenTerms":
        // what is on screen right now, as spelling hints; the meeting app's window first when one is named
        let terms = await ScreenContext.terms(bundlePrefixes: cmd["bundles"] as? [String] ?? [])
        Emit.send(["event": "screenTerms", "id": cmd["id"] as? String ?? "", "terms": terms, "granted": ScreenContext.access(prompt: false)])
    case "screenText":
        // Record's Screen option: the front window's text, with its app and title, for the open note
        let shot = await ScreenContext.read(bundlePrefixes: cmd["bundles"] as? [String] ?? [])
        Emit.send(["event": "screenText", "id": cmd["id"] as? String ?? "", "text": shot?.text ?? "", "app": shot?.app ?? "", "title": shot?.title ?? "", "granted": ScreenContext.access(prompt: false)])
    case "axStatus":
        // only asks macOS to show its Accessibility prompt when the app says so (once, not on every launch)
        let running = Providers.runningMap()
        Emit.send(["event": "axStatus", "trusted": AX.trusted(prompt: cmd["prompt"] as? Bool ?? false), "zoomRunning": running["zoom"] ?? false, "providers": running])
    case "calStatus":
        Emit.send(["event": "calResult", "id": cmd["id"] as? String ?? "", "status": CalendarReader.status()])
    case "calRequest":
        await CalendarReader.request(id: cmd["id"] as? String)
    case "calEvents":
        CalendarReader.events(days: cmd["days"] as? Int ?? 3, id: cmd["id"] as? String)
    case "quit":
        await dictation.stop()
        await session.stop()
        exit(0)
    default:
        Emit.error("unknown cmd \(name)")
    }
}

if args.count > 1 {
    switch args[1] {
    case "dump-zoom":
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted to the process running this command"); exit(1) }
        if args.contains("--open-chat") { _ = ZoomChat.ensureChatOpen() }
        print(ZoomChat.dump())
        exit(0)
    case "dump-ax":
        // AX tree of every window of the running apps whose bundle id starts with the prefix, e.g. com.google.Chrome
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted to the process running this command"); exit(1) }
        guard args.count > 2 else { Emit.log("usage: quorum-helper dump-ax <bundle-prefix>"); exit(2) }
        print(Providers.dump(prefix: args[2]))
        exit(0)
    case "detect":
        // what the meeting watch sees right now, once
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted"); exit(1) }
        if let (p, info) = Providers.detectAny() { Emit.send(["event": "meeting", "active": true, "app": p.name, "provider": p.id, "title": info.title, "participants": info.participants, "names": info.names]) }
        else { Emit.send(["event": "meeting", "active": false, "running": Providers.runningMap()]) }
        exit(0)
    case "test-capture":
        let seconds = CLI.captureSeconds(args)
        Task {
            do { try await session.start(dir: nil, echoCancel: false) } catch { Emit.error(error.localizedDescription); exit(1) }
            try? await Task.sleep(for: .seconds(seconds))
            await session.stop()
            exit(0)
        }
        dispatchMain()
    case "transcribe-file":
        // eval harness: finals for one or two channel files, then exit. Extra arguments are vocabulary terms.
        guard let job = CLI.transcribeJob(args) else { Emit.log("usage: quorum-helper transcribe-file <me.wav> [them.wav] [--terms term ...]"); exit(2) }
        Task {
            do { try await session.transcribeFiles(me: job.me, them: job.them, terms: job.terms) }
            catch { Emit.error(error.localizedDescription); exit(1) }
            exit(0)
        }
        dispatchMain()
    case "meet-chat":
        // reads the Meet chat, posts the text when given, reads again; raises the Meet tab if it is in the background
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted"); exit(1) }
        guard let (win, _) = MeetChat.callWindow(raise: true) else { Emit.log("no Google Meet call found"); exit(1) }
        MeetChat.ensureOpen(in: win)
        for m in MeetChat.readMessages(in: win) { Emit.send(["event": "chat", "sender": m.sender, "text": m.text, "key": m.key]) }
        let text = args.dropFirst(2).joined(separator: " ")
        if !text.isEmpty {
            if let why = MeetChat.send(text) { Emit.send(["event": "chatFailed", "message": why]) } else { Emit.send(["event": "chatSent", "text": text]) }
            for m in MeetChat.readMessages(in: win) { Emit.send(["event": "chat", "sender": m.sender, "text": m.text, "key": m.key]) }
        }
        exit(0)
    case "chat-read":
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted"); exit(1) }
        for m in ChatWatcher.shared.readMessages() { Emit.send(["event": "chat", "sender": m.sender, "text": m.text, "key": m.key]) }
        exit(0)
    case "chat-send":
        if !AX.trusted(prompt: true) { Emit.log("Accessibility not granted"); exit(1) }
        ChatWatcher.shared.send(args.dropFirst(2).joined(separator: " "))
        Thread.sleep(forTimeInterval: 5)
        exit(0)
    default:
        Emit.log("usage: quorum-helper [dump-zoom | dump-ax <bundle-prefix> | detect | meet-chat [text] | test-capture <sec> | transcribe-file <me.wav> [them.wav] | chat-read | chat-send <text>]")
        exit(2)
    }
}

// ready and the first audio route go out before any command is read, so a quit that arrives at once (tests, a
// fast caller) cannot end the process ahead of them
Emit.send(["event": "ready"])
AudioRoute.watch()
Thread.detachNewThread {
    while let line = readLine() {
        let semaphore = DispatchSemaphore(value: 0)
        Task { await handle(line); semaphore.signal() }
        semaphore.wait()
    }
    Task { await session.stop(); exit(0) }
}
dispatchMain()
