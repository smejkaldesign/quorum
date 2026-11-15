import AVFAudio
import CoreMedia
import FluidAudio
import Foundation
import SoundAnalysis

// Who is talking on one channel, on the Mac: LS-EEND numbers each voice it hears (up to 10, with overlaps) and Apple's
// built-in sound classifier marks laughter, crosstalk, raised voices, applause and music. Both read the same buffers as
// the transcriber, so their seconds line up with its word times. Events:
//   {event: "voices", channel, segments: [{voice, start, end, final}]}  finalized spans are new; tentative ones replace the last set
//   {event: "sound", channel, label, start, end, confidence}
final class VoiceTracker: NSObject, SNResultsObserving {
    let channel: String
    private let queue = DispatchQueue(label: "quorum.voices")
    private var diarizer: LSEENDDiarizer?
    private var waiting: [Float] = [] // audio heard while the model loads, fed in order once it's ready
    private var converter: AVAudioConverter?
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var sound: SNAudioStreamAnalyzer?
    private var framePos: AVAudioFramePosition = 0
    private var running = false
    private var loading: Task<Void, Never>?

    init(channel: String) { self.channel = channel }

    func start() {
        running = true
        framePos = 0
        waiting = []
        let analyzer = SNAudioStreamAnalyzer(format: format)
        do {
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            request.windowDuration = CMTime(seconds: 1.5, preferredTimescale: 1000)
            request.overlapFactor = 0.5
            try analyzer.add(request, withObserver: self)
            sound = analyzer
        } catch { Emit.log("\(channel) sound classifier off: \(error.localizedDescription)") }
        let channel = self.channel
        loading = Task {
            do {
                let d = LSEENDDiarizer()
                try await d.initialize(variant: .dihard3) // trained on varied far-field audio: rooms, TV, overlapping talk
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    queue.async { [weak self] in
                        defer { c.resume() }
                        guard let self, self.running else { return }
                        self.diarizer = d
                        let backlog = self.waiting
                        self.waiting = []
                        self.diarize(backlog)
                    }
                }
            } catch { Emit.log("\(channel) voice separation off: \(error.localizedDescription)") }
        }
    }

    // the eval harness feeds a whole file at once; this waits for the model so nothing is dropped
    func waitReady() async { await loading?.value }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.deepCopy() else { return }
        queue.async { [weak self] in self?.convert(copy) }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard running else { return }
        if converter == nil || converter!.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0, let data = out.floatChannelData else { return }
        sound?.analyze(out, atAudioFramePosition: framePos)
        framePos += AVAudioFramePosition(out.frameLength)
        let samples = Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
        if diarizer == nil { waiting.append(contentsOf: samples); return }
        diarize(samples)
    }

    private func diarize(_ samples: [Float]) {
        guard let diarizer, !samples.isEmpty else { return }
        do {
            try diarizer.addAudio(samples, sourceSampleRate: 16000)
            if let update = try diarizer.process() { send(update) }
        } catch { Emit.log("\(channel) voice separation: \(error.localizedDescription)") }
    }

    private func send(_ update: DiarizerTimelineUpdate) {
        let span = { (s: DiarizerSegment) -> [String: Any] in ["voice": s.speakerIndex, "start": Double(s.startTime), "end": Double(s.endTime), "final": s.isFinalized] }
        let segments = update.finalizedSegments.map(span) + update.tentativeSegments.map(span)
        Emit.send(["event": "voices", "channel": channel, "segments": segments])
    }

    // the classes worth a line in a transcript; anything else (keyboard, traffic, silence) stays out
    static func label(_ id: String) -> String? {
        let s = id.lowercased()
        if s.contains("laugh") || s.contains("giggl") || s.contains("chuckl") || s.contains("snicker") { return "Laughing" }
        if s.contains("crowd") || s.contains("chatter") || s.contains("babble") { return "Crosstalk" }
        if s.contains("shout") || s.contains("yell") || s.contains("scream") { return "Raised voices" }
        if s.contains("applause") || s.contains("clapping") || s.contains("cheer") { return "Applause" }
        if s.contains("music") || s.contains("singing") { return "Music" }
        return nil
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        for c in result.classifications.prefix(5) where c.confidence >= 0.6 {
            guard let label = Self.label(c.identifier) else { continue }
            let start = result.timeRange.start.seconds, end = (result.timeRange.start + result.timeRange.duration).seconds
            Emit.send(["event": "sound", "channel": channel, "label": label, "start": start, "end": end, "confidence": c.confidence])
            return
        }
    }

    func stop() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async { [weak self] in
                guard let self else { return c.resume() }
                self.running = false
                self.sound?.completeAnalysis()
                self.sound = nil
                if let d = self.diarizer, let update = try? d.finalizeSession() { self.send(update) }
                self.diarizer = nil
                self.converter = nil
                c.resume()
            }
        }
    }
}

