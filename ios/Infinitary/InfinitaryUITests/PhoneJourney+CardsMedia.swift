import CoreImage
import XCTest

/// The cards-media part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2125 direction C, the third cards test: pictures, a recording, a thread, a body's choice, out of reach and large type.
    func testCardMediaAndBody() async throws {
        app.launchEnvironment["INFINITARY_TEST_RETRIED_CARD_LAG"] = "3"
        // The check's simulators have no sound device, so a clip keeps its time on the app's stand-in clock.
        app.launchEnvironment["INFINITARY_TEST_SOUND_CLOCK"] = "1"
        try await launchJoined()
        try await verifyCardMediaAndBody()
    }

    /// The captain's plan for sound in cards ("Sound clips", docs/card-authoring.md): a clip's Listen button in the body plays
    /// it in the strip under the body, only on that press; Pause and Play hold it and go on, and leaving the app pauses it.
    private func verifyCardSound() async throws {
        let strip = app.descendants(matching: .any).matching(identifier: "card-sound").firstMatch
        XCTAssertFalse(strip.exists, "Nothing plays before the captain's press")
        let listen = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Listen,")).firstMatch
        XCTAssertTrue(listen.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(listen.label, "Listen, 20 seconds", "The button says the clip's length the home wrote")
        reveal(listen); tapOnPhone(listen)
        let toggle = app.buttons["card-sound-toggle"]
        XCTAssertTrue(toggle.waitForPresence(timeout: 15), app.debugDescription)
        let time = app.staticTexts["card-sound-time"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in toggle.label == "Pause" }, object: nil, timeout: 15), .completed,
                       "The press plays the clip: \(app.debugDescription)")
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in time.exists && !time.label.hasPrefix("0:00") }, object: nil, timeout: 10),
                       .completed, "The clip's time moves while it plays: \(time.label)")
        XCTAssertTrue(time.label.hasSuffix(" / 0:20"), "The strip reads the clip's own length: \(time.label)")
        XCTAssertTrue(app.staticTexts["The harbour bell at the north entrance."].exists, "The strip carries the clip's caption")
        reveal(toggle)
        picture("card-sound-playing")
        tapOnPhone(toggle)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in toggle.label == "Play" }, object: nil, timeout: 10), .completed,
                       "Pause holds the clip")
        // The strip held still, in both appearances, for the change's pictures.
        try await appearances("card-sound", showing: strip)
        tapOnPhone(toggle)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in toggle.label == "Pause" }, object: nil, timeout: 10), .completed,
                       "Play goes on with the clip")
        XCUIDevice.shared.press(.home)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in self.app.state != .runningForeground }, object: nil, timeout: 10), .completed,
                       "Home leaves the app")
        app.activate()
        XCTAssertTrue(toggle.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in toggle.label == "Play" }, object: nil, timeout: 10), .completed,
                       "Leaving the app stopped the clip: \(toggle.label)")
    }

    private func verifyCardMediaAndBody() async throws {
        let fixture = try await home("cards-fixture")
        let choice = try XCTUnwrap(fixture["choice"] as? String)
        let chart = try XCTUnwrap(fixture["conversation"] as? String)
        let note = try XCTUnwrap(fixture["note"] as? String)
        // INF-1879: put the staged choice aside without discarding it or answering it.
        showCard(choice)
        let reported = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", #"[0-9]+ of [0-9]+ answered · 1 changed"#)).firstMatch
        XCTAssertTrue(reported.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(cardHeading(choice).waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.alerts.firstMatch.exists, "Putting a card aside never asks to discard its staged settings")

        showCard(chart)
        // INF-1062: with no bar under it, scrolling a long card leaves the message box where it is, in the column's width.
        if phoneShownLayout(app) == .column {
            let composer = app.otherElements["phone-composer"].firstMatch
            let before = composer.frame
            app.scrollViews["card-scroll"].swipeUp()
            XCTAssertEqual(composer.frame.minY, before.minY, accuracy: 1, "Scrolling a card does not move the message box")
            XCTAssertEqual(composer.frame.width, before.width, accuracy: 1, "Scrolling a card does not narrow the message box")
            verifyPhoneComposerBounds(app: app)
            // INF-3460: the card arrives with its body drawn, so the swipe scrolls its head, and the minus with it, off the
            // top; the message box is what this picture is about and stays on the screen.
            try await appearances("card-scrolled", showing: composer)
            // The steps below start from the card's top, as it stood before this swipe.
            let scroller = app.scrollViews["card-scroll"]
            scroller.swipeDown()
            XCTAssertTrue(app.buttons["put-aside-card"].waitForPresence(timeout: 10))
            _ = waitForRedraw(app.buttons["put-aside-card"], from: nil)
        }
        let pictureElement = app.webViews.images["Blue harbour survey"].firstMatch
        XCTAssertTrue(pictureElement.waitForPresence(timeout: 10))
        reveal(pictureElement); tapOnPhone(pictureElement)
        XCTAssertTrue(app.webViews["card-picture"].waitForPresence(timeout: 10))
        picture("picture-viewer")
        _ = try await home("capture-picture-start")
        app.webViews["card-picture"].pinch(withScale: 1.6, velocity: 1)
        picture("picture-zoomed")
        _ = try await home("capture-stop")
        tapOnPhone(app.buttons["Done"])
        // INF-1337: a finger held on the picture opens it too. WebKit can send a press it holds past its own press moment
        // no click, so before the fix a 1.5 s press could open no viewer.
        XCTAssertTrue(app.webViews["card-picture"].waitForAbsence(timeout: 10), app.debugDescription)
        reveal(pictureElement); waitForSteadyTarget(pictureElement)
        pictureElement.press(forDuration: 1.5)
        XCTAssertTrue(app.webViews["card-picture"].waitForPresence(timeout: 10),
                      "A held press on the picture opened no viewer\n\(app.debugDescription)")
        // The viewer's sheet has finished sliding in once its Done holds still, so the picture shows it whole.
        waitForSteadyTarget(app.buttons["Done"])
        picture("picture-viewer-after-a-held-press")
        tapOnPhone(app.buttons["Done"])
        // INF-3107 (the captain's Approve and build): a tapped diagram opens full screen, fitted; a double-tap shows it
        // at its own size where tapped and a second one fits it again; a swipe down while fitted closes it.
        let diagram = app.webViews.images["Harbour approach in three legs"].firstMatch
        XCTAssertTrue(diagram.waitForPresence(timeout: 10), app.debugDescription)
        reveal(diagram); tapOnPhone(diagram)
        let viewer = app.webViews["card-picture"]
        XCTAssertTrue(viewer.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.navigationBars["Card diagram"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(viewer.images["Harbour approach in three legs"].firstMatch.waitForPresence(timeout: 10), app.debugDescription)
        // WebKit places the drawing's own frame inside the picture, not where it is drawn, so the zoom is read from
        // the viewer's horizontal scroll bar: one page fitted, more once enlarged.
        let across = viewer.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Horizontal scroll bar")).firstMatch
        XCTAssertTrue(across.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(across.label, "Horizontal scroll bar, 1 page", "A diagram opens fitted")
        picture("diagram-viewer")
        viewer.doubleTap()
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in across.label != "Horizontal scroll bar, 1 page" }, object: across, timeout: 10) == .completed,
                      "A double-tap enlarges the diagram: \(across.label)")
        picture("diagram-enlarged")
        viewer.doubleTap()
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in across.label == "Horizontal scroll bar, 1 page" }, object: across, timeout: 10) == .completed,
                      "A second double-tap fits it again: \(across.label)")
        viewer.swipeDown()
        XCTAssertTrue(viewer.waitForAbsence(timeout: 10), "A swipe down while fitted closes the viewer")
        // INF-3887 (the captain's pick: "Open the log on the phone too"): a proof log the card names by one line opens
        // in the phone's log reader, its text read from the computer, never written into the card.
        let logName = try XCTUnwrap(fixture["log"] as? String)
        let logLine = app.webViews.buttons[logName].firstMatch
        XCTAssertTrue(logLine.waitForPresence(timeout: 10), app.debugDescription)
        reveal(logLine); tapOnPhone(logLine)
        let logText = app.descendants(matching: .any).matching(identifier: "card-log-text").firstMatch
        XCTAssertTrue(logText.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.navigationBars[logName].exists, app.debugDescription)
        // The log's text draws, not only its place: a whole half-megabyte log in one Text once left the reader blank.
        let firstBlock = app.descendants(matching: .any).matching(identifier: "card-log-block").firstMatch
        XCTAssertTrue(firstBlock.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(drawsInk(firstBlock.screenshot().image), "The log reader's first block draws its text")
        picture("log-reader")
        tapOnPhone(app.buttons["Done"])
        XCTAssertTrue(logText.waitForAbsence(timeout: 10), "Done closes the log reader")
        // The home measures the recording and owns its duration label.
        let play = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Play the demo,")).firstMatch
        reveal(play)
        _ = try await home("capture-media-start")
        tapOnPhone(play)
        let player = app.descendants(matching: .any).matching(identifier: "card-recording").firstMatch
        XCTAssertTrue(player.waitForPresence(timeout: 10))
        // The body's Play already starts playback; AVKit may hide its controls before a short clip ends.
        // Completion comes from the real player's end notification, not a transient controls snapshot.
        XCTAssertTrue(app.staticTexts["recording-finished"].waitForPresence(timeout: 15), app.debugDescription)
        tapOnPhone(app.buttons["Play again"])
        XCTAssertTrue(app.staticTexts["recording-finished"].waitForPresence(timeout: 15))
        let mediaState = XCTAttachment(string: app.debugDescription)
        mediaState.name = "recording-controls"; mediaState.lifetime = .keepAlways; add(mediaState)
        picture("recording-playing")
        _ = try await home("capture-stop")
        tapOnPhone(app.buttons["Done"])
        try await verifyCardSound()
        let reply = app.textFields["card-reply"]
        reveal(reply)
        _ = try await home("capture-reply-start")
        focusForPhoneTyping(reply, in: app); reply.typeText("Keep the northern entrance clear.")
        let send = app.buttons["send-reply"]
        reveal(send); tapOnPhone(send)
        XCTAssertTrue(app.staticTexts["Keep the northern entrance clear."].waitForPresence(timeout: 10), app.debugDescription)
        // The reply wakes the first mate, whose answer joins this card's thread a turn later. The count is read once that
        // answer is in, or an answer landing after the read leaves the thread one longer than the count.
        let back = app.descendants(matching: .any).matching(identifier: "card-back").firstMatch
        XCTAssertTrue(back.waitForPresence(timeout: 10), app.debugDescription)
        let answer = try XCTUnwrap(fixture["replyAnswer"] as? String)
        XCTAssertTrue(back.staticTexts[answer].waitForPresence(timeout: 10), app.debugDescription)
        let replied = try await home("card-state", method: "GET")
        let thread = try XCTUnwrap(replied["thread"] as? [String: Any])
        let sent = thread["messages"] as? [[String: Any]] ?? []
        XCTAssertTrue(sent.contains {
            $0["who"] as? String == "captain" && $0["text"] as? String == "Keep the northern entrance clear."
        })
        // INF-1919 (the captain's Approve and build): the send turns the card over to its thread, where the reply shows.
        XCTAssertEqual(app.staticTexts["thread-count"].label, "THREAD · \(sent.count)")
        picture("card-thread-sent")
        // Card turns it back; the face's latest line names the reply, and an answer that lands there lights it.
        tapOnPhone(app.buttons["thread-return"])
        let cue = app.buttons["thread-cue"]
        XCTAssertTrue(cue.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(back.waitForAbsence(timeout: 10), "The face hides the back")
        _ = try await home("thread-answer")
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in cue.value as? String == "1 new" }, object: cue, timeout: 10) == .completed,
                      app.debugDescription)
        XCTAssertTrue(app.buttons["put-aside-card"].exists, "A landing reply never turns the card")
        picture("card-thread-unread")
        tapOnPhone(cue)
        XCTAssertTrue(app.staticTexts["I kept your harbour reply with this chart."].waitForPresence(timeout: 10))
        picture("card-thread")
        _ = try await home("capture-stop")
        // Command-backslash turns it back, as on the Mac; the line is read now.
        try await pressPhoneKey("\\", modifiers: .command, in: app)
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in cue.value as? String == "\(sent.count + 1) messages" }, object: cue, timeout: 10) == .completed,
                      app.debugDescription)
        let browser = app.buttons["card-action-browser"]
        reveal(browser); tapOnPhone(browser)
        XCTAssertTrue(app.staticTexts["Do this on Test Mac mini."].waitForPresence(timeout: 10))

        _ = try await home("offline")
        outOfReach()
        XCTAssertFalse(app.buttons["put-aside-card"].isEnabled)
        XCTAssertFalse(app.buttons["card-action-body"].isEnabled)
        let atDisconnect = try await home("card-state", method: "GET")
        let bodyButton = app.webViews.buttons["Choose from the body"]
        reveal(bodyButton); tapOnPhone(bodyButton)
        // INF-6677: the phone answers the body's choice out of reach with its refusal, so the tap reached the choice and
        // not the log button above it, whose open reader then took the tap made after reconnecting.
        let refused = app.staticTexts.matching(identifier: "card-notice")
            .matching(NSPredicate(format: "label == %@", "Your computer is out of reach. Nothing will be sent later.")).firstMatch
        XCTAssertTrue(refused.waitForPresence(timeout: 10), app.debugDescription)
        picture("card-out-of-reach")
        _ = try await home("online")
        reach("Live", timeout: 20)
        let afterReconnect = try await home("card-state", method: "GET")
        let writes: ([String: Any]) -> Int = { state in (state["calls"] as? [[String: Any]] ?? []).filter { $0["channel"] as? String == "inf:cards:act" }.count }
        XCTAssertEqual(writes(afterReconnect), writes(atDisconnect), "An offline body action is never replayed")
        // INF-2553 (the captain: "the card leaves at the tap and the next card is up at once"): the body's choice
        // takes the card off Home while the computer still holds its request, so no second input can reach it.
        _ = try await home("hold-card-action")
        reveal(bodyButton); tapOnPhone(bodyButton)
        _ = try await home("card-action-held")
        XCTAssertTrue(cardHeading(chart).waitForAbsence(timeout: 10), "A body choice shows at the tap, before the computer answers")
        picture("card-choice-at-tap")
        _ = try await home("release-card-action")
        XCTAssertFalse(cardHeading(chart).exists, "The computer's answer leaves the choice as shown")
        let bodyChoice = try await home("card-state", method: "GET")
        XCTAssertEqual(writes(bodyChoice), writes(afterReconnect) + 1, "The choice sends one change")
        let bodyPast = try XCTUnwrap(bodyChoice["conversation"] as? [String: Any])
        XCTAssertEqual((bodyPast["ending"] as? [String: Any])?["actionId"] as? String, "body")
        // The choice wakes the first mate; its turn ends before INF-1060 below reads the footer's reply button.
        _ = try await home("script-choice-heard")
        _ = try await home("show-body-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        XCTAssertEqual((bodyPast["ending"] as? [String: Any])?["by"] as? String, "frame")
        let pastWords = try XCTUnwrap(bodyChoice["conversationEnding"] as? String)
        XCTAssertTrue(app.staticTexts["past-ending"].label.hasPrefix(pastWords), "A script's choice is not credited to the captain")
        // INF-1879: photograph the past card's minus only once its body is drawn, not its incoming shell.
        showCard(chart)
        picture("past-body-choice")
        tapOnPhone(app.buttons["put-aside-card"])
        showCard(note)
        // INF-2553 (the captain: "to its place in the stack, with a short notice where you are"): a close the
        // computer refuses brings the card back where it was and says why on Home.
        let refusal = "This card changed on your computer. Look at it again."
        _ = try await home("refuse-next-change", body: #"{"channel":"inf:cards:close","words":"\#(refusal)"}"#)
        tapOnPhone(app.buttons["put-aside-card"])
        let notice = app.buttons["change-notice"]
        XCTAssertTrue(notice.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(notice.label, refusal)
        XCTAssertTrue(cardHeading(note).waitForPresence(timeout: 10), "A refused close puts the card back")
        picture("card-close-refused")
        tapOnPhone(notice)
        XCTAssertTrue(notice.waitForAbsence(timeout: 10))
        // INF-4241: of the four refusals this part read, it keeps the upright close above; where a refused close puts the
        // card is PhoneIntentsTests' aRefusedCloseReturnsTheCardToItsPlace.
        // INF-2794: the note's own Got it sits in the pinned row under the hairline and reads it; a press the
        // computer still holds has already taken the card off Home.
        let gotIt = app.buttons["note-done"]
        XCTAssertTrue(gotIt.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(gotIt.label, "Got it")
        picture("note-got-it")
        // INF-4241: a choice leaving at the tap, before the computer answers, is read once in this part, on the body's
        // choice above, and on the merge part's note Done (testMergeCard).
        tapOnPhone(gotIt)
        XCTAssertTrue(cardHeading(note).waitForAbsence(timeout: 10), app.debugDescription)
        let closed = try await home("card-state", method: "GET")
        XCTAssertNotNil(closed["note"] as? [String: Any])
        XCTAssertEqual(closed["leaks"] as? Int, 0)
        // INF-1060, the captain: "after cards are dismissed, it doesn't extend back". With the last card closed,
        // the message box keeps its place and the column's width at the foot of Home.
        verifyPhoneComposerBounds(app: app)
        picture("cards-answered-and-closed")
        // INF-1059, the captain's "why images couldn't render inline?": a picture card already in the stack when the
        // phone comes back is drawn from the first cards read while the board read is still out, so its picture is asked
        // before the computer is in reach. The phone asks for it once it is in reach, rather than keeping a broken box.
        // The home's offline answers once it has closed the phone's connection and refuses new ones until online, so
        // the late card reaches the phone only through the board read after it comes back; no Out of reach wait is needed.
        _ = try await home("offline")
        let late = try await home("late-picture-card")
        let lateTitle = try XCTUnwrap(late["title"] as? String)
        _ = try await home("online")
        XCTAssertTrue(cardHeading(lateTitle).waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts[try XCTUnwrap(late["words"] as? String)].waitForPresence(timeout: 10))
        _ = try await home("board-read-held")
        _ = try await home("release-board-read")
        reach("Live", timeout: 20)
        _ = try await home("late-picture-asked")
        picture("card-picture-after-reaching")
        tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(cardHeading(lateTitle).waitForAbsence(timeout: 10))
        // The same after view in both themes supplies the release note's native hero pair.
        let hero = try await home("hero-card")
        showCard(try XCTUnwrap(hero["title"] as? String))
        XCTAssertTrue(app.webViews.staticTexts["Chart for daylight sailing"].waitForPresence(timeout: 10))
        verifyPhoneComposerBounds(app: app)
        picture("cards-hero-light")
        _ = try await home("appearance-dark", budget: displayBudget)
        XCTAssertTrue(app.webViews.staticTexts["Chart for night sailing"].waitForPresence(timeout: 10))
        verifyPhoneComposerBounds(app: app)
        picture("cards-hero-dark")
        _ = try await home("appearance-light", budget: displayBudget)
        // INF-944 item 5 with INF-945's pick: the Mac's row, pinned at the card's foot with no scrolling,
        // the default last at the right and every choice keeping a 44-point touch area.
        let keepChoice = app.buttons["card-action-keep"], waitChoice = app.buttons["card-action-wait"]
        XCTAssertTrue(waitForPhonePress(keepChoice), "The choices sit in view without scrolling")
        XCTAssertTrue(waitForPhonePress(waitChoice))
        // The answered count starts the first line, so the row wraps where its choices do not fit beside it.
        if abs(keepChoice.frame.midY - waitChoice.frame.midY) < 1 {
            XCTAssertLessThan(waitChoice.frame.maxX, keepChoice.frame.minX, "The default is drawn last")
        } else {
            XCTAssertGreaterThan(keepChoice.frame.minY, waitChoice.frame.minY, "The default is drawn last")
            XCTAssertEqual(keepChoice.frame.maxX, waitChoice.frame.maxX, accuracy: 1, "Each line sits at the trailing edge")
        }
        // XCUI reports the 44-point area in fractions of a pixel, such as 43.99999999999994.
        XCTAssertGreaterThanOrEqual(keepChoice.frame.height.rounded(), 44)
        XCTAssertLessThan(keepChoice.frame.width, app.scrollViews["card-scroll"].frame.width / 2, "A choice keeps its own width")
        // INF-944 item 3: a card minimized on the computer leaves the phone's stack.
        // INF-1517, the captain's picks: Home keeps no Minimized menu; the card waits in Tasks under Waiting on you,
        // in its own row since it has no task, and a tap brings it back on Home and on the computer.
        let heroTitle = try XCTUnwrap(hero["title"] as? String)
        _ = try await home("minimize-hero")
        XCTAssertTrue(cardHeading(heroTitle).waitForAbsence(timeout: 10), app.debugDescription)
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        XCTAssertTrue(pager.waitForAbsence(timeout: 10), "Home shows no Minimized menu")
        tab("Tasks")
        let restore = app.buttons.matching(identifier: "minimized-card").matching(NSPredicate(format: "label == %@", heroTitle)).firstMatch
        XCTAssertTrue(restore.waitForPresence(timeout: 10), app.debugDescription)
        // INF-2928 piece 1: Waiting on you always shows its rows, so its header is a label, not a button, as on the Mac.
        XCTAssertLessThan(app.staticTexts["group-waiting"].frame.minY, restore.frame.minY, "It is listed under Waiting on you")
        picture("tasks-minimized")
        tapOnPhone(restore)
        XCTAssertTrue(cardHeading(heroTitle).waitForPresence(timeout: 10), "Its row brings the card back on Home")
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: app.buttons["tab-home"], timeout: 10), .completed)
        let restored = try await home("hero-state", method: "GET")
        let restoredCard = try XCTUnwrap(restored["card"] as? [String: Any])
        XCTAssertNil(restoredCard["minimized"], "The phone brings it back on the computer too")
        // INF-4241: the phone at the largest standard type is the join-read part's to read (testJoinAndRead).
    }
}

/// True when the picture holds both a light and a dark area, as drawn text on its surface does in either appearance;
/// a blank surface is one shade. The half-way gap separates ink from its surface, not a pixel golden.
private func drawsInk(_ image: UIImage) -> Bool {
    guard let pixels = image.cgImage else { return false }
    let picture = CIImage(cgImage: pixels)
    let context = CIContext()
    func shade(_ filter: String) -> Double {
        var rgba = [UInt8](repeating: 0, count: 4)
        let reduced = picture.applyingFilter(filter, parameters: [kCIInputExtentKey: CIVector(cgRect: picture.extent)])
        context.render(reduced, toBitmap: &rgba, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        return rgba.prefix(3).reduce(0.0) { $0 + Double($1) } / (3 * Double(UInt8.max))
    }
    return shade("CIAreaMaximum") - shade("CIAreaMinimum") > 0.5
}
