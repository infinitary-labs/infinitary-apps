import XCTest

/// The cards-reader part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-6388, the approved plan's piece 1: a card from an unsafe data reader, a crewmate that reads words anyone can
    /// write, says so under its title on the phone as on the Mac. Data: one decision from a reader task. Completion: the
    /// card shows the unsafe data line in the app's words, photographed in both appearances.
    func testReaderCardUnsafeLine() async throws {
        try await launchJoined()
        let fixture = try await home("reader-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let words = try XCTUnwrap(fixture["line"] as? String)
        showCard(title)
        waitForShownBodyRevealed()
        let line = app.staticTexts["card-unsafe-data"]
        XCTAssertTrue(line.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(line.label, words)
        try await appearances("reader-card", showing: line)
    }
}
