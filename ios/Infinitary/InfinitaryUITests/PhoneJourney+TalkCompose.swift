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

    /// The Conversation's words for one round: the captain's bubble and what came back, found by their words, since
    /// every round in it carries the same identifiers.
    private func conversationWords(_ words: String) -> XCUIElement {
        app.staticTexts.matching(identifier: "conversation-words").matching(NSPredicate(format: "label == %@", words)).firstMatch
    }

    private func conversationYou(_ words: String) -> XCUIElement {
        app.staticTexts.matching(identifier: "conversation-you").matching(NSPredicate(format: "label == %@", words)).firstMatch
    }

    /// INF-6337's plan, part 3: the reply line opens the Conversation at that round, which keeps the saved question and
    /// reply word for word, reads without sending anything, and closes with Done, on both devices.
    private func verifyReplyReading(_ sent: [String: Any]) async throws {
        let round = try XCTUnwrap(sent["lastTurn"] as? [String: Any])
        let question = try XCTUnwrap(round["you"] as? String)
        let reply = try XCTUnwrap(round["reply"] as? [String: Any])
        let words = try XCTUnwrap(reply["words"] as? String ?? reply["text"] as? String)
        let before = try await home("talk-state", method: "GET")
        tapOnPhone(app.buttons["last-turn-reply"])
        let body = conversationWords(words)
        XCTAssertTrue(body.waitForPresence(timeout: 10), "The Conversation keeps the saved reply's literal words: \(app.debugDescription)")
        XCTAssertTrue(conversationYou(question).waitForPresence(timeout: 10),
                      "The bubble shows the original saved question without added quotes: \(app.debugDescription)")
        try await appearances("conversation-reply", showing: body)
        tapOnPhone(app.buttons["close-conversation"])
        XCTAssertTrue(app.buttons["close-conversation"].waitForAbsence(timeout: 10))
        let after = try await home("talk-state", method: "GET")
        XCTAssertEqual((after["writes"] as? [Any])?.count, (before["writes"] as? [Any])?.count,
                       "Reading and closing the Conversation sends nothing")
        XCTAssertEqual((after["lastTurn"] as? [String: Any])?["you"] as? String, question)
    }

    /// INF-2218, kept for the Conversation: realistic saved long and picture-only rounds through the task owner. The
    /// Conversation keeps exact multiline words, shows the long question whole, scrolls, and sends nothing.
    private func verifyLongReplyReading() async throws {
        _ = try await home("empty-cards")
        let fixture = try await home("reply-reading-fixture")
        app.terminate(); app.launch()
        let pictureQuestion = app.staticTexts["last-turn-you"]
        XCTAssertTrue(pictureQuestion.waitForPresence(timeout: 10), app.debugDescription)
        let pictureWords = pictureQuestion.label
        let before = try await home("talk-state", method: "GET")
        tapOnPhone(app.buttons["last-turn-reply"])
        let problem = conversationWords(try XCTUnwrap(fixture["problemWords"] as? String))
        XCTAssertTrue(problem.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(conversationYou(pictureWords).exists, "A picture-only message reads as its picture words")
        try await appearances("conversation-picture-problem", showing: problem)
        tapOnPhone(app.buttons["close-conversation"])
        XCTAssertTrue(app.buttons["close-conversation"].waitForAbsence(timeout: 10))
        tapOnPhone(app.buttons["last-turn-older-reply"])
        let body = conversationWords(try XCTUnwrap(fixture["words"] as? String))
        XCTAssertTrue(body.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(conversationYou(try XCTUnwrap(fixture["question"] as? String)).exists, "The long question shows whole")
        try await appearances("conversation-long-reply", showing: body)
        let scroll = app.scrollViews["conversation-scroll"]
        if body.frame.maxY > scroll.frame.maxY {
            scroll.swipeUp()
            XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in body.frame.maxY <= scroll.frame.maxY + 1 }, object: nil, timeout: 10), .completed)
            picture("conversation-long-reply-scrolled")
        }
        tapOnPhone(app.buttons["close-conversation"])
        XCTAssertTrue(app.buttons["close-conversation"].waitForAbsence(timeout: 10))
        let after = try await home("talk-state", method: "GET")
        XCTAssertEqual((after["writes"] as? [Any])?.count, (before["writes"] as? [Any])?.count,
                       "Reading either saved round sends no message")
        let savedBefore = try XCTUnwrap(before["lastTurn"] as? NSDictionary)
        let savedAfter = try XCTUnwrap(after["lastTurn"] as? NSDictionary)
        XCTAssertEqual(savedAfter, savedBefore, "Reading and scrolling do not change saved words")
    }

    /// INF-6337's plan, part 3, the captain's words: the conversation holds "cards they interacted" and is "a place for
    /// people to find their recent cards". The phone's own press of a card's button shows on the strip as a card round;
    /// the round opens the Conversation, its Cards view lists the card waiting and the one answered, and a tile opens
    /// its card on Home, after which the Conversation comes back as it was. Data: this part's test home, two first mate
    /// cards. Resources: this part's own simulator.
    private func verifyConversationCards() async throws {
        _ = try await home("empty-cards")
        let pressed = try await home("conversation-card")
        let title = try XCTUnwrap(pressed["title"] as? String)
        let label = try XCTUnwrap(pressed["label"] as? String)
        let heading = cardHeading(title)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
        let choice = app.buttons["card-action-bars"]
        XCTAssertTrue(choice.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "isEnabled == true"), object: choice, timeout: 20), .completed)
        tapOnPhone(choice)
        XCTAssertTrue(heading.waitForAbsence(timeout: 10), "The pressed card leaves the stage: \(app.debugDescription)")
        let cardName = app.buttons["last-turn-card"]
        XCTAssertTrue(cardName.waitForPresence(timeout: 15), "The press shows on the strip as a card round: \(app.debugDescription)")
        XCTAssertTrue(cardName.label.contains(title), "The card round names the card")
        let bubble = app.buttons["last-turn-you"]
        XCTAssertEqual(bubble.label, label, "The card round shows the button's own words")
        XCTAssertTrue(app.staticTexts["last-turn-older-you"].exists, "The message before it stays as the older round")
        try await appearances("strip-card-round", showing: bubble)
        // The card's name opens it again, as a past card; putting it away leaves the strip as it was.
        tapOnPhone(cardName)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), "The card's name opens the card: \(app.debugDescription)")
        tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(heading.waitForAbsence(timeout: 10), app.debugDescription)
        let waiting = try await home("conversation-waiting")
        let waitingHeading = cardHeading(try XCTUnwrap(waiting["title"] as? String))
        XCTAssertTrue(waitingHeading.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(bubble.waitForPresence(timeout: 10), "With a card up the newest round stays: \(app.debugDescription)")
        tapOnPhone(bubble)
        let chose = conversationYou("Chose “\(label)”")
        XCTAssertTrue(chose.waitForPresence(timeout: 10), "The Conversation opens at the card round: \(app.debugDescription)")
        let pressedTile = app.buttons["conversation-tile-\(try XCTUnwrap(pressed["id"] as? String))"]
        XCTAssertTrue(pressedTile.exists, "The card's tile stands before the press")
        try await appearances("conversation-everything", showing: chose)
        tapOnPhone(app.segmentedControls["conversation-show"].buttons.element(boundBy: 1))
        let waitingTile = app.buttons["conversation-tile-\(try XCTUnwrap(waiting["id"] as? String))"]
        XCTAssertTrue(waitingTile.waitForPresence(timeout: 10), "Cards lists the card waiting on you: \(app.debugDescription)")
        XCTAssertTrue(app.descendants(matching: .any)["conversation-section-answered"].exists, "Cards lists the answered card")
        XCTAssertTrue(pressedTile.exists)
        XCTAssertLessThan(waitingTile.frame.minY, pressedTile.frame.minY, "Waiting on you comes first")
        try await appearances("conversation-cards", showing: pressedTile)
        tapOnPhone(pressedTile)
        XCTAssertTrue(app.buttons["close-conversation"].waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), "The tile opens its card on Home: \(app.debugDescription)")
        tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(app.buttons["close-conversation"].waitForPresence(timeout: 10),
                      "Once the card leaves, the Conversation comes back: \(app.debugDescription)")
        XCTAssertTrue(waitingTile.waitForPresence(timeout: 10), "It comes back on the view it was left on")
        tapOnPhone(app.buttons["close-conversation"])
        XCTAssertTrue(app.buttons["close-conversation"].waitForAbsence(timeout: 10))
        try await verifyCardActsOnTheStrip(chart: title, waiting: waiting)
        _ = try await home("empty-cards")
    }

    /// The review of INF-6366, from the captain's "the last couple of interactions" and "cards they interacted": two card
    /// acts in a row after a message keep both on the strip, newest first; a line typed under a crewmate's card is a
    /// card round with no reply line; one typed under the first mate's own card is also a message and keeps its reply
    /// line. Data: this part's test home, the waiting card above and two more cards. Resources: this part's simulator.
    private func verifyCardActsOnTheStrip(chart: String, waiting: [String: Any]) async throws {
        let title = try XCTUnwrap(waiting["title"] as? String)
        let heading = cardHeading(title)
        XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
        let north = app.buttons["card-action-north"]
        reveal(north); tapOnPhone(north)
        XCTAssertTrue(heading.waitForAbsence(timeout: 10), app.debugDescription)
        let newest = app.buttons["last-turn-card"], older = app.buttons["last-turn-older-card"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label CONTAINS %@", title), object: newest, timeout: 15), .completed,
                       "The newer press is the newest round: \(app.debugDescription)")
        XCTAssertEqual(app.buttons["last-turn-you"].label, try XCTUnwrap(waiting["label"] as? String))
        XCTAssertTrue(older.waitForPresence(timeout: 10), "The press before it is the older round, not the message: \(app.debugDescription)")
        XCTAssertTrue(older.label.contains(chart), "The older round names the first card pressed")
        XCTAssertFalse(app.staticTexts["last-turn-older-you"].exists, "The message before both presses leaves the strip")
        try await appearances("strip-two-card-rounds", showing: older)
        for (command, words, message) in [("conversation-crew-card", "Chart the south channel next.", false),
                                          ("conversation-mate-card", "Move it to Monday.", true)] {
            let card = try await home(command)
            let cardTitle = try XCTUnwrap(card["title"] as? String)
            XCTAssertTrue(cardHeading(cardTitle).waitForPresence(timeout: 10), app.debugDescription)
            let reply = app.textFields["card-reply"]
            reveal(reply); focusForPhoneTyping(reply, in: app); reply.typeText(words)
            let send = app.buttons["send-reply"]
            reveal(send); tapOnPhone(send)
            XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label CONTAINS %@", cardTitle), object: newest, timeout: 15), .completed,
                           "The line typed under \(cardTitle) is the newest round: \(app.debugDescription)")
            XCTAssertEqual(app.buttons["last-turn-you"].label, words, "The round shows the typed words")
            let line = app.descendants(matching: .any)["last-turn-reply"]
            if message {
                XCTAssertTrue(line.waitForPresence(timeout: 10), "A line under the first mate's own card keeps its reply line")
                try await appearances("strip-typed-under-card", showing: newest)
            } else {
                XCTAssertFalse(line.exists, "A line under a crewmate's card is no message and has no reply line")
            }
            _ = try await home("empty-cards")
        }
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
        try await verifyConversationCards()
    }

    /// INF-209 and INF-82 integration: one composer retains the actual typed/photo draft across tabs and rotation.
    /// This extends the existing real-home journey, using its owned simulator, selected photo and captain ask.
    private func verifyComposerDraft(_ words: String) async throws {
        try await verifyPhoneComposerDrafts(app: app, words: words, tab: { tab($0) }, picture: picture) { start in
            _ = try await self.home(start ? "capture-composer-start" : "capture-stop")
        }
    }
}
