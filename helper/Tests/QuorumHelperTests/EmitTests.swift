import Foundation
import XCTest
@testable import QuorumHelper

final class EmitTests: XCTestCase {
    private var captured: Pipe!

    override func setUp() {
        captured = Pipe()
        Emit.output = captured.fileHandleForWriting
    }

    override func tearDown() {
        Emit.output = FileHandle.standardOutput
    }

    private func lines() throws -> [String] {
        try captured.fileHandleForWriting.close()
        let data = captured.fileHandleForReading.readDataToEndOfFile()
        return String(decoding: data, as: UTF8.self).components(separatedBy: "\n")
    }

    func testOneObjectPerLine() throws {
        Emit.send(["event": "transcript", "channel": "me", "text": "line one\nline two /slash/", "isFinal": true, "start": 0.5, "end": 2.25])
        Emit.status("capturing", ["extra": 1])
        Emit.error("boom")
        let out = try lines()
        XCTAssertEqual(out.count, 4, "three events then a trailing newline")
        XCTAssertEqual(out.last, "")
        let objs = try out.dropLast().map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        XCTAssertEqual(objs.map { $0["event"] as? String }, ["transcript", "status", "error"])
        XCTAssertEqual(Set(objs[0].keys), ["event", "channel", "text", "isFinal", "start", "end"])
        XCTAssertEqual(objs[0]["text"] as? String, "line one\nline two /slash/")
        XCTAssertTrue(out[0].contains("/slash/"), "slashes stay unescaped")
        XCTAssertEqual(objs[1]["message"] as? String, "capturing")
        XCTAssertEqual(objs[1]["extra"] as? Int, 1)
        XCTAssertEqual(objs[2]["message"] as? String, "boom")
    }

    func testAudioRouteEventKeys() throws {
        Emit.send(AudioRoute.current())
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try lines()[0].utf8)) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["event", "route", "transport", "name"])
        XCTAssertEqual(obj["event"] as? String, "audioRoute")
        XCTAssertTrue(["speakers", "headphones", "external", "unknown"].contains(obj["route"] as? String ?? ""))
    }
}
