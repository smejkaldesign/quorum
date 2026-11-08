import AVFAudio
import Foundation

final class Session {
    private let mic = MicCapture()
    private let tap = SystemTap()
    private let me = ChannelTranscriber(channel: "me")
    private let them = ChannelTranscriber(channel: "them")
    private let meter = LevelMeter()
    private(set) var running = false

    func start(dir: URL?, echoCancel: Bool, locale id: String = "en-US", tapBundles: [String] = []) async throws {
        guard !running else { return }
        Emit.status("requesting microphone permission")
        guard await AVAudioApplication.requestRecordPermission() else {
            throw NSError(domain: "quorum", code: 3, userInfo: [NSLocalizedDescriptionKey: "microphone permission denied"])
        }
        if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let locale = Locale(identifier: id)
        Emit.status("starting on-device transcribers")
        try await me.start(locale: locale, audioURL: dir?.appendingPathComponent("me.caf"))
        try await them.start(locale: locale, audioURL: dir?.appendingPathComponent("them.caf"))
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
        do { try await session.start(dir: dir, echoCancel: cmd["echoCancel"] as? Bool ?? false, locale: cmd["locale"] as? String ?? "en-US", tapBundles: cmd["tapBundles"] as? [String] ?? []) }
        catch { Emit.error("start: \(error.localizedDescription)") }
    case "stop":
        await session.stop()
    case "dictateStart":
        await dictation.start(locale: cmd["locale"] as? String ?? "en-US")
    case "dictateStop":
        await dictation.stop()
    case "chatWatch":
        ChatWatcher.shared.setEnabled(cmd["on"] as? Bool ?? true)
    case "chatSend":
        if let text = cmd["text"] as? String { ChatWatcher.shared.send(text, id: cmd["id"] as? String) }
    case "chatReply":
        if let text = cmd["text"] as? String, let to = cmd["to"] as? String { ChatWatcher.shared.reply(to: to, text: text, id: cmd["id"] as? String) }
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
        let seconds = args.count > 2 ? Double(args[2]) ?? 10 : 10
        Task {
            do { try await session.start(dir: nil, echoCancel: false) } catch { Emit.error(error.localizedDescription); exit(1) }
            try? await Task.sleep(for: .seconds(seconds))
            await session.stop()
            exit(0)
        }
        dispatchMain()
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
        Emit.log("usage: quorum-helper [dump-zoom | dump-ax <bundle-prefix> | detect | test-capture <sec> | chat-read | chat-send <text>]")
        exit(2)
    }
}

Thread.detachNewThread {
    while let line = readLine() {
        let semaphore = DispatchSemaphore(value: 0)
        Task { await handle(line); semaphore.signal() }
        semaphore.wait()
    }
    Task { await session.stop(); exit(0) }
}
Emit.send(["event": "ready"])
ChatWatcher.shared.startMeetingWatch()
dispatchMain()
