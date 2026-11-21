import XCTest

/// The cards-reads part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-5531 piece 2, the captain: "plan how we allow the same access for cards. we should not invent a new interface,
    /// but through the same interface first mate, settings and custom panels already all use", and on closed cards: "Only
    /// while the card is open. Past cards keep what the author wrote, but a closed card stops updating."
    /// Data: the test home's real core (tests/helpers/phoneCardReads.ts) puts up crewmates' cards declaring the board and
    /// the record's tasks view; each card's own script reads the record's task count, the board, a read it did not declare
    /// and a view it did not declare, and the home adds tasks to the record. Completion: the card draws the record's count
    /// and a live board, refuses the undeclared read and view, and redraws when a task is added; a card ended while its body
    /// waits beside the shown one, and the shown card once ended, each hear why their count stopped and keep the count they
    /// drew while the record grows; and the first card, put away and brought back as a past card, shows its author's words
    /// with no live value.
    func testCardLiveReads() async throws {
        try await launchJoined()
        let fixture = try await home("live-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let first = try XCTUnwrap(fixture["count"] as? Int)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        // Only the shown card's body carries this name; a body waiting beside it is one closed element with none.
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        let line = { (words: String) in body.staticTexts[words].firstMatch }

        // The declared reads answer through the computer; the undeclared read and view are refused.
        XCTAssertTrue(line("count: \(first)").waitForPresence(timeout: 30), app.debugDescription)
        XCTAssertTrue(line("board: live").waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(line("undeclared: read_not_declared").waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(line("view: sql_view_not_declared").waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(line("stopped: open").exists, app.debugDescription)
        picture("0-live-card")

        // A task added on the computer redraws the count without the card being opened again.
        let addedFixture = try await home("live-card-add-task")
        let added = try XCTUnwrap(addedFixture["count"] as? Int)
        XCTAssertEqual(added, first + 1, "The home added one task")
        XCTAssertTrue(line("count: \(added)").waitForPresence(timeout: 30), app.debugDescription)
        picture("1-live-card-redrawn")

        // A second crewmate's live card draws its count, then waits beside the first card with its body kept loaded.
        let besideFixture = try await home("live-card-beside")
        let beside = try XCTUnwrap(besideFixture["title"] as? String)
        showCard(beside)
        waitForShownBodyRevealed()
        XCTAssertTrue(line("count: \(added)").waitForPresence(timeout: 30), app.debugDescription)
        XCTAssertTrue(line("stopped: open").exists, app.debugDescription)
        showCard(title)
        waitForShownBodyRevealed()
        // Its crewmate ends it there; the next task moves the shown card's count, so the computer's push reached the phone.
        _ = try await home("live-card-beside-end")
        let nextFixture = try await home("live-card-add-task")
        let next = try XCTUnwrap(nextFixture["count"] as? Int)
        XCTAssertEqual(next, added + 1, "The home added one task")
        XCTAssertTrue(line("count: \(next)").waitForPresence(timeout: 30), app.debugDescription)
        // Shown again, the ended neighbour heard why its count stopped and kept the count it drew before the task.
        showCard(beside)
        waitForShownBodyRevealed()
        XCTAssertTrue(line("stopped: read_not_declared").waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(line("count: \(added)").exists, app.debugDescription)
        XCTAssertFalse(line("count: \(next)").exists, "A card ended beside the shown one stops updating")
        picture("2-ended-beside-kept")
        showCard(title)
        waitForShownBodyRevealed()

        // Ended by its crewmate while shown, the card's count read ends and the body keeps what it drew.
        _ = try await home("live-card-end")
        XCTAssertTrue(line("stopped: read_not_declared").waitForPresence(timeout: 30), app.debugDescription)
        let laterFixture = try await home("live-card-add-task")
        let later = try XCTUnwrap(laterFixture["count"] as? Int)
        XCTAssertEqual(later, next + 1, "The home added one more task")
        // The board's push and the count's read ride the same computer pushes, so a phone that holds the new task on Tasks
        // would have moved a live count too.
        tab("Tasks", repeatDiscarded: false)
        XCTAssertTrue(app.staticTexts["Added task 3"].firstMatch.waitForPresence(timeout: 30), app.debugDescription)
        tab("Home", repeatDiscarded: false)
        showCard(title)
        waitForShownBodyRevealed()
        XCTAssertTrue(line("count: \(next)").waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(line("count: \(later)").exists, "An ended card stops updating")
        picture("3-ended-card-kept")

        // Put away and brought back as a past card, it shows its author's words: no read draws a value there.
        _ = try await home("live-card-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        // Its count read was refused at the start, which the script writes once the phone answered it.
        XCTAssertTrue(line("stopped: read_not_declared").waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(line("count: waiting").exists, app.debugDescription)
        XCTAssertTrue(line("board: waiting").exists, app.debugDescription)
        XCTAssertFalse(line("count: \(later)").exists, "A past card reads nothing live")
        picture("4-past-card-as-written")
    }
}
