import XCTest

/// The talk-compose part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2125 direction C, the first of the talk tests split from testTalkAndTasks: a photo and typed words, the draft
    /// kept across tabs, rotation and sheets, and the ask sent with its photo.
    func testComposeAndSend() async throws {
        try await launchJoined()
        // The single journey reached this part with the cards part's hero card on the stage, after a relaunch.
        _ = try await home("empty-cards")
        let hero = try await home("hero-card")
        XCTAssertTrue(cardHeading(try XCTUnwrap(hero["title"] as? String)).waitForPresence(timeout: 10), app.debugDescription)
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        try await composeAndSend()
    }

    /// The captain's Approve and build on comfortable Apple Pencil input, on an iPad simulator told at launch that a
    /// Pencil was seen and is expected, since a simulator has none: the message box stands above the card upright and on
    /// its side, a finger's tap in it puts it back under the card, and Settings → Appearance shows the switch, on.
    /// Data: this part's test home, the harbour ask just sent as the last turn, and its hero card alone on the stage.
    /// Resources: this part's own simulator.
    private func pencilPlacement() async throws {
        _ = try await home("empty-cards")
        let hero = try await home("hero-card")
        let heading = cardHeading(try XCTUnwrap(hero["title"] as? String))
        let box = app.textFields["message-box"]
        app.launchEnvironment["INFINITARY_PENCIL_SEEN"] = "1"
        defer { app.launchEnvironment.removeValue(forKey: "INFINITARY_PENCIL_SEEN") }
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
        let above = NSPredicate { _, _ in box.frame.maxY <= heading.frame.minY }
        let below = NSPredicate { _, _ in box.frame.minY >= heading.frame.maxY }
        XCTAssertEqual(waitForPhonePredicate(above, object: nil, timeout: 10), .completed,
                       "With a Pencil expected the box stands above the card: \(app.debugDescription)")
        // The card's own page loads after the relaunch; picture it drawn, as a person sees it.
        let choice = app.webViews.staticTexts["North Basin"].firstMatch
        XCTAssertTrue(choice.waitForPresence(timeout: 20), "The card's body draws above the box: \(app.debugDescription)")
        picture("pencil-top-upright")
        turnPhone(to: .landscapeLeft, in: app, moving: heading)
        XCTAssertEqual(waitForPhonePredicate(above, object: nil, timeout: 10), .completed,
                       "On its side the box stands at the top of the card's column: \(app.debugDescription)")
        XCTAssertTrue(choice.waitForPresence(timeout: 20), app.debugDescription)
        try await appearances("pencil-top-on-its-side", showing: heading)
        turnPhone(to: .portrait, in: app, moving: heading)
        // A finger's tap gives the box focus, which puts it back at the foot.
        tapOnPhone(box)
        XCTAssertEqual(waitForPhonePredicate(below, object: nil, timeout: 10), .completed,
                       "A finger's focus puts the box back under the card: \(app.debugDescription)")
        picture("pencil-finger-foot")
        // The keyboard's Done stands where the bar's Settings button sits; put the keyboard away first.
        let done = app.navigationBars.buttons["dismiss-phone-keyboard"]
        XCTAssertTrue(done.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(done)
        XCTAssertTrue(done.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(below, object: nil, timeout: 10), .completed,
                       "Losing focus leaves the box at the foot: \(app.debugDescription)")
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(appearance)
        let pencilSwitch = app.switches["phone-pencil-top"]
        XCTAssertTrue(pencilSwitch.waitForPresence(timeout: 10), "An iPad that saw a Pencil shows the switch: \(app.debugDescription)")
        XCTAssertEqual(pencilSwitch.value as? String, "1", "The switch starts on")
        picture("pencil-switch")
    }

    /// The captain's choice on the review: at the top only the newest exchange shows, so a card leaving does not move
    /// the box; then the off switch keeps the box under the card after a relaunch. Data: the saved-rounds fixture's two
    /// rounds, so an older round exists to leave out, and the hero card. Resources: this part's own simulator.
    private func pencilSteadyThenOff() async throws {
        let hero = try await home("hero-card")
        let heading = cardHeading(try XCTUnwrap(hero["title"] as? String))
        let box = app.textFields["message-box"]
        let older = app.buttons["last-turn-older-reply"]
        app.launchEnvironment["INFINITARY_PENCIL_SEEN"] = "1"
        defer { app.launchEnvironment.removeValue(forKey: "INFINITARY_PENCIL_SEEN") }
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
        let above = NSPredicate { _, _ in box.frame.maxY <= heading.frame.minY }
        let below = NSPredicate { _, _ in box.frame.minY >= heading.frame.maxY }
        XCTAssertEqual(waitForPhonePredicate(above, object: nil, timeout: 10), .completed, app.debugDescription)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10), app.debugDescription)
        let top = box.frame
        _ = try await home("empty-cards")
        XCTAssertTrue(heading.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertFalse(older.exists, "At the top only the newest exchange shows, card or no card: \(app.debugDescription)")
        XCTAssertEqual(box.frame.minY, top.minY, accuracy: 1, "The card leaving does not move the box at the top")
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(appearance)
        let pencilSwitch = app.switches["phone-pencil-top"]
        XCTAssertTrue(pencilSwitch.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(pencilSwitch)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == '0'"), object: pencilSwitch, timeout: 10), .completed)
        _ = try await home("hero-card")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(below, object: nil, timeout: 10), .completed,
                       "Turned off, the box stays under the card with a Pencil expected: \(app.debugDescription)")
    }

    /// INF-2218's approved reading view: the existing saved round opens without sending another message.
    /// The talk fixture supplies the real saved reply; the sheet preserves its words and dismissal on both devices.
    private func verifyReplyReading(_ sent: [String: Any]) async throws {
        let round = try XCTUnwrap(sent["lastTurn"] as? [String: Any])
        let question = try XCTUnwrap(round["you"] as? String)
        let reply = try XCTUnwrap(round["reply"] as? [String: Any])
        let words = try XCTUnwrap(reply["words"] as? String ?? reply["text"] as? String)
        let before = try await home("talk-state", method: "GET")
        tapOnPhone(app.buttons["last-turn-reply"])
        let body = app.staticTexts["reply-note-words"]
        XCTAssertTrue(body.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(body.label, words, "The sheet keeps the saved reply's literal words")
        let bubble = app.buttons["reply-note-question"]
        XCTAssertTrue(bubble.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(bubble.label, question, "The shared bubble shows the original saved question without added quotes")
        XCTAssertTrue(app.staticTexts["You"].exists)
        XCTAssertTrue(app.staticTexts["First mate"].exists)
        XCTAssertFalse(app.staticTexts["reply-note-title"].exists)
        try await appearances("conversation-reply", showing: body)
        tapOnPhone(app.buttons["close-reply-note"])
        XCTAssertTrue(app.buttons["close-reply-note"].waitForAbsence(timeout: 10))
        let after = try await home("talk-state", method: "GET")
        XCTAssertEqual((after["writes"] as? [Any])?.count, (before["writes"] as? [Any])?.count,
                       "Reading and dismissing the sheet sends nothing")
        XCTAssertEqual((after["lastTurn"] as? [String: Any])?["you"] as? String, question)
    }

    /// INF-2218: realistic saved long and picture-only rounds through the task owner, not another reply store.
    /// The native sheet must keep exact multiline words, allow the long question to open/fold and send nothing.
    private func verifyLongReplyReading() async throws {
        _ = try await home("empty-cards")
        let fixture = try await home("reply-reading-fixture")
        app.terminate(); app.launch()
        let pictureQuestion = app.staticTexts["last-turn-you"]
        XCTAssertTrue(pictureQuestion.waitForPresence(timeout: 10), app.debugDescription)
        let pictureWords = pictureQuestion.label
        let before = try await home("talk-state", method: "GET")
        tapOnPhone(app.buttons["last-turn-reply"])
        let body = app.staticTexts["reply-note-words"]
        XCTAssertTrue(body.waitForPresence(timeout: 10))
        XCTAssertEqual(body.label, fixture["problemWords"] as? String)
        XCTAssertEqual(app.buttons["reply-note-question"].label, pictureWords)
        XCTAssertFalse(app.buttons["reply-note-question"].isEnabled)
        try await appearances("conversation-picture-problem", showing: body)
        tapOnPhone(app.buttons["close-reply-note"])
        XCTAssertTrue(app.buttons["close-reply-note"].waitForAbsence(timeout: 10))
        tapOnPhone(app.buttons["last-turn-older-reply"])
        XCTAssertTrue(body.waitForPresence(timeout: 10))
        XCTAssertEqual(body.label, fixture["words"] as? String)
        let bubble = app.buttons["reply-note-question"]
        XCTAssertTrue(bubble.isEnabled, "A question cut after two lines can be opened")
        XCTAssertEqual(bubble.label, fixture["question"] as? String)
        let folded = bubble.frame.height
        tapOnPhone(bubble)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in bubble.frame.height > folded }, object: nil, timeout: 10), .completed)
        // INF-4241 dropped a fold back and a third open, which repeated the first open; the question stays open here.
        XCTAssertEqual(body.label, fixture["words"] as? String)
        try await appearances("conversation-long-reply", showing: body)
        let scroll = app.scrollViews["reply-note-scroll"]
        if body.frame.maxY > scroll.frame.maxY {
            scroll.swipeUp()
            XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in body.frame.maxY <= scroll.frame.maxY + 1 }, object: nil, timeout: 10), .completed)
            picture("conversation-long-reply-scrolled")
        }
        tapOnPhone(app.buttons["close-reply-note"])
        XCTAssertTrue(app.buttons["close-reply-note"].waitForAbsence(timeout: 10))
        let after = try await home("talk-state", method: "GET")
        XCTAssertEqual((after["writes"] as? [Any])?.count, (before["writes"] as? [Any])?.count,
                       "Reading either saved round sends no message")
        let savedBefore = try XCTUnwrap(before["lastTurn"] as? NSDictionary)
        let savedAfter = try XCTUnwrap(after["lastTurn"] as? NSDictionary)
        XCTAssertEqual(savedAfter, savedBefore, "Reading and scrolling do not change saved words")
    }

    /// INF-64 piece 5: native input and controls reach the real Mac as captain actions.
    /// Data: a project-owned photo, a typed harbour ask, and an on-request task with a held mock-provider turn.
    /// Completion: the Mac keeps the ask/photo, runs that task, records interruption/continuation and hears the steer.
    /// Resources: each talk test's own fresh simulator/home only; no phone signing, microphone or real account.
    /// INF-2125 direction C splits it in three: composeAndSend, tasksAndSteer and draftsAcrossHomes.
    private func composeAndSend() async throws {
        let fixture = try await home("talk-fixture")
        let words = try XCTUnwrap(fixture["text"] as? String)
        addPhoneJourneyPhoto(app: app)
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(words)
        picture("message-and-photo")
        let beforeDraft = try await home("talk-state", method: "GET")
        try await verifyComposerDraft(words)
        let afterDraft = try await home("talk-state", method: "GET")
        XCTAssertEqual((afterDraft["writes"] as? [Any])?.count, (beforeDraft["writes"] as? [Any])?.count,
            "Command-Return behind the details sheet sends no hidden composer request")
        // The completed keyboard/details interactions follow rotation's intermediate redraw.
        picture("draft-portrait-ready")
        tapOnPhone(app.buttons["send-message"])
        let sent = try await home("talk-sent")
        let writes = try XCTUnwrap(sent["writes"] as? [[String: Any]])
        let message = try XCTUnwrap(writes.first { $0["channel"] as? String == "inf:converse" })
        XCTAssertEqual((message["actor"] as? [String: Any])?["kind"] as? String, "captain")
        let payload = try XCTUnwrap((message["args"] as? [[String: Any]])?.first)
        XCTAssertEqual(payload["text"] as? String, words)
        XCTAssertEqual(payload["visibleCardId"] as? String, fixture["visibleCardId"] as? String)
        XCTAssertNotNil(payload["visibleCardId"])
        XCTAssertNil(payload["pastCardId"])
        let images = try XCTUnwrap(payload["images"] as? [[String: Any]])
        XCTAssertEqual(images.count, 1); XCTAssertGreaterThan(try XCTUnwrap(images.first?["bytes"] as? Int), 0)
        XCTAssertEqual((sent["lastTurn"] as? [String: Any])?["you"] as? String, words)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 0)
        verifyPhoneComposerBounds(app: app)
        picture("last-turn")
        try await verifyReplyReading(sent)
        // Before the saved-rounds fixture below adds its problem round, so the last turn is the ask just sent.
        if UIDevice.current.userInterfaceIdiom == .pad { try await pencilPlacement() }
        try await verifyLongReplyReading()
        if UIDevice.current.userInterfaceIdiom == .pad { try await pencilSteadyThenOff() }
    }

    /// INF-209 and INF-82 integration: one composer retains the actual typed/photo draft across tabs and rotation.
    /// This extends the existing real-home journey, using its owned simulator, selected photo and captain ask.
    private func verifyComposerDraft(_ words: String) async throws {
        try await verifyPhoneComposerDrafts(app: app, words: words, tab: { tab($0) }, picture: picture) { start in
            _ = try await self.home(start ? "capture-composer-start" : "capture-stop")
        }
    }
}
