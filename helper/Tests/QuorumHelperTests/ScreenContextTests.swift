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
}
