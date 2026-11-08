import AVFAudio
import Foundation

// mic-only transcription for the composer's dictate button; nothing is written to disk
final class Dictation {
    private let mic = MicCapture()
    private let transcriber = ChannelTranscriber(channel: "dictation")
    private var running = false

    func start(locale: String = "en-US") async {
        guard !running else { return }
        guard await AVAudioApplication.requestRecordPermission() else { Emit.error("dictation: microphone permission denied"); return }
        do {
            try await transcriber.start(locale: Locale(identifier: locale), audioURL: nil)
            let t = transcriber
            try mic.start(echoCancel: false) { t.feed($0) }
            running = true
            Emit.send(["event": "dictation", "state": "on"])
        } catch {
            Emit.error("dictation: \(error.localizedDescription)")
            Emit.send(["event": "dictation", "state": "off"])
        }
    }

    func stop() async {
        guard running else { return }
        running = false
        mic.stop()
        await transcriber.stop()
        Emit.send(["event": "dictation", "state": "off"])
    }
}
