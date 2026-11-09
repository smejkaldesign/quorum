import Foundation
import XCTest
@testable import QuorumHelper

final class CLITests: XCTestCase {
    func testTranscribeJobTwoFilesAndTerms() throws {
        let job = try XCTUnwrap(CLI.transcribeJob(["helper", "transcribe-file", "/a/me.wav", "/a/them.wav", "--terms", "Brightline", "Fieldmap"]))
        XCTAssertEqual(job.me.path, "/a/me.wav")
        XCTAssertEqual(job.them?.path, "/a/them.wav")
        XCTAssertEqual(job.terms, ["Brightline", "Fieldmap"])
    }

    func testTranscribeJobOneFile() throws {
        let job = try XCTUnwrap(CLI.transcribeJob(["helper", "transcribe-file", "me.wav"]))
        XCTAssertEqual(job.me.lastPathComponent, "me.wav")
        XCTAssertNil(job.them)
        XCTAssertEqual(job.terms, [])
    }

    func testTranscribeJobTermsWithoutFiles() {
        XCTAssertNil(CLI.transcribeJob(["helper", "transcribe-file"]))
        XCTAssertNil(CLI.transcribeJob(["helper", "transcribe-file", "--terms", "x"]))
        XCTAssertEqual(CLI.transcribeJob(["helper", "transcribe-file", "me.wav", "--terms"])?.terms, [])
    }

    func testCaptureSeconds() {
        XCTAssertEqual(CLI.captureSeconds(["helper", "test-capture"]), 10)
        XCTAssertEqual(CLI.captureSeconds(["helper", "test-capture", "3.5"]), 3.5)
        XCTAssertEqual(CLI.captureSeconds(["helper", "test-capture", "soon"]), 10)
    }

    func testUnknownCommandExits2WithUsage() throws {
        let run = try Helper.run(["no-such-command"], timeout: 30)
        XCTAssertEqual(run.status, 2)
        XCTAssertTrue(run.stderr.hasPrefix("usage: quorum-helper ["), run.stderr)
        XCTAssertTrue(run.stderr.contains("transcribe-file"))
        XCTAssertEqual(run.stdout, "", "nothing on the protocol channel")
    }

    func testTranscribeFileWithoutPathExits2WithUsage() throws {
        for args in [["transcribe-file"], ["transcribe-file", "--terms", "x"]] {
            let run = try Helper.run(args, timeout: 30)
            XCTAssertEqual(run.status, 2, args.joined(separator: " "))
            XCTAssertTrue(run.stderr.hasPrefix("usage: quorum-helper transcribe-file <me.wav>"), run.stderr)
        }
    }

    // the stdin protocol: ready first, then one JSON object per line, axStatus answered without any capture
    func testProtocolRoundTrip() throws {
        let run = try Helper.run([], stdin: "{\"cmd\":\"axStatus\",\"prompt\":false}\n{\"cmd\":\"quit\"}\n", timeout: 30)
        XCTAssertEqual(run.status, 0, run.stderr)
        let events = run.events
        XCTAssertEqual(events.count, run.stdout.split(separator: "\n").count, "every line is a JSON object")
        XCTAssertEqual(events.first?["event"] as? String, "ready")
        let route = try XCTUnwrap(events.first { $0["event"] as? String == "audioRoute" })
        XCTAssertEqual(Set(route.keys), ["event", "route", "transport", "name"])
        let ax = try XCTUnwrap(events.first { $0["event"] as? String == "axStatus" })
        XCTAssertEqual(Set(ax.keys), ["event", "trusted", "zoomRunning", "providers"])
        XCTAssertNotNil(ax["trusted"] as? Bool)
        XCTAssertNotNil(ax["zoomRunning"] as? Bool)
        let providers = try XCTUnwrap(ax["providers"] as? [String: Bool])
        XCTAssertEqual(Set(providers.keys), ["zoom", "meet", "teams"])
    }
}
