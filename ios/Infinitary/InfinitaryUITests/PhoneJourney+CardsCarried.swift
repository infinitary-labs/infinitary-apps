import XCTest

/// The cards-carried part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-5608, the captain: "right now, in a card thread, attachments and queued annotations cannot be sent along with
    /// an action button click. it seems they can only be sent as a pure reply. can we allow sending these queued stuff
    /// along with an action button click?", its approved plan's piece 2 for the phone, and INF-5487: a choice on the
    /// phone dropped the photos and notes in its field. Data: a first mate card on the disposable test home with a
    /// paragraph and two choices, a note queued on that paragraph with a comment, and a library photo. Completion: the
    /// footer names what goes with the choice, one tap on a choice takes the card away, the first mate's turn reads the
    /// choice with the note's comment and the photo's attached line and carries the photo as an image, the card's record
    /// keeps the note and the photo by name, and the card opened again as a past card names both above its buttons. A
    /// computer whose welcome leaves `choice-attachments` out holds every choice while a photo waits, with the Mac's words.
    func testCardChoiceCarries() async throws {
        try await launchJoined()
        let fixture = try await home("carried-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let part = try XCTUnwrap(fixture["part"] as? String)
        showCard(title)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        // A note on the paragraph, with a comment.
        let paragraph = app.webViews.staticTexts[part].firstMatch
        XCTAssertTrue(paragraph.waitForPresence(timeout: 20), app.debugDescription)
        let point = app.buttons["point-at"]
        XCTAssertTrue(point.waitForPresence(timeout: 10), app.debugDescription)
        reveal(point); tapOnPhone(point)
        reveal(paragraph); tapOnPhone(paragraph)
        let editor = app.descendants(matching: .any).matching(identifier: "note-editor").firstMatch
        XCTAssertTrue(editor.waitForPresence(timeout: 10), "Point at did not open the note editor\n\(app.debugDescription)")
        let comment = keyboardInput("note-comment")
        XCTAssertTrue(comment.waitForPresence(timeout: 10), app.debugDescription)
        focusForPhoneTyping(comment, in: app, overWebContent: true)
        let said = "Check the buoy against the survey first."
        comment.typeText(said)
        tapOnPhone(app.buttons["note-queue"])
        XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["queued-notes-count"].waitForPresence(timeout: 10), app.debugDescription)
        // The keyboard may close with the editor or stay up with its Done button; put it down only when it stayed. As it
        // starts to close, Done can still read for a moment, so the state settles only when two readings in a row agree.
        let keyboard = app.keyboards.firstMatch
        let done = app.navigationBars.buttons["dismiss-phone-keyboard"]
        var lastReading: [Bool]?
        let settled = NSPredicate { _, _ in
            let up = keyboard.exists
            let reading = [up, up && done.exists && done.isHittable]
            defer { lastReading = reading }
            return (!reading[0] || reading[1]) && lastReading == reading
        }
        XCTAssertEqual(waitForPhonePredicate(settled, object: nil, timeout: 10), .completed, app.debugDescription)
        if keyboard.exists { tapOnPhone(done) }
        XCTAssertTrue(keyboard.waitForAbsence(timeout: 10), app.debugDescription)
        // A library photo in the card's field.
        addPhoneCardPhoto(app: app)
        // The footer names what goes with whichever choice is pressed, in the Mac's words, and the choices stay lit.
        let line = app.staticTexts["carried-line"]
        XCTAssertTrue(line.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(line.label, try XCTUnwrap(fixture["line"] as? String))
        XCTAssertFalse(app.staticTexts["carried-hold"].exists, app.debugDescription)
        let hold = app.buttons["card-action-hold"]
        reveal(hold)
        waitUntilEnabled(hold)
        try await appearances("0-photo-and-note-go-with-the-choice", showing: line)
        tapOnPhone(hold)
        XCTAssertTrue(cardHeading(title).waitForAbsence(timeout: 10), app.debugDescription)
        // The first mate's turn read the choice with the note and the photo; the record kept both with the choice.
        let heard = try await home("carried-heard")
        XCTAssertEqual(heard["chosen"] as? String, "hold")
        let turn = try XCTUnwrap(heard["turn"] as? String, "No first mate turn read the choice: \(heard)")
        XCTAssertTrue(turn.contains(said), "The turn does not read the note's comment: \(turn)")
        XCTAssertTrue(turn.contains("[attached: 1 picture"), "The turn does not name the photo: \(turn)")
        XCTAssertEqual(heard["turnImage"] as? Bool, true, "The photo did not ride the turn as an image")
        let carried = try XCTUnwrap(heard["carried"] as? [String: Any], "The card kept nothing with the choice: \(heard)")
        let notes = try XCTUnwrap(carried["notes"] as? [[String: Any]])
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes.first?["comment"] as? String, said)
        XCTAssertEqual((carried["pictures"] as? [String])?.count, 1)
        // The card opened again as a past card names the note and the photo above its buttons.
        _ = try await home("carried-past")
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        let lead = app.staticTexts["past-sent-words"]
        XCTAssertTrue(lead.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(lead.label, try XCTUnwrap(fixture["sentLead"] as? String))
        let pictures = app.staticTexts["past-sent-pictures"]
        reveal(pictures)
        XCTAssertEqual(pictures.label, try XCTUnwrap(heard["pictureWords"] as? String))
        // The sent notes' own identifier may cover the note's button it draws, so either names the note.
        let sentNote = app.buttons.matching(NSPredicate(format: "identifier IN %@", ["past-sent-notes", "thread-note"])).firstMatch
        XCTAssertTrue(sentNote.waitForPresence(timeout: 10), "The past card does not name the note\n\(app.debugDescription)")
        XCTAssertTrue(sentNote.label.contains(part), "The past card's note does not name its paragraph: \(sentNote.label)")
        XCTAssertTrue(app.staticTexts[said].exists, "The past card does not show the note's comment\n\(app.debugDescription)")
        XCTAssertEqual(app.buttons["card-action-hold"].value as? String, "Chosen")
        // The past card's body draws its paragraph before the picture.
        XCTAssertTrue(app.webViews.staticTexts[part].firstMatch.waitForPresence(timeout: 20), app.debugDescription)
        picture("1-past-card-names-what-went")
        reveal(app.buttons["put-aside-card"]); tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(cardHeading(title).waitForAbsence(timeout: 10), app.debugDescription)

        // A computer without the change: a photo in the field holds the choices, with the Mac's words, so nothing is lost.
        _ = try await home("carried-older-home")
        reach("Live", timeout: 30)
        let older = try await home("carried-card", body: #"{"id":"phone-carried-older"}"#)
        // The stage was empty after the past card went aside, so the new card reaches it before it can be shown.
        XCTAssertTrue(app.staticTexts["card-title"].waitForPresence(timeout: 20), app.debugDescription)
        showCard(title)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        addPhoneCardPhoto(app: app)
        let held = app.staticTexts["carried-hold"]
        XCTAssertTrue(held.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(held.label, try XCTUnwrap(older["held"] as? String))
        XCTAssertFalse(app.staticTexts["carried-line"].exists, app.debugDescription)
        let waiting = app.buttons["card-action-hold"]
        reveal(waiting)
        XCTAssertFalse(waiting.isEnabled, "A choice on a computer without the change waits while a photo does")
        XCTAssertFalse(app.buttons["card-action-print"].isEnabled, "Every choice waits while a photo does")
        picture("2-older-computer-holds-the-choices")
    }
}
