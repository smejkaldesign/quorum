import XCTest
@testable import QuorumHelper

final class ScreenContextTests: XCTestCase {
    func testExtractKeepsNamesProductWordsAndAcronymsOnly() {
        let text = """
        Q3 Roadmap Review
        Ada Lovelace joined the call. We discussed QuorumBrain and the Benefind app with Smejkal Design.
        The API returns JSON over HTTPS; see GPT5 notes. the end
        File Edit View
        """
        let terms = ScreenContext.extract(text)
        XCTAssertTrue(terms.contains("Ada Lovelace"))
        XCTAssertTrue(terms.contains("Ada"))
        XCTAssertTrue(terms.contains("QuorumBrain"))
        XCTAssertTrue(terms.contains("Benefind"))
        XCTAssertTrue(terms.contains("Smejkal Design"))
        XCTAssertTrue(terms.contains("API"))
        XCTAssertTrue(terms.contains("GPT5"))
        XCTAssertTrue(terms.contains("Q3"))
        XCTAssertFalse(terms.contains("The"))
        XCTAssertFalse(terms.contains("We"))
        XCTAssertFalse(terms.contains("File"))
        XCTAssertFalse(terms.contains("the"))
        XCTAssertFalse(terms.contains("discussed"))
        XCTAssertEqual(Set(terms.map { $0.lowercased() }).count, terms.count)
    }

    func testExtractCapsTheList() {
        let text = (1...400).map { "Name\($0) Word" }.joined(separator: "\n")
        XCTAssertLessThanOrEqual(ScreenContext.extract(text).count, 150)
    }

    private func win(_ id: CGWindowID, pid: Int32, bundle: String, layer: Int = 0, w: Double = 1200, h: Double = 800) -> ScreenContext.Candidate {
        ScreenContext.Candidate(id: id, pid: pid, bundle: bundle, layer: layer, width: w, height: h)
    }

    func testPickSkipsQuorumAndTakesTheNextWindowInOrder() {
        let wins = [win(1, pid: 10, bundle: "design.smejkal.quorum"), win(2, pid: 20, bundle: "com.github.Electron"), win(3, pid: 30, bundle: "com.figma.Desktop"), win(4, pid: 40, bundle: "com.apple.Safari")]
        XCTAssertEqual(ScreenContext.pick(wins, bundlePrefixes: [], excludePids: [20]), 3)
    }

    func testPickPrefersANamedAppAndSkipsMenusAndSmallWindows() {
        let wins = [win(1, pid: 30, bundle: "com.figma.Desktop", layer: 25), win(2, pid: 31, bundle: "com.apple.Notes", w: 200, h: 120), win(3, pid: 32, bundle: "com.apple.Safari"), win(4, pid: 33, bundle: "us.zoom.xos")]
        XCTAssertEqual(ScreenContext.pick(wins, bundlePrefixes: [], excludePids: []), 3)
        XCTAssertEqual(ScreenContext.pick(wins, bundlePrefixes: ["us.zoom"], excludePids: []), 4)
    }

    func testPickReturnsNothingWhenOnlyQuorumIsOnScreen() {
        let wins = [win(1, pid: 10, bundle: "design.smejkal.quorum"), win(2, pid: 20, bundle: "com.github.Electron")]
        XCTAssertNil(ScreenContext.pick(wins, bundlePrefixes: [], excludePids: [20]))
        XCTAssertNil(ScreenContext.pick([], bundlePrefixes: [], excludePids: []))
    }

    func testZoomTileNamesAndTheSpeakingState() {
        XCTAssertEqual(ZoomChat.tile("Ada Lovelace, Video on, Talking")?.name, "Ada Lovelace")
        XCTAssertEqual(ZoomChat.tile("Ada Lovelace, Video on, Talking")?.active, true)
        XCTAssertEqual(ZoomChat.tile("Grace Hopper, Muted")?.active, false)
        XCTAssertEqual(ZoomChat.tile("Sam")?.name, "Sam")
        XCTAssertNil(ZoomChat.tile(""))
    }
}
