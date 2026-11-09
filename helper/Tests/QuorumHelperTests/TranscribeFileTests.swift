import Foundation
import XCTest
@testable import QuorumHelper

final class TranscribeFileTests: XCTestCase {
    static let voice = "Samantha"
    static let script = "Morning Thandiwe, thanks for making time. I want to lock the Brightline Robotics renewal before the fourteenth, and keep the Fieldmap add-on."

    private func shell(_ tool: String, _ args: [String]) throws -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/\(tool)")
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    // the eval harness path: say -> afconvert -> QuorumHelper transcribe-file me.wav --terms ..., finals read off stdout
    func testSynthesizedSpeechYieldsFinals() async throws {
        _ = try await requireSpeech()
        let (_, voices) = try shell("say", ["-v", "?"])
        guard voices.contains("\(Self.voice) ") else { throw XCTSkip("voice \(Self.voice) not installed") }
        let dir = try tempDir("transcribe")
        defer { try? FileManager.default.removeItem(at: dir) }
        let aiff = dir.appendingPathComponent("me.aiff"), wav = dir.appendingPathComponent("me.wav")
        let (sayStatus, sayOut) = try shell("say", ["-v", Self.voice, "-o", aiff.path, Self.script])
        XCTAssertEqual(sayStatus, 0, sayOut)
        let (convStatus, convOut) = try shell("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff.path, wav.path])
        XCTAssertEqual(convStatus, 0, convOut)

        let run = try Helper.run(["transcribe-file", wav.path, "--terms", "Thandiwe", "Brightline", "Fieldmap"])
        XCTAssertEqual(run.status, 0, run.stderr)
        XCTAssertFalse(run.stderr.contains("vocabulary not applied"), run.stderr)
        let events = run.events
        XCTAssertEqual(events.count, run.stdout.split(separator: "\n").count, "every line is a JSON object")
        XCTAssertEqual(events.last?["event"] as? String, "stopped")
        XCTAssertNil(events.first { $0["event"] as? String == "error" })
        let finals = events.filter { $0["event"] as? String == "transcript" && $0["isFinal"] as? Bool == true }
        XCTAssertGreaterThanOrEqual(finals.count, 1, run.stdout)
        var lastStart = -1.0
        for f in finals {
            XCTAssertEqual(Set(f.keys), ["event", "channel", "text", "isFinal", "start", "end"])
            XCTAssertEqual(f["channel"] as? String, "me")
            let text = try XCTUnwrap(f["text"] as? String)
            XCTAssertFalse(text.trimmingCharacters(in: .whitespaces).isEmpty)
            let start = try XCTUnwrap(f["start"] as? Double), end = try XCTUnwrap(f["end"] as? Double)
            XCTAssertGreaterThan(start, lastStart, "finals arrive in time order")
            XCTAssertLessThan(start, end)
            lastStart = start
        }
        let words = finals.compactMap { $0["text"] as? String }.joined(separator: " ").lowercased()
        XCTAssertTrue(words.contains("renewal"), words)
    }
}
