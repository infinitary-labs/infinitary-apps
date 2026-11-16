import XCTest

/// The fold part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-4241 piece 8: INF-4210's promises in the iPhone Duo's four flat sizes, with the hinge the phone check moves
    /// (scripts/phone-hinge.ts). Closed the Duo shows the one column, upright and on its side alike, since its outer
    /// screen keeps the app upright as it turns; open like a book the sidebar beside the stage reaching the fold. Open on
    /// its side is left out: the simulated Duo keeps the open app in the book's orientation as it turns.
    /// Split at the fold shows in Settings → Appearance once the Duo has opened, with no launch setting, and turned off
    /// it narrows the sidebar to the iPad's share; Settings stays Settings as the Duo closes under it. On a device with
    /// no hinge the same part checks the column, the strip in the bar on its side, and that Split at the fold never shows.
    /// Data: this part's own fresh app and test home. Completion: each size's layout read from the window's size classes
    /// and shape (`PhoneShownLayout`), and the sidebar's and the card's frames. Platform: the iPhone and the Duo; the
    /// Duo starts closed, as its row of PHONE_PARTS says. Resources: this part's own simulator; no account or signing.
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
        foldLayout(.wide, "open like a book")
        let split = foldSidebarWidth("open like a book")
        // Open on its side is not checked here: turned, the simulated Duo keeps the app's scene on its inner screen in
        // the book's orientation (SpringBoard sets the same interface orientation), so the window never turns.
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
        let share = foldSidebarWidth("open with Split at the fold off")
        XCTAssertLessThan(share, split, "Off, the sidebar keeps the iPad's share, narrower than the fold's \(split) points")
        _ = try await home("hinge-closed")
        app.activate()
        foldLayout(.column, "closed")
        turnClosedDuo(.landscapeLeft)
        foldLayout(.column, "closed on its side again")
        turnClosedDuo(.portrait)
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
    private func foldLayout(_ layout: PhoneShownLayout, _ size: String) {
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
            XCTAssertTrue(phoneSidebar(app).waitForPresence(timeout: 10), "\(size): the sidebar shows: \(app.debugDescription)")
        } else {
            XCTAssertTrue(phoneSidebar(app).waitForAbsence(timeout: 10), "\(size): no sidebar: \(app.debugDescription)")
            XCTAssertTrue(app.buttons["tab-home"].waitForPresence(timeout: 10), "\(size): the tab strip shows: \(app.debugDescription)")
        }
    }

    /// The sidebar's width, once its frame holds still, with the card on the stage beside it.
    private func foldSidebarWidth(_ size: String) -> CGFloat {
        let sidebar = phoneSidebar(app), card = app.scrollViews["card-scroll"].firstMatch
        waitForSteadyTarget(sidebar)
        XCTAssertTrue(card.waitForPresence(timeout: 10), "\(size): the card shows: \(app.debugDescription)")
        XCTAssertLessThanOrEqual(sidebar.frame.maxX, card.frame.minX, "\(size): the card sits on the stage beside the sidebar")
        return sidebar.frame.width
    }

    /// Settings → Appearance through the bar's Settings button.
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
