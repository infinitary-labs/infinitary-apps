import XCTest

/// The panels part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3830 piece 2, the captain's entry=tab and layout=column: the computer's panels on a fourth tab, opened with
    /// Command-4, each drawn under its title and owner word. Data: the test home's real core serves the fixture panel
    /// (tests/fixtures/phone-panels/phone-tally), its built files and the panel library this checkout builds; the panel reads
    /// the board, shows its store's tally and adds one through its background work; a second fixture
    /// (tests/fixtures/phone-panels/phone-shy) decides for itself whether it shows. Completion: the tab is absent with no
    /// panel, and appears and leaves as the self-deciding panel says it shows and does not; a library file the build did not make leaves the panel's place saying so; the panel draws, follows a write
    /// on the computer, runs one press exactly once, stays folded across a relaunch, shows the computer's stop with Retry,
    /// and the tab leaves once the panel is gone.
    func testPanelsTab() async throws {
        try await launchFresh()
        try await join()
        let panelsTab = app.buttons["tab-panels"]
        XCTAssertFalse(panelsTab.exists, "With no panel on the computer, the bar is as it was")

        // A library file that is not the one the build made is never run: the panel's place says so.
        _ = try await home("panel-library-tamper")
        _ = try await home("panel-seed")
        XCTAssertTrue(panelsTab.waitForPresence(timeout: 20), app.debugDescription)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: panelsTab, timeout: 10), .completed,
                       "Command-4 opens Panels")
        let header = app.buttons["panel-header-phone-tally"]
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)
        let failed = app.otherElements["panel-failed-phone-tally"]
        XCTAssertTrue(failed.waitForPresence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.webViews.staticTexts["Tally 0"].exists, "The panel's code did not run")
        picture("panels-could-not-open")

        // With the library the build made, a fresh launch draws the panel under its title and owner word.
        _ = try await home("panel-library-restore")
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        tab("Panels", repeatDiscarded: false)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(header.label.contains("TALLY") && header.label.contains("yours"), "Its title and owner word: \(header.label)")
        let tally = { (count: Int) in self.app.webViews.staticTexts["Tally \(count)"] }
        XCTAssertTrue(tally(0).waitForPresence(timeout: 60), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format: "label ENDSWITH[c] %@", " tasks")).firstMatch
            .waitForPresence(timeout: 20), "The panel reads the computer's board: \(app.debugDescription)")
        try await appearances("panels", showing: header)

        // A write on the computer reaches the drawn panel without reopening the tab.
        _ = try await home("panel-write")
        XCTAssertTrue(tally(41).waitForPresence(timeout: 20), app.debugDescription)

        // A press runs on the computer exactly once.
        let add = app.webViews.buttons["Add one"]
        XCTAssertTrue(add.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(add, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForPresence(timeout: 20), app.debugDescription)
        let pressed = try await home("panel-state", method: "GET")
        XCTAssertEqual(pressed["tally"] as? Int, 42, "One press, one call on the computer")

        // A fold stays after the app is closed and opened again.
        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForAbsence(timeout: 10), "Folded, the panel's body leaves the column")
        XCTAssertEqual(header.value as? String, "folded")
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(header.value as? String, "folded", "The fold survives a relaunch")
        XCTAssertFalse(tally(42).exists)
        picture("panels-folded")
        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForPresence(timeout: 60), app.debugDescription)

        // On a wide iPad, Panels is the sidebar's third choice beside the stage.
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            let choice = app.otherElements["phone-sidebar"].buttons["Panels"]
            XCTAssertTrue(choice.waitForPresence(timeout: 20), app.debugDescription)
            tapOnPhone(choice, repeatDiscarded: false)
            XCTAssertTrue(tally(42).waitForPresence(timeout: 60), app.debugDescription)
            picture("panels-ipad-sidebar")
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(panelsTab.waitForPresence(timeout: 20), app.debugDescription)
        }

        // Background work that ended shows the computer's own line and Retry, which starts it again there.
        _ = try await home("panel-quit")
        let retry = app.buttons["panel-retry-phone-tally"]
        XCTAssertTrue(retry.waitForPresence(timeout: 20), app.debugDescription)
        picture("panels-stopped")
        tapOnPhone(retry, repeatDiscarded: false)
        XCTAssertTrue(retry.waitForAbsence(timeout: 30), app.debugDescription)
        let retried = try await home("panel-state", method: "GET")
        XCTAssertTrue(retried["stopped"] is NSNull, "Retry lifted the stop on the computer")

        // Once the computer has no panel to draw, the tab leaves and Home shows.
        _ = try await home("panel-remove")
        XCTAssertTrue(panelsTab.waitForAbsence(timeout: 20), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: app.buttons["tab-home"], timeout: 10),
                       .completed, "Home shows once Panels leaves")

        // The captain's answer W3 (c), with no other panel, after the library steps so its page reads only the library
        // the build made: a panel that decides for itself runs out of sight, and the tab counts it only once it says it
        // shows. Its own code says so when the computer writes its store, and the tab leaves when it says not.
        _ = try await home("panel-shy-seed")
        // Its page ran on the phone and said it does not show: the computer heard its word.
        _ = try await home("panel-shy-said-hidden")
        XCTAssertFalse(panelsTab.exists, "A panel that has said it does not show opens no tab")
        _ = try await home("panel-shy-show")
        XCTAssertTrue(panelsTab.waitForPresence(timeout: 30), app.debugDescription)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["panel-header-phone-shy"].waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Shy is showing"].waitForPresence(timeout: 30), app.debugDescription)
        _ = try await home("panel-shy-hide")
        XCTAssertTrue(panelsTab.waitForAbsence(timeout: 30), "The tab leaves once its only panel says it does not show")
        _ = try await home("panel-shy-remove")
    }
}
