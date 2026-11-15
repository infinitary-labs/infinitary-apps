import XCTest

/// The cards-notes part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3296, the captain: "something closer to lavish-axi where a small popover shows when i annotate something. i can
    /// then either queue it as-is, or add a comment along with it. then i can queue multiple things before a final send",
    /// and "when i only annotated a range of text, it should be only the range of text that gets highlighted", built for
    /// the phone. INF-3746, the captain: "the annotation related UI on the ios app is ugly.. all kinds of overflow and not
    /// appearing cohesive", built as direction B, and "pay attention to keeping the focused text input in viewport not
    /// scrolled away". Data: a first mate card whose body holds two paragraphs and a list.
    /// Completion: Point at, then a tap on the first paragraph, opens the note editor under it inside the card, whose
    /// comment stays in view above the keyboard and queues one note; words long-pressed in the second paragraph open it
    /// again from the selection's Annotate, and it queues as-is; on an iPhone on its side the editor's comment stays in
    /// view too; the field counts two notes not sent; one send gives the computer one captain line holding a paragraph
    /// note with its comment and a text note with its range; and a press on a sent note turns the card to its face with
    /// nothing reported stale.
    func testCardNotes() async throws {
        try await launchJoined()
        let fixture = try await home("note-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let part = try XCTUnwrap(fixture["part"] as? String)
        let words = try XCTUnwrap(fixture["words"] as? String)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        let first = app.webViews.staticTexts[part].firstMatch
        XCTAssertTrue(first.waitForPresence(timeout: 20), app.debugDescription)
        // Point at, then a tap on a whole part: the note editor opens under it with its comment ready.
        let point = app.buttons["point-at"]
        XCTAssertTrue(point.waitForPresence(timeout: 10), app.debugDescription)
        reveal(point); tapOnPhone(point)
        picture("0-point-at-on")
        reveal(first); tapOnPhone(first)
        let editor = app.descendants(matching: .any).matching(identifier: "note-editor").firstMatch
        XCTAssertTrue(editor.waitForPresence(timeout: 10), "Point at did not open the note editor\n\(app.debugDescription)")
        let comment = keyboardInput("note-comment")
        XCTAssertTrue(comment.waitForPresence(timeout: 10), app.debugDescription)
        let excerpt = app.staticTexts["note-excerpt"]
        XCTAssertTrue(excerpt.label.hasPrefix("The release window"), "The editor names \(excerpt.label)\n\(app.debugDescription)")
        // The editor is drawn inside the card, under the part it notes, and no popover floats over the card.
        waitForSteadyTarget(editor)
        let card = [app.descendants(matching: .any).matching(identifier: "card-frame").firstMatch, app.scrollViews["card-scroll"].firstMatch]
            .first { $0.exists }
        let cardFrame = try XCTUnwrap(card, app.debugDescription).frame
        XCTAssertTrue(cardFrame.insetBy(dx: -0.5, dy: 0).minX <= editor.frame.minX && editor.frame.maxX <= cardFrame.maxX + 0.5,
                      "The editor \(editor.frame) runs past the card \(cardFrame)")
        XCTAssertGreaterThanOrEqual(editor.frame.minY, first.frame.maxY - 0.5, "The editor \(editor.frame) covers its part \(first.frame)")
        XCTAssertFalse(app.popovers.firstMatch.exists, app.debugDescription)
        focusForPhoneTyping(comment, in: app)
        var failures: [String] = []
        keyboardViewportProbe("note comment under its part", comment, into: &failures)
        let said = "Say which check this waits for."
        comment.typeText(said)
        picture("1-editor-with-a-comment")
        tapOnPhone(app.buttons["note-queue"])
        XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
        let count = app.staticTexts["queued-notes-count"]
        XCTAssertTrue(count.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(count.label, "1 note not sent")
        // Words selected in the second paragraph: the selection's own menu offers Annotate, which opens the popover.
        if point.isSelected { tapOnPhone(point) }
        let second = app.webViews.staticTexts[words].firstMatch
        XCTAssertTrue(second.waitForPresence(timeout: 10), app.debugDescription)
        reveal(second)
        second.press(forDuration: 1.2)
        XCTAssertTrue(openAnnotateFromSelection(), "The selection offers no Annotate\n\(app.debugDescription)")
        XCTAssertTrue(editor.waitForPresence(timeout: 10), "Annotate did not open the note editor\n\(app.debugDescription)")
        picture("2-editor-on-selected-words")
        tapOnPhone(app.buttons["note-queue"])
        XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
        let two = NSPredicate { _, _ in count.exists && count.label == "2 notes not sent" }
        XCTAssertEqual(waitForPhonePredicate(two, object: nil, timeout: 10), .completed, app.debugDescription)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "queued-note").count, 2)
        // On an iPhone on its side the editor takes the card's foot, and its comment stays in view above the keyboard.
        if phoneTurnedLayout(app) == .onItsSide {
            turnForProbe(.landscapeLeft)
            XCTAssertEqual(phoneShownLayout(app), .onItsSide, "Turned, the app shows the layout read before the turn")
            reveal(point); tapOnPhone(point)
            reveal(first); tapOnPhone(first)
            XCTAssertTrue(editor.waitForPresence(timeout: 10), "Point at did not open the note editor on its side\n\(app.debugDescription)")
            focusForPhoneTyping(comment, in: app)
            keyboardViewportProbe("note comment, on its side", comment, into: &failures)
            // The whole editor fits the card's short foot, its excerpt and buttons included, with none of it cut off.
            waitForSteadyTarget(editor)
            // On its side the card may scroll instead of holding a fixed frame; whichever shows bounds what can be seen.
            let side = try XCTUnwrap([app.descendants(matching: .any).matching(identifier: "card-frame").firstMatch,
                                      app.scrollViews["card-scroll"].firstMatch].first { $0.exists }, app.debugDescription)
            XCTAssertTrue(side.frame.insetBy(dx: -0.5, dy: -0.5).contains(editor.frame),
                          "The editor \(editor.frame) runs past the card \(side.frame) on its side")
            XCTAssertTrue(excerpt.exists, app.debugDescription)
            try await dismissKeyboardForProbe()
            let cancel = app.buttons["note-cancel"]
            XCTAssertTrue(waitForPhonePress(cancel), app.debugDescription)
            tapOnPhone(cancel)
            XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
            turnForProbe(.portrait)
        }
        finishKeyboardChecks(failures)
        let send = app.buttons["send-reply"]
        reveal(send)
        // The queued notes in both themes, for the release note's hero pair.
        try await appearances("3-two-notes-queued", showing: count)
        tapOnPhone(send)
        // On the card's back the sent line names each note. The back draws the thread the computer pushed, so once both
        // show the computer's own line is read once: the part with its comment, the words with their range.
        let sent = app.buttons.matching(identifier: "thread-note")
        let ready = NSPredicate { _, _ in sent.count == 2 }
        XCTAssertEqual(waitForPhonePredicate(ready, object: nil, timeout: 20), .completed, app.debugDescription)
        XCTAssertFalse(count.exists, "The sent notes still show as not sent\n\(app.debugDescription)")
        picture("4-notes-in-the-thread")
        let thread = try await home("note-thread", method: "GET")
        let lines = try XCTUnwrap(thread["messages"] as? [[String: Any]])
        let notes = try XCTUnwrap(lines.last { ($0["who"] as? String) == "captain" }?["notes"] as? [[String: Any]])
        XCTAssertEqual(notes.count, 2, "The reply did not carry both notes: \(notes)")
        let whole = notes.first { $0["span"] == nil }
        let ranged = notes.first { $0["span"] != nil }
        XCTAssertEqual(whole?["comment"] as? String, said)
        XCTAssertEqual(whole?["kind"] as? String, "paragraph")
        XCTAssertEqual(ranged?["comment"] as? String, "")
        let excerptWords = try XCTUnwrap(ranged?["excerpt"] as? String)
        XCTAssertFalse(excerptWords.isEmpty)
        XCTAssertTrue(words.contains(excerptWords), "The text note's words \(excerptWords) are not in the paragraph")
        // A press on a sent note turns the card to its face and lights the part.
        let back = app.descendants(matching: .any).matching(identifier: "card-back").firstMatch
        tapOnPhone(sent.element(boundBy: 0))
        XCTAssertTrue(back.waitForAbsence(timeout: 10), "The note did not turn the card to its face\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["thread-note-status"].exists, app.debugDescription)
        XCTAssertTrue(waitForPhonePress(first), "The noted paragraph is not in view\n\(app.debugDescription)")
        picture("5-note-revealed-on-the-face")
    }

    /// Chooses Annotate in the selection's menu, past its next-page arrow when the menu is narrower than its items.
    private func openAnnotateFromSelection() -> Bool {
        for _ in 0..<4 {
            for item in [app.menuItems["Annotate"], app.buttons["Annotate"]] where item.waitForPresence(timeout: 2) {
                tapOnPhone(item)
                return true
            }
            let more = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Show more items", "more"])).firstMatch
            guard more.exists else { return false }
            tapOnPhone(more)
        }
        return false
    }
}
