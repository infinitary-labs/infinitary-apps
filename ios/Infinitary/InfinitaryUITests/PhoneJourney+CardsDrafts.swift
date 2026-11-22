import XCTest

/// The cards-drafts part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-5445 piece 2: the phone reads and writes the same card drafts as every other screen (docs/ios.md, "Unsent
    /// picks on the phone"), and the captain: "make sure the words are not literally resending on every keystroke".
    /// Data: the phone home's `draft-card`, a decision with two required questions, on the test home's real core, whose
    /// `draft-elsewhere` changes the card's draft as a window on a Mac would. Completion: a pick on the phone reaches the
    /// computer's draft; words typed key by key reach it in at most two changes; a note queued on the phone reaches it;
    /// another screen's pick shows in the body, its words in the card's field and its comment on the note, and all three
    /// show again after the app starts again; a pick made out of reach reaches the draft once the computer is back; and the
    /// captain's choice takes the draft away. It fails when the phone keeps a draft to itself, sends one change a key,
    /// keeps its notes to itself, forgets a draft at a restart, or drops a pick made out of reach.
    func testCardDrafts() async throws {
        try await launchJoined()
        let fixture = try await home("draft-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let part = try XCTUnwrap(fixture["part"] as? String)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        waitForDraftCount("2 to answer")

        let tuesday = app.webViews.staticTexts["Tuesday"].firstMatch
        XCTAssertTrue(tuesday.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(tuesday)
        waitForDraftCount("1 to answer")
        let picked = try await waitForDraft(["answers": ["day": ["tuesday"]]])
        let before = try XCTUnwrap((picked["draft"] as? [String: Any])?["revision"] as? Int)

        // Words typed key by key go once the captain pauses, never one change a key.
        let typed = "Book the launch for Tuesday"
        let reply = keyboardInput("card-reply")
        revealForProbe(reply, in: app.scrollViews["card-scroll"].firstMatch)
        focusForPhoneTyping(reply, in: app)
        reply.typeText(typed)
        let typedIn = try await waitForDraft(["words": typed])
        let worded = (typedIn["changes"] as? [[String: Any]] ?? []).filter { $0["words"] != nil }
        let after = try XCTUnwrap((typedIn["draft"] as? [String: Any])?["revision"] as? Int)
        print("INF-5453 \(typed.count) keys sent \(worded.count) changes; the draft's revision moved \(before) to \(after)")
        XCTAssertGreaterThan(worded.count, 0)
        XCTAssertLessThanOrEqual(worded.count, 2, "\(typed.count) keys sent \(worded.count) changes: \(worded)")
        XCTAssertEqual(after - before, worded.count, "Each change the phone sent moved the draft's revision once")
        try await dismissKeyboardForProbe()

        let point = app.buttons["point-at"]
        XCTAssertTrue(point.waitForPresence(timeout: 10), app.debugDescription)
        reveal(point); tapOnPhone(point)
        let paragraph = app.webViews.staticTexts[part].firstMatch
        reveal(paragraph); tapOnPhone(paragraph)
        let editor = app.descendants(matching: .any).matching(identifier: "note-editor").firstMatch
        XCTAssertTrue(editor.waitForPresence(timeout: 10), "Point at did not open the note editor\n\(app.debugDescription)")
        tapOnPhone(app.buttons["note-queue"])
        XCTAssertTrue(editor.waitForAbsence(timeout: 10), app.debugDescription)
        let noted = try await waitForDraft(["notes": [""]])
        var note = try XCTUnwrap(((noted["draft"] as? [String: Any])?["notes"] as? [[String: Any]])?.first)

        let elsewhere = "Thursday suits the pilot better"
        let comment = "Ask the harbour office first"
        note["comment"] = comment
        let launch: [String: Any] = ["name": "boat", "values": ["launch"], "labels": ["The survey launch"], "changed": true]
        let body = try JSONSerialization.data(withJSONObject: ["answers": [launch], "words": elsewhere, "notes": [note]])
        _ = try await home("draft-elsewhere", body: String(decoding: body, as: UTF8.self))
        waitForDraftCount("2 of 2")
        let shown = NSPredicate { [reply] _, _ in reply.value as? String == elsewhere }
        XCTAssertEqual(waitForPhonePredicate(shown, object: nil, timeout: 10), .completed,
                       "The card's field never showed another screen's words: \(reply.value ?? "nothing")")
        XCTAssertTrue(app.staticTexts[comment].waitForPresence(timeout: 10), "The note never showed another screen's comment")
        picture("card-drafts-from-elsewhere")

        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        waitForDraftCount("2 of 2")
        let restored = keyboardInput("card-reply")
        let kept = NSPredicate { [restored] _, _ in restored.value as? String == elsewhere }
        XCTAssertEqual(waitForPhonePredicate(kept, object: nil, timeout: 10), .completed,
                       "The card's field came back without its words: \(restored.value ?? "nothing")")
        XCTAssertTrue(app.staticTexts[comment].waitForPresence(timeout: 10), "The note came back without its comment")
        XCTAssertEqual(app.staticTexts["queued-notes-count"].label, "1 note not sent")
        picture("card-drafts-after-restart")

        _ = try await home("offline")
        outOfReach("the test home went offline")
        let thursday = app.webViews.staticTexts["Thursday"].firstMatch
        reveal(thursday); tapOnPhone(thursday)
        waitForDraftCount("2 of 2")
        let away = try await home("draft-state", method: "GET")["draft"] as? [String: Any] ?? [:]
        XCTAssertEqual(Self.picked(away, "day"), ["tuesday"], "The computer heard a pick made out of its reach")
        _ = try await home("online")
        // The other screen's pick of the launch, which the phone never changed, still stands beside it.
        try await waitForDraft(["answers": ["day": ["thursday"], "boat": ["launch"]]])

        let book = app.buttons["card-action-book"]
        waitUntilEnabled(book)
        reveal(book); tapOnPhone(book)
        XCTAssertTrue(cardHeading(title).waitForAbsence(timeout: 10), app.debugDescription)
        try await waitForDraft(["gone": true])
    }

    private static func picked(_ draft: [String: Any], _ name: String) -> [String]? {
        (draft["answers"] as? [[String: Any]])?.first { $0["name"] as? String == name }?["values"] as? [String]
    }

    /// Waits until the computer's draft of the card holds these values for each named question and these words, or is gone
    /// with `gone`; the test home answers once its core's own events show it, with the draft and each change the phone sent.
    @discardableResult private func waitForDraft(_ want: [String: Any]) async throws -> [String: Any] {
        let body = try JSONSerialization.data(withJSONObject: want)
        return try await home("draft-wait", body: String(decoding: body, as: UTF8.self))
    }

    private func waitForDraftCount(_ words: String) {
        let count = app.buttons["card-answers"]
        let read = NSPredicate { _, _ in count.exists && count.label.hasPrefix(words) }
        XCTAssertEqual(waitForPhonePredicate(read, object: nil, timeout: 15), .completed,
                       "The count never read \(words): \(count.exists ? count.label : "missing")")
    }
}
