import XCTest

/// The fold part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-4241 piece 8: INF-4210's promises in the iPhone Duo's four flat sizes, with the hinge the phone check moves
    /// (scripts/phone-hinge.ts). Closed the Duo shows the one column, upright and on its side alike, since its outer
    /// screen keeps the app upright as it turns; open like a book the sidebar beside the stage reaching the fold. INF-4539:
    /// the open Duo turns onto its side and back like a book, each way in turn, and Home's card, and INF-4838 the message
    /// box, come back to the same place and width each time; the hinge helper turns it, since the simulated Duo ignores XCUIDevice's turns when open.
    /// Split at the fold shows in Settings → Appearance once the Duo has opened, with no launch setting, and turned off
    /// it narrows the sidebar to the iPad's share; Settings stays Settings as the Duo closes under it. On a device with
    /// no hinge the same part checks the column, the strip in the bar on its side, and that Split at the fold never shows.
    /// Data: this part's own fresh app and test home. Completion: each size's layout read from the window's size classes
    /// and shape (`PhoneShownLayout`), and the sidebar's, the card's and the message box's frames. Platform: the iPhone
    /// and the Duo; the Duo starts closed, as its row of PHONE_PARTS says. Resources: this part's own simulator; no account or signing.
    func testLayoutFollowsTheFold() async throws {
        try await launchJoined()
        let duo = try await home("hinge", method: "GET")["hinge"] as? String
        XCTAssertTrue(duo == nil || duo == "closed", "A Duo starts this part closed, not \(duo ?? "")")
        foldLayout(.column, "upright")
        if duo == nil {
            turnForProbe(.landscapeLeft)
            foldLayout(.onItsSide, "on its side")
            turnForProbe(.portrait)
        } else {
            turnClosedDuo(.landscapeLeft)
            foldLayout(.column, "closed on its side")
            turnClosedDuo(.portrait)
        }
        foldLayout(.column, "upright again")
        guard duo != nil else {
            try openFoldAppearance()
            XCTAssertFalse(app.switches["phone-fold-split"].exists, "A device that never folds has no Split at the fold")
            return
        }
        _ = try await home("hinge-open")
        app.activate()
        foldLayout(.wide, "open like a book", sidebar: false)
        _ = try await home("empty-cards")
        assertDuoPanelShown("Without a card")
        XCTAssertFalse(app.buttons["toggle-phone-panels"].exists)
        try await cardArrivesWhileTyping()
        let hero = try await home("hero-card")
        let title = try XCTUnwrap(hero["title"] as? String)
        showCard(title)
        try await cardFirstOnDuo(title: title)
        let split = foldSidebarWidth("open like a book")
        try await turnsKeepTheCard()
        // The Duo opened in this launch, so Split at the fold shows with no launch setting; off, the iPad's share.
        try openFoldAppearance()
        let toggle = app.switches["phone-fold-split"]
        XCTAssertTrue(toggle.waitForPresence(timeout: 10), "Split at the fold shows once the Duo opened: \(app.debugDescription)")
        XCTAssertEqual(toggle.value as? String, "1", "Split at the fold starts on")
        tapOnPhone(toggle)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == '0'"), object: toggle, timeout: 10), .completed,
                       "A tap turns Split at the fold off")
        // INF-4210: a keyboard notice with no height while the Duo closes leaves Settings showing.
        _ = try await home("hinge-closed")
        app.activate()
        foldLayout(.column, "closed with Settings open")
        XCTAssertTrue(toggle.waitForPresence(timeout: 10), "Settings stays Settings as the Duo closes: \(app.debugDescription)")
        _ = try await home("hinge-open")
        app.activate()
        foldLayout(.wide, "open with Split at the fold off")
        closeFoldSettings()
        XCTAssertFalse(app.buttons["toggle-phone-panels"].exists, "The unsplit Duo keeps its previous layout")
        let share = foldSidebarWidth("open with Split at the fold off")
        XCTAssertLessThan(share, split, "Off, the sidebar keeps the iPad's share, narrower than the fold's \(split) points")
        _ = try await home("turn-side-left")
        app.activate()
        waitForSidePose()
        foldLayout(.column, "on its side with Split at the fold off")
        XCTAssertFalse(app.buttons["toggle-phone-panels"].exists)
        // The simulated Duo keeps this turn when its hinge closes, which would leave its outer screen on its side.
        _ = try await home("turn-book")
        app.activate()
        foldLayout(.wide, "back like a book with Split at the fold off")
        _ = try await home("hinge-closed")
        app.activate()
        foldLayout(.column, "closed")
        turnClosedDuo(.landscapeLeft)
        foldLayout(.column, "closed on its side again")
        turnClosedDuo(.portrait)
    }

    /// INF-4838: the real saved reply and the existing card stack exercise the flat Duo's card-first layout.
    /// The folded and shown frames distinguish the two layouts; keyboard activation must show the actual sidebar.
    private func cardFirstOnDuo(title: String) async throws {
        let toggle = app.buttons["toggle-phone-panels"]
        let card = app.scrollViews["card-scroll"].firstMatch
        let box = app.textFields["message-box"].firstMatch
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        let reply = app.buttons["last-turn-reply"].firstMatch
        XCTAssertTrue(toggle.waitForPresence(timeout: 10), app.debugDescription)
        assertDuoPanelFolded("A card starts with panels folded", book: true)
        waitForSteadyTarget(card)
        let foldedBook = card.frame
        try await checkTuckedReply(box: box, reply: reply, card: card)
        waitForSteadyTarget(pager)
        XCTAssertLessThan(pager.frame.midX, box.frame.midX, "The pager stands beside the message box")
        XCTAssertTrue(pager.frame.minY < box.frame.maxY && box.frame.minY < pager.frame.maxY, "Both occupy the same row")
        try await appearances("duo-card-first-book", showing: cardHeading(title), activeWindow: true)

        _ = try await home("turn-side-left")
        app.activate()
        waitForSidePose()
        let done = app.navigationBars.buttons["dismiss-phone-keyboard"]
        XCTAssertTrue(done.waitForAbsence(timeout: 10), "The keyboard stays dismissed through the side turn")
        waitForSteadyTarget(card)
        let foldedSide = card.frame
        XCTAssertGreaterThan(foldedSide.width, app.windows.firstMatch.frame.width * 0.9, "On its side the card uses the full stage")
        assertDuoPanelFolded("The card takes the stage on its side")
        picture("duo-card-first-side", activeWindow: true)
        // Use the long card already sent during typing: its scroll viewport fills the space it gets.
        showCard(duoLongCardTitle)
        waitForShownBodyRevealed()
        let foldedViewport = try steadyDuoViewport(card)
        let size = app.buttons["card-size"].firstMatch
        tapOnPhone(size)
        // The composer keeps its draft while hidden, but its field must not be usable.
        let boxHidden = NSPredicate { _, _ in !box.exists || (!box.isEnabled && !box.isHittable) }
        XCTAssertEqual(waitForPhonePredicate(boxHidden, object: nil, timeout: 10), .completed,
                       "Maximize makes the main message box unavailable")
        assertDuoPanelFolded("Maximize keeps the sidebar folded")
        let maximizedViewport = try steadyDuoViewport(card, whereHeight: { $0 > foldedViewport.height })
        XCTAssertGreaterThan(maximizedViewport.height, foldedViewport.height, "Maximize uses the room the message box leaves")
        picture("duo-card-maximized-side", activeWindow: true)
        tapOnPhone(size)
        let boxUsable = NSPredicate { _, _ in box.exists && box.isEnabled && box.isHittable }
        XCTAssertEqual(waitForPhonePredicate(boxUsable, object: nil, timeout: 10), .completed,
                       "Restore makes the main message box usable again")
        assertDuoPanelFolded("Restore keeps the sidebar folded")

        // As in crew browsing, send one Tab and read the app's selection, not system focus.
        XCTAssertEqual(toggle.value as? String, "0", "Show panels starts without keyboard selection")
        try await pressDuoKey("tab")
        let selected = NSPredicate(format: "value == '1'")
        guard waitForPhonePredicate(selected, object: toggle, timeout: 10) == .completed else {
            XCTFail("Tab reaches Show panels and draws its focus ring")
            return
        }
        picture("duo-show-panels-keyboard-focus", activeWindow: true)
        try await pressDuoKey("return")
        assertDuoPanelShown("Return shows the sidebar")
        let shownViewport = try steadyDuoViewport(card, whereHeight: { $0 < foldedViewport.height })
        XCTAssertLessThan(shownViewport.height, foldedViewport.height, "Showing the upper panel returns the card to its page")
        print("Duo on its side: folded viewport \(foldedViewport), shown viewport \(shownViewport)")
        picture("duo-panels-shown-side", activeWindow: true)

        let previous = app.buttons["previous-card"].firstMatch, next = app.buttons["next-card"].firstMatch
        let count = pager.label
        tapOnPhone(next.isEnabled ? next : previous)
        let moved = NSPredicate(format: "label != %@", count)
        XCTAssertEqual(waitForPhonePredicate(moved, object: pager, timeout: 10), .completed, "The pager moved to another card")
        assertDuoPanelShown("Showing panels lasts across cards")
        let arrival = try await home("merge-news")
        showCard(try XCTUnwrap(arrival["title"] as? String))
        assertDuoPanelShown("A new card does not fold explicitly shown panels")
        _ = try await home("turn-book")
        app.activate()
        foldLayout(.wide, "back like a book with panels shown")
        waitForSteadyTarget(card)
        XCTAssertLessThan(card.frame.width, foldedBook.width, "Showing the panel narrows the card to the other page")
        print("Duo like a book: folded card \(foldedBook), shown card \(card.frame)")
        picture("duo-panels-shown-book", activeWindow: true)
        // The automatic fold waits for the panel's keyboard to close; panels shown by choice outlast it.
        focusForPhoneTyping(phoneSidebar(app).textFields["task-search"], in: app)
        try await dismissKeyboardForProbe()
        assertDuoPanelShown("Panels shown by choice stay open after the panel's keyboard closes")
        tapOnPhone(toggle)
        assertDuoPanelFolded("Fold panels hides the sidebar again", book: true)
        tapOnPhone(toggle)
        assertDuoPanelShown("The original split remains available for the turn regression")
    }

    private var duoLongCardTitle: String { "The whole season's harbour log" }

    /// Read the scroll viewport without sampling the Duo's inactive main display or its offscreen card content.
    private func steadyDuoViewport(_ card: XCUIElement, whereHeight fits: @escaping (CGFloat) -> Bool = { _ in true }) throws -> CGRect {
        let window = app.windows.firstMatch.frame
        var steady = PhoneSteadyReading<CGRect>()
        var settled: CGRect?
        let still = NSPredicate { _, _ in
            guard let frame = (try? card.snapshot())?.frame, !frame.isEmpty,
                  window.intersects(frame), frame.height <= window.height, fits(frame.height) else {
                return steady.read(nil)
            }
            guard steady.read(frame) else { return false }
            settled = frame
            return true
        }
        XCTAssertEqual(waitForPhonePredicate(still, object: nil, timeout: 10), .completed,
                       "The Duo card scroll viewport did not settle at the expected height")
        return try XCTUnwrap(settled)
    }

    /// The default panel folds only after its keyboard closes. Show panels is a different, lasting choice.
    private func cardArrivesWhileTyping() async throws {
        let panel = phoneSidebar(app)
        let search = panel.textFields["task-search"]
        pullDownOnPhone(panel.scrollViews["tasks-list"])
        XCTAssertTrue(search.waitForPresence(timeout: 10), "Tasks search opens in the panel")
        focusForPhoneTyping(search, in: app)
        search.typeText("connection")
        XCTAssertTrue(app.keyboards.firstMatch.waitForPresence(timeout: 10))
        _ = try await home("heavy-card")
        XCTAssertTrue(cardHeading(duoLongCardTitle).waitForPresence(timeout: 10), "The card arrives while search is open")
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "hasKeyboardFocus == true"), object: search, timeout: 10),
                       .completed, "A new card does not take editing focus from Tasks search")
        XCTAssertEqual(search.value as? String, "connection")
        print("Duo typing: search \(search.frame), keyboard \(app.keyboards.firstMatch.frame), panel \(panel.frame)")
        picture("duo-panel-typing-new-card", activeWindow: true)
        try await dismissKeyboardForProbe()
        assertDuoPanelFolded("After typing, the default panel folds", book: true)
        picture("duo-panel-folded-after-typing", activeWindow: true)
    }

    private func waitForSidePose() {
        let tall = NSPredicate { object, _ in
            guard let window = (object as? XCUIApplication)?.windows.firstMatch else { return false }
            return window.exists && window.frame.height > window.frame.width
        }
        XCTAssertEqual(waitForPhonePredicate(tall, object: app, timeout: 15), .completed)
    }

    /// INF-5183: on the open Duo, typeKey gives its key a keyboard bound to one display and BackBoard finds that key no
    /// destination, so the app never receives it. The test home presses `key` once instead, as an attached keyboard
    /// does and naming no display (scripts/phone-hinge.ts), and answers where BackBoard sent it. The key must reach
    /// Infinitary before the journey reads what the app did with it.
    private func pressDuoKey(_ key: String) async throws {
        let result = try await home("key-\(key)")
        XCTAssertEqual(result["outcome"] as? String, "delivered", "The \(key) key must reach Infinitary: \(result)")
    }

    private func checkTuckedReply(box: XCUIElement, reply: XCUIElement, card: XCUIElement) async throws {
        let fixture = try await home("talk-fixture")
        let words = try XCTUnwrap(fixture["text"] as? String)
        focusForPhoneTyping(box, in: app)
        box.typeText(words)
        tapOnPhone(app.buttons["send-message"])
        _ = try await home("talk-sent")
        XCTAssertTrue(reply.waitForPresence(timeout: 10), "A new reply arrives above the message box")
        if app.keyboards.firstMatch.exists { try await dismissKeyboardForProbe() }
        waitForSteadyTarget(card)
        picture("duo-reply-arrived", activeWindow: true)
        // Return must not press Show panels behind the Conversation, even if Tab had selected it.
        // As before the side pose's Tab, read the app's own selection before the one key, which turns it over.
        let toggle = app.buttons["toggle-phone-panels"]
        XCTAssertTrue(toggle.waitForPresence(timeout: 10), "Show panels is back once the keyboard has left")
        XCTAssertEqual(toggle.value as? String, "0", "Show panels starts without keyboard selection")
        try await pressDuoKey("tab")
        let selected = NSPredicate(format: "value == '1'")
        guard waitForPhonePredicate(selected, object: toggle, timeout: 10) == .completed else {
            XCTFail("Tab selects Show panels before opening the Conversation")
            return
        }
        tapOnPhone(reply)
        let close = app.buttons["close-conversation"]
        XCTAssertTrue(close.waitForPresence(timeout: 10), "The reply reader covers Home")
        try await pressDuoKey("return")
        tapOnPhone(close)
        XCTAssertTrue(close.waitForAbsence(timeout: 10), "Done closes the Conversation")
        assertDuoPanelFolded("Return did not show panels behind the Conversation", book: true)
        XCTAssertEqual(toggle.value as? String, "1", "Show panels is still selected when the Conversation closes")
        try await pressDuoKey("escape")
        let unselected = NSPredicate(format: "value == '0'")
        XCTAssertEqual(waitForPhonePredicate(unselected, object: toggle, timeout: 10), .completed,
                       "Escape clears the selection after the Conversation closes, before Home receives another touch")
        // The touch that tucks the reply stays the card's own: on a choice's words it picks that choice as well.
        let answered = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", phoneAnsweredFormPattern)).firstMatch
        XCTAssertFalse(answered.exists, "The card reads answered before any pick")
        let choice = app.webViews.staticTexts["North Basin"].firstMatch
        XCTAssertTrue(choice.waitForPresence(timeout: 10), "The card shows its choices: \(app.debugDescription)")
        tapOnPhone(choice)
        XCTAssertTrue(reply.waitForAbsence(timeout: 10), "A card touch tucks the reply")
        XCTAssertTrue(answered.waitForPresence(timeout: 10), "The card took the touch that tucked the reply: \(app.debugDescription)")
        tapOnPhone(box)
        XCTAssertTrue(reply.waitForPresence(timeout: 10), "Tapping the message box brings the reply back")
        if app.keyboards.firstMatch.exists { try await dismissKeyboardForProbe() }
        tapOnPhone(card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)))
        XCTAssertTrue(reply.waitForAbsence(timeout: 10), "The next card touch tucks it again")
    }

    /// INF-4539: TestFlight 0.16.0 narrowed Home's card from 338 to 239 points and pushed it right on each turn from the
    /// Duo's side back to the book pose, since the column kept a fold inset read in the middle of the turn. So the open Duo
    /// turns onto its side and back four times, each side twice, and the card's frame like a book matches the first one.
    /// INF-4838: the message box under the sidebar kept a fold inset read mid-turn and shrank to about half the sidebar
    /// after every such turn, so its frame like a book matches the first one too.
    /// The test home turns it once each time and reads the inner screen back (scripts/phone-hinge.ts).
    /// INF-4838: iOS drew a long card's words larger in the wider card on its side than like a book, beside a side panel
    /// at one size, until the card's page set `text-size-adjust`. So the card is the test home's long one, and on its
    /// side, wider, its short line keeps the width it has like a book; the line fits on one line in both, so its width
    /// reads its size.
    private func turnsKeepTheCard() async throws {
        let long = try await home("long-text-card")
        let title = try XCTUnwrap(long["title"] as? String), words = try XCTUnwrap(long["line"] as? String)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 15), "The long card shows: \(app.debugDescription)")
        let card = app.scrollViews["card-scroll"].firstMatch
        let box = app.textFields["message-box"].firstMatch
        waitForSteadyTarget(card)
        waitForSteadyTarget(box)
        let first = card.frame, firstBox = box.frame
        let line = card.webViews.staticTexts[words]
        XCTAssertTrue(line.waitForPresence(timeout: 20), "Like a book the card shows its words: \(app.debugDescription)")
        waitForSteadyTarget(line)
        let narrow = line.frame.width
        for turn in 1...4 {
            _ = try await home(turn.isMultiple(of: 2) ? "turn-side-right" : "turn-side-left")
            app.activate()
            let tall = NSPredicate { app, _ in
                guard let window = (app as? XCUIApplication)?.windows.firstMatch, window.exists else { return false }
                return window.frame.height > window.frame.width
            }
            XCTAssertEqual(waitForPhonePredicate(tall, object: app, timeout: 15), .completed,
                           "Turn \(turn): on its side the window stands tall, not \(app.windows.firstMatch.frame)")
            if turn == 1 {
                waitForSteadyTarget(card)
                waitForSteadyTarget(line)
                XCTAssertGreaterThan(card.frame.width, first.width + 100,
                                     "On its side the card is wider than like a book, \(first.width) points: \(card.frame)")
                XCTAssertEqual(line.frame.width, narrow, accuracy: 1,
                               "The card's short line draws at one size in the narrow card and the wide one: \(line.frame)")
            }
            _ = try await home("turn-book")
            app.activate()
            foldLayout(.wide, "turn \(turn) back like a book")
            waitForSteadyTarget(card)
            XCTAssertEqual(card.frame.minX, first.minX, accuracy: 1, "Turn \(turn): the card starts where it did, \(first)")
            XCTAssertEqual(card.frame.width, first.width, accuracy: 1, "Turn \(turn): the card keeps its width, \(first)")
            waitForSteadyTarget(box)
            XCTAssertEqual(box.frame.minX, firstBox.minX, accuracy: 1, "Turn \(turn): the message box starts where it did, \(firstBox)")
            XCTAssertEqual(box.frame.width, firstBox.width, accuracy: 1, "Turn \(turn): the message box keeps its width, \(firstBox)")
        }
    }

    /// Turns a closed Duo. SpringBoard keeps the app's scene upright on the Duo's outer screen, so nothing on the screen
    /// moves; the turn is read back from the device, and the app is read once it holds still.
    private func turnClosedDuo(_ orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        app.activate()
        XCTAssertEqual(XCUIDevice.shared.orientation, orientation, "The closed Duo reports the turn")
        waitForSteadyTarget(app.buttons["computer-details"])
    }

    /// Waits for the app to show `layout`, which a turn or a hinge move changes a moment after it is asked for.
    private func foldLayout(_ layout: PhoneShownLayout, _ size: String, sidebar: Bool = true) {
        let shown = NSPredicate { app, _ in
            guard let window = (app as? XCUIApplication)?.windows.firstMatch, window.exists else { return false }
            let horizontal = window.horizontalSizeClass, vertical = window.verticalSizeClass
            guard horizontal != .unspecified, vertical != .unspecified else { return false }
            return PhoneShownLayout.of(horizontal: horizontal, vertical: vertical,
                                       widerThanTall: window.frame.width > window.frame.height) == layout
        }
        XCTAssertEqual(waitForPhonePredicate(shown, object: app, timeout: 15), .completed,
                       "\(size): the app shows \(layout), not \(phoneShownLayout(app)), in \(app.windows.firstMatch.frame)")
        XCTAssertTrue(app.buttons["computer-details"].waitForPresence(timeout: 10), app.debugDescription)
        if layout == .wide {
            if sidebar {
                XCTAssertTrue(phoneSidebar(app).waitForPresence(timeout: 10), "\(size): the sidebar shows: \(app.debugDescription)")
            } else {
                assertDuoPanelFolded(size, book: true)
            }
        } else {
            XCTAssertTrue(phoneSidebar(app).waitForAbsence(timeout: 10), "\(size): no sidebar: \(app.debugDescription)")
            XCTAssertTrue(app.buttons["tab-home"].waitForPresence(timeout: 10), "\(size): the tab strip shows: \(app.debugDescription)")
        }
    }

    // XCTest can keep a segmented control in its tree after the sidebar folds. Read its actual
    // Activity button, including whether it is enabled, and verify that the card reclaims the panel's space.
    private var duoActivityRail: XCUIElement {
        phoneSidebarRail("Activity", in: phoneSidebar(app)).firstMatch
    }

    private func assertDuoPanelShown(_ situation: String) {
        let activity = duoActivityRail
        let usable = NSPredicate { _, _ in activity.exists && activity.isEnabled && activity.isHittable }
        XCTAssertEqual(waitForPhonePredicate(usable, object: nil, timeout: 10), .completed,
                       "\(situation): the sidebar's Activity button can be used")
    }

    private func assertDuoPanelFolded(_ situation: String, book: Bool = false) {
        let activity = duoActivityRail
        let card = app.scrollViews["card-scroll"].firstMatch
        let window = app.windows.firstMatch
        let folded = NSPredicate { _, _ in
            guard card.exists, window.exists else { return false }
            let frame = card.frame
            let takesPanelRoom = book
                ? frame.minX < window.frame.midX && frame.maxX > window.frame.midX
                : frame.minY < window.frame.midY
            return takesPanelRoom && (!activity.exists || !activity.isEnabled || !activity.isHittable)
        }
        let result = waitForPhonePredicate(folded, object: nil, timeout: 10)
        XCTAssertEqual(result, .completed,
                       "\(situation): Activity cannot be used and the card takes panel space; card \(card.frame), window \(window.frame), Activity \(activity.debugDescription)")
    }

    private func foldSidebarWidth(_ size: String) -> CGFloat {
        let sidebar = phoneSidebar(app), card = app.scrollViews["card-scroll"].firstMatch
        waitForSteadyTarget(sidebar)
        XCTAssertTrue(card.waitForPresence(timeout: 10), "\(size): the card shows: \(app.debugDescription)")
        XCTAssertLessThanOrEqual(sidebar.frame.maxX, card.frame.minX, "\(size): the card sits on the stage beside the sidebar")
        return sidebar.frame.width
    }

    private func openFoldAppearance() throws {
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(appearance)
        XCTAssertTrue(app.segmentedControls["phone-theme"].waitForPresence(timeout: 10), app.debugDescription)
    }

    private func closeFoldSettings() {
        let close = app.buttons["close-phone-settings"]
        XCTAssertTrue(close.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(close)
        XCTAssertTrue(close.waitForAbsence(timeout: 10), app.debugDescription)
    }
}
