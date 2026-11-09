import AVFAudio
import Speech
import XCTest
@testable import QuorumHelper

final class AudioConversionTests: XCTestCase {
    // a 48 kHz stereo tone through ChannelTranscriber's convert step: the .caf it writes has the analyzer's mono format
    // and exactly a third of the frames; stop() drains the tail the sample rate converter holds back (15 to 70 ms)
    func testStereo48kBecomesAnalyzerMono() async throws {
        let transcriber = try await requireSpeech()
        let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        let expected = try XCTUnwrap(best)
        XCTAssertEqual(expected.channelCount, 1)
        let dir = try tempDir("convert")
        defer { try? FileManager.default.removeItem(at: dir) }
        let caf = dir.appendingPathComponent("me.caf")
        let silent = Pipe()
        Emit.output = silent.fileHandleForWriting
        defer { Emit.output = FileHandle.standardOutput }

        let channel = ChannelTranscriber(channel: "me")
        try await channel.start(locale: Locale(identifier: "en-US"), audioURL: caf)
        let input = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2))
        let perBuffer: AVAudioFrameCount = 4800
        let buffers = 30
        for i in 0..<buffers {
            let buf = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: input, frameCapacity: perBuffer))
            buf.frameLength = perBuffer
            for ch in 0..<2 {
                let p = buf.floatChannelData![ch]
                for n in 0..<Int(perBuffer) { p[n] = sinf(Float(i * Int(perBuffer) + n) * 440 * 2 * .pi / 48000) * 0.3 }
            }
            channel.feed(buf)
        }
        await channel.stop()

        let file = try AVAudioFile(forReading: caf)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        XCTAssertEqual(file.fileFormat.sampleRate, expected.sampleRate)
        XCTAssertEqual(file.processingFormat.channelCount, 1)
        let wanted = Double(perBuffer) * Double(buffers) * expected.sampleRate / 48000
        XCTAssertEqual(Double(file.length), wanted, "the converter tail did not reach the file at stop")
    }
}
