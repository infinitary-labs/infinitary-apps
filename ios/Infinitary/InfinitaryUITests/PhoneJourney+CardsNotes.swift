import XCTest

/// The cards-notes part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3296, the captain: "something closer to lavish-axi where a small popover shows when i annotate something. i can
    /// then either queue it as-is, or add a comment along with it. then i can queue multiple things before a final send",
    /// and "when i only annotated a range of text, it should be only the range of text that gets highlighted", built for
    /// the phone. INF-3746, the captain: "the annotation related UI on the ios app is ugly.. all kinds of overflow and not
    /// appearing cohesive", built as direction B, and "pay attention to keeping the focused text input in viewport not
    /// scrolled away". INF-4353, the captain: "this annotate button doesn't work at all.. bug?", on a card the pager moved
    /// to. The captain: "after the "point at" annotation selects an element, we should deactivate annotation, not leaving
    /// it still activated". Data: a first mate card whose body holds two paragraphs and a list, behind a card shown ahead
    /// of it. Completion: the pager moves to the notes card, whose body drew beside the shown card, and words long-pressed
    /// there open the note editor from the selection's Annotate with nothing touched before;
    /// Point at, then a tap on the first paragraph, opens the note editor under it inside the card, whose
    /// comment stays in view above the keyboard and queues one note, and Point at is off once it picked; words
    /// long-pressed in the second paragraph open it again from the selection's Annotate, and it queues as-is; on an
    /// iPhone on its side the editor's comment stays in view too; the field counts two notes not sent; one send gives
    /// the computer one captain line holding a paragraph note with its comment and a text note with its range; and a
    /// press on a sent note turns the card to its face with nothing reported stale.
    func testCardNotes() async throws {
        app.launchEnvironment["INFINITARY_TEST_CARD_ROW_PROBE"] = "1"
        try await launchJoined()
        let fixture = try await home("note-card")
        let lead = try XCTUnwrap(fixture["lead"] as? String)
        let title = try XCTUnwrap(fixture["title"] as? String)
        let part = try XCTUnwrap(fixture["part"] as? String)
        let words = try XCTUnwrap(fixture["words"] as? String)
        let editor = app.descendants(matching: .any).matching(identifier: "note-editor").firstMatch
        verifyAnnotateAfterPaging(from: lead, to: title, words: words, editor: editor)
        let first = app.webViews.staticTexts[part].firstMatch
        XCTAssertTrue(first.waitForPresence(timeout: 20), app.debugDescription)
        // Point at, then a tap on a whole part: the note editor opens under it with its comment ready.
        let point = app.buttons["point-at"]
        XCTAssertTrue(point.waitForPresence(timeout: 10), app.debugDescription)
        reveal(point); tapOnPhone(point)
        picture("0-point-at-on")
        reveal(first); tapOnPhone(first)
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
        focusForPhoneTyping(comment, in: app, overWebContent: true)
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
        // Point at turned itself off once it picked the part, and the note it made waits.
        XCTAssertFalse(point.isSelected, "Point at stayed on after its pick\n\(app.debugDescription)")
        picture("1a-point-at-off-after-its-pick")
        // Words selected in the second paragraph: the selection's own menu offers Annotate, which opens the popover.
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
            focusForPhoneTyping(comment, in: app, overWebContent: true)
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

    /// INF-4353: the pager moves from the card shown first to the notes card, whose body drew beside it with no pane
    /// listening. Words long-pressed there, before Point at or any note, open the note editor from the selection's Annotate.
    private func verifyAnnotateAfterPaging(from lead: String, to title: String, words: String, editor: XCUIElement) {
        XCTAssertTrue(cardHeading(lead).waitForPresence(timeout: 10), "\(lead) is not the card shown first\n\(app.debugDescription)")
        waitForShownBodyRevealed()
        let probe = app.descendants(matching: .any).matching(identifier: "card-row-probe").firstMatch
        let beside = NSPredicate { _, _ in probe.exists && probe.label.hasPrefix("beside drawn") }
        XCTAssertEqual(waitForPhonePredicate(beside, object: nil, timeout: 30), .completed,
                       "The notes card's body never drew beside the shown card: \(probe.label)")
        tapOnPhone(app.buttons["next-card"])
        let titles = app.staticTexts.matching(identifier: "card-title")
        let settled = NSPredicate { _, _ in titles.count == 1 && titles.firstMatch.label == title }
        XCTAssertEqual(waitForPhonePredicate(settled, object: nil, timeout: 10), .completed,
                       "The pager never settled on \(title)\n\(app.debugDescription)")
        XCTAssertTrue(probe.label.contains("arrived drawn"), "\(title) arrived before its body drew: \(probe.label)")
        waitForShownBodyRevealed()
        let selected = app.webViews.staticTexts[words].firstMatch
        XCTAssertTrue(selected.waitForPresence(timeout: 20), app.debugDescription)
        reveal(selected)
        selected.press(forDuration: 1.2)
        XCTAssertTrue(openAnnotateFromSelection(), "The selection offers no Annotate\n\(app.debugDescription)")
        XCTAssertTrue(editor.waitForPresence(timeout: 10),
                      "Annotate on a card the pager moved to did not open the note editor\n\(app.debugDescription)")
        picture("0-annotate-after-paging")
        let cancel = app.buttons["note-cancel"]
        XCTAssertTrue(waitForPhonePress(cancel), app.debugDescription)
        tapOnPhone(cancel)
        XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
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
