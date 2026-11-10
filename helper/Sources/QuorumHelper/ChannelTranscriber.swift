import AVFAudio
import CoreMedia
import Foundation
import Speech

final class ChannelTranscriber {
    let channel: String
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var format: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var streaming = false
    private let queue = DispatchQueue(label: "quorum.transcriber")

    init(channel: String) {
        self.channel = channel
    }

    // managed transcription: no analyzer; the same conversion step downmixes to 16 kHz mono Int16 and the app gets
    // every buffer as a base64 pcm event to forward to the relay. The audio file is kept the same way as the local path.
    func startStreaming(audioURL: URL?) throws {
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else {
            throw NSError(domain: "quorum", code: 1, userInfo: [NSLocalizedDescriptionKey: "no 16 kHz PCM format"])
        }
        format = fmt
        if let audioURL {
            file = try AVAudioFile(forWriting: audioURL, settings: fmt.settings, commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
        }
        streaming = true
    }

    func start(locale: Locale, audioURL: URL?, terms: [String] = []) async throws {
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            Emit.status("downloading on-device speech model")
            try await request.downloadAndInstall()
        }
        guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "quorum", code: 1, userInfo: [NSLocalizedDescriptionKey: "no analyzer audio format"])
        }
        format = fmt
        if let audioURL {
            file = try AVAudioFile(forWriting: audioURL, settings: fmt.settings, commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
        }

        let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
        continuation = cont
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        // names and terms from the app, so the model spells them as written; capture goes ahead without them if this fails
        if !terms.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings = [.general: terms]
            do { try await analyzer.setContext(context) } catch { Emit.log("\(channel) vocabulary not applied: \(error.localizedDescription)") }
        }
        try await analyzer.start(inputSequence: stream)

        let channel = self.channel
        resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if text.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                    Emit.send([
                        "event": "transcript",
                        "channel": channel,
                        "text": text,
                        "isFinal": result.isFinal,
                        "start": result.range.start.seconds.isFinite ? result.range.start.seconds : 0,
                        "end": result.range.end.seconds.isFinite ? result.range.end.seconds : 0,
                    ])
                }
            } catch {
                Emit.error("\(channel) transcriber: \(error.localizedDescription)")
            }
        }
    }

    // called from realtime audio threads; hop to a serial queue before converting
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.deepCopy() else { return }
        queue.async { [weak self] in self?.convertAndYield(copy) }
    }

    private func convertAndYield(_ buffer: AVAudioPCMBuffer) {
        guard let fmt = format, streaming || continuation != nil else { return }
        if converter == nil || converter!.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: fmt)
        }
        guard let converter else { return }
        let ratio = fmt.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity) else { return }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let err { Emit.error("\(channel) convert: \(err.localizedDescription)"); return }
        deliver(out)
    }

    // the sample rate converter holds back a tail of input until it sees end of stream; one last convert call returns it
    private func drain() {
        guard let converter, let fmt = format else { return }
        self.converter = nil
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 8192) else { return }
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        if let err { Emit.error("\(channel) drain: \(err.localizedDescription)"); return }
        deliver(out)
    }

    private func deliver(_ out: AVAudioPCMBuffer) {
        guard out.frameLength > 0 else { return }
        try? file?.write(from: out)
        if streaming {
            guard let samples = out.int16ChannelData else { return }
            let data = Data(bytes: samples[0], count: Int(out.frameLength) * 2)
            Emit.send(["event": "pcm", "channel": channel, "data": data.base64EncodedString()])
            return
        }
        continuation?.yield(AnalyzerInput(buffer: out))
    }

    func stop() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async { [weak self] in self?.drain(); c.resume() }
        }
        streaming = false
        continuation?.finish()
        continuation = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        file = nil
        analyzer = nil
    }
}

extension AVAudioPCMBuffer {
    func deepCopy() -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
        copy.frameLength = frameLength
        let src = UnsafeMutableAudioBufferListPointer(mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (s, d) in zip(src, dst) {
            guard let sp = s.mData, let dp = d.mData else { continue }
            memcpy(dp, sp, Int(min(s.mDataByteSize, d.mDataByteSize)))
        }
        return copy
    }
}
