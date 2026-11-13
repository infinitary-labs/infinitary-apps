import XCTest

/// The card-questions part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// The desktop's question stepper on the phone (docs/keyboard.md, "Moving between a card's questions"), built from the
    /// captain's ask for "a quick way for people to jump between decisions" on a decision card, with keys to "switch
    /// between decisions, and change their options all using keyboards smoothly". Data: the phone home's `question-card`,
    /// a decision asking three questions, each after a section of reading, so the last starts below the card's room.
    /// Completion: the footer's count reads 0 of 3 picked between a previous and a next arrow; the previous arrow from no
    /// question goes round to the last question and brings it into the card's view, the next arrow from there goes round
    /// to the first; once the first is answered a tap on the count brings the next unanswered question, the second; from
    /// a keyboard ⌘J goes on to the third with its focus, so the number key 1 picks its first option, and ⇧⌘J twice goes
    /// back to the first. It fails when a step leaves its question outside the card's view or a key leaves focus behind.
    func testCardQuestionSteps() async throws {
        try await launchJoined()
        let fixture = try await home("question-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let questions = try XCTUnwrap(fixture["questions"] as? [String])
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        let count = app.buttons["card-answers"]
        let previous = app.buttons["card-question-previous"]
        let next = app.buttons["card-question-next"]
        XCTAssertTrue(count.waitForPresence(timeout: 20), app.debugDescription)
        waitForCount("0 of 3 picked")
        XCTAssertTrue(previous.exists && next.exists, app.debugDescription)
        let legends = questions.map { app.webViews.staticTexts[$0].firstMatch }
        XCTAssertTrue(legends[2].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(inCardView(legends[2]), "The last question already showed, so no step could prove it moved")
        picture("card-questions-footer")
        tapOnPhone(previous)
        waitInView(legends[2], "the previous arrow from no question")
        try await appearances("card-questions-stepped", showing: previous)
        tapOnPhone(next)
        waitInView(legends[0], "the next arrow from the last question")
        // WebKit offers the radio only through its label's words, so a tap on them picks it.
        let tuesday = app.webViews.staticTexts["Tuesday"].firstMatch
        XCTAssertTrue(tuesday.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(tuesday)
        waitForCount("1 of 3 picked")
        tapOnPhone(count)
        waitInView(legends[1], "the count after the first question was answered")
        try await pressPhoneKey("j", modifiers: .command, in: app)
        waitInView(legends[2], "⌘J from the second question")
        // The number keys are the body page's own, not the app's key commands, so backboardd records no registration
        // for pressPhoneKey to wait on: the key goes once, and the count is what shows the page took it.
        app.typeKey("1", modifierFlags: [])
        waitForCount("2 of 3 picked")
        try await pressPhoneKey("j", modifiers: [.command, .shift], in: app)
        try await pressPhoneKey("j", modifiers: [.command, .shift], in: app)
        waitInView(legends[0], "⇧⌘J twice from the third question")
    }

    /// The count's picked part; a pick that differs from what the card proposed adds a changed part after it.
    private func waitForCount(_ words: String) {
        let count = app.buttons["card-answers"]
        let read = NSPredicate { _, _ in count.exists && (count.label == words || count.label.hasPrefix(words + " · ")) }
        XCTAssertEqual(waitForPhonePredicate(read, object: nil, timeout: 10), .completed,
                       "The count never read \(words): \(count.exists ? count.label : "missing")")
    }

    /// Wholly inside the card's scroller, which the pinned choices sit under.
    private func inCardView(_ element: XCUIElement) -> Bool {
        let scroll = app.scrollViews["card-scroll"].firstMatch
        return element.exists && scroll.exists && scroll.frame.insetBy(dx: -1, dy: -1).contains(element.frame)
    }

    private func waitInView(_ element: XCUIElement, _ step: String) {
        let shown = NSPredicate { [self] _, _ in inCardView(element) }
        XCTAssertEqual(waitForPhonePredicate(shown, object: nil, timeout: 10), .completed,
                       "After \(step), \(element.label) lay outside the card's view: \(element.frame) in \(app.scrollViews["card-scroll"].firstMatch.frame), its body at \(app.webViews["card-body"].firstMatch.frame)")
    }
}
