import XCTest

/// The panels part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3830 piece 2, the captain's entry=tab and layout=column: the computer's panels on a fourth tab, opened with
    /// Command-4, each drawn under its title, with no owner word on the captain's own. Data: the test home's real core serves the fixture panel
    /// (tests/fixtures/phone-panels/phone-tally), its built files and the panel library this checkout builds; the panel reads
    /// the board and the computer's music, shows its store's tally and adds one through its background work; a second fixture
    /// (tests/fixtures/phone-panels/phone-shy) decides for itself whether it shows. Completion: the tab is absent with no
    /// panel, and appears and leaves as the self-deciding panel says it shows and does not; a library file the build did not make leaves the panel's place saying so; the panel draws, follows a write
    /// on the computer, runs one press exactly once, stays folded across a relaunch, shows the computer's stop as a dot on the title's line whose details hold Retry,
    /// starts a message and opens Settings from its own presses, and the tab leaves once the panel is gone. INF-6295: with a rule saved on the test home's real core (`panel-automation-on`),
    /// the app's own Automation panel joins the tab with no owner word and the rule's name, the Tasks and Activity panels
    /// stay out, an iPad on its side draws it from the sidebar's Panels choice, and the tab leaves once the rule is deleted.
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

        // With the library the build made, a fresh launch draws the panel under its title; the captain's own carries no owner word.
        _ = try await home("panel-library-restore")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        tab("Panels", repeatDiscarded: false)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(header.label.contains("TALLY"), "Its title: \(header.label)")
        // The owner word would sit in its own fold button beside the title, so look for it in any element.
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", "yours")).firstMatch.exists,
                       "The captain's own panel names no owner")
        let tally = { (count: Int) in self.app.webViews.staticTexts["Tally \(count)"] }
        XCTAssertTrue(tally(0).waitForPresence(timeout: 60), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format: "label ENDSWITH[c] %@", " tasks")).firstMatch
            .waitForPresence(timeout: 20), "The panel reads the computer's board: \(app.debugDescription)")
        try await appearances("panels", showing: header)

        _ = try await home("panel-write")
        XCTAssertTrue(tally(41).waitForPresence(timeout: 20), app.debugDescription)

        // The panel reads the computer's settings (`settings.current`): this phone says it reads them, so the computer
        // sends the panel at all, and the music turned on there reaches the drawn panel.
        XCTAssertTrue(app.webViews.staticTexts["Music off"].waitForPresence(timeout: 20), app.debugDescription)
        _ = try await home("panel-music-on")
        XCTAssertTrue(app.webViews.staticTexts["Music on"].waitForPresence(timeout: 20), app.debugDescription)

        let add = app.webViews.buttons["Add one"]
        XCTAssertTrue(add.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(add, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForPresence(timeout: 20), app.debugDescription)
        let pressed = try await home("panel-state", method: "GET")
        XCTAssertEqual(pressed["tally"] as? Int, 42, "One press, one call on the computer")

        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForAbsence(timeout: 10), "Folded, the panel's body leaves the column")
        XCTAssertEqual(header.value as? String, "folded")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(header.value as? String, "folded", "The fold survives a relaunch")
        XCTAssertFalse(tally(42).exists)
        picture("panels-folded")
        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(tally(42).waitForPresence(timeout: 60), app.debugDescription)
        // The panel's buttons are pressed while its body is drawn on the Panels tab, before an iPad turns: a press
        // before the body draws reaches no page.
        try await verifyPanelCards(header: header)
        // Before an iPad turns or the page's background work ends: either starts the panel's page again, and an iPad's
        // accessibility can go on naming the ended page's process, so the test reads none of the new page's words.
        try await verifyPanelDraftAndSettings()
        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)

        // In the wide layout (an iPad on its side), Panels is the sidebar's third choice beside the stage.
        if phoneTurnedLayout(app) == .wide {
            XCUIDevice.shared.orientation = .landscapeLeft
            let choice = app.otherElements["phone-sidebar"].buttons["Panels"]
            XCTAssertTrue(choice.waitForPresence(timeout: 20), app.debugDescription)
            tapOnPhone(choice, repeatDiscarded: false)
            XCTAssertTrue(tally(42).waitForPresence(timeout: 60), app.debugDescription)
            picture("panels-ipad-sidebar")
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(panelsTab.waitForPresence(timeout: 20), app.debugDescription)
        }

        try await pressPhoneKey("4", modifiers: .command, in: app)
        XCTAssertTrue(header.waitForPresence(timeout: 20), app.debugDescription)

        // Background work that ended shows a dot on the title's line; its details hold the computer's own sentence and
        // Retry, which starts the work again there and takes the dot away.
        _ = try await home("panel-quit")
        let mark = app.buttons["panel-status-phone-tally"]
        XCTAssertTrue(mark.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertLessThanOrEqual(abs(mark.frame.midY - header.frame.midY), 1,
                                 "The dot sits on the title's line: \(mark.frame) beside \(header.frame)")
        picture("panels-stopped")
        tapOnPhone(mark, repeatDiscarded: false)
        let retry = app.buttons["panel-status-phone-tally/retry"]
        XCTAssertTrue(retry.waitForPresence(timeout: 20), app.debugDescription)
        picture("panels-stopped-details")
        tapOnPhone(retry, repeatDiscarded: false)
        XCTAssertTrue(mark.waitForAbsence(timeout: 30), app.debugDescription)
        let retried = try await home("panel-state", method: "GET")
        XCTAssertTrue(retried["stopped"] is NSNull, "Retry lifted the stop on the computer")

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

        // docs/runbooks.md, "Panels": a runbook of the captain's own that is on shows its panel here too, under the
        // runbook's name, and turned off on the computer, its panel and the tab leave.
        _ = try await home("panel-runbook-on")
        XCTAssertTrue(panelsTab.waitForPresence(timeout: 30), app.debugDescription)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        let desk = app.buttons["panel-header-phone-desk-reading"]
        XCTAssertTrue(desk.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["The calm interface"].waitForPresence(timeout: 60), app.debugDescription)
        picture("panels-runbook")
        _ = try await home("panel-runbook-off")
        XCTAssertTrue(panelsTab.waitForAbsence(timeout: 30), "The tab leaves once the runbook is off")

        // INF-6295: the app's own panels the computer shows join the tab, drawn from its own panel code, with no owner
        // word; Tasks and Activity stay their own tabs. A saved rule opens the Automation panel there, and the board's
        // tasks and the feed's lines open no Tasks or Activity panel here.
        _ = try await home("panel-automation-on")
        XCTAssertTrue(panelsTab.waitForPresence(timeout: 30), app.debugDescription)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        let automation = app.buttons["panel-header-automation"]
        XCTAssertTrue(automation.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(automation.label.contains("AUTOMATION"), "Its title: \(automation.label)")
        XCTAssertFalse(automation.label.contains("yours"), "No owner word: \(automation.label)")
        // The panel draws each rule as one row button whose label leads with the rule's name.
        let rule = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Morning summary")).firstMatch
        XCTAssertTrue(rule.waitForPresence(timeout: 60), app.debugDescription)
        XCTAssertFalse(app.buttons["panel-header-now"].exists, "Tasks stays its own tab")
        XCTAssertFalse(app.buttons["panel-header-activity"].exists, "Activity stays its own tab")
        // In light and dark, as the release note's picture pair shows it.
        try await appearances("panels-app-automation", showing: automation)
        // In the wide layout, the sidebar's Panels choice shows for an app panel alone and draws it.
        if phoneTurnedLayout(app) == .wide {
            XCUIDevice.shared.orientation = .landscapeLeft
            let choice = app.otherElements["phone-sidebar"].buttons["Panels"]
            XCTAssertTrue(choice.waitForPresence(timeout: 20), app.debugDescription)
            tapOnPhone(choice, repeatDiscarded: false)
            XCTAssertTrue(rule.waitForPresence(timeout: 60), app.debugDescription)
            picture("panels-ipad-sidebar-automation")
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(panelsTab.waitForPresence(timeout: 20), app.debugDescription)
        }
        _ = try await home("panel-automation-off")
        XCTAssertTrue(panelsTab.waitForAbsence(timeout: 30), "The tab leaves once no rule is saved")
    }

    /// INF-3830 piece 3, done when "A panel's title-row buttons draw beside its fold and work", "A card a panel puts up
    /// shows on Home, and its buttons work" and "A panel's tap on a task opens that task's record on the phone". Data: the
    /// test home's real core serves the fixture panel (tests/fixtures/phone-panels/phone-tally) with its note card view,
    /// a title-row button that puts the note up and one that asks the panel, and the test home's seeded task. INF-4241 runs it inside the panels part, on the panel that part drew, rather than
    /// in a part of its own with its own launch and join. Completion:
    /// the asking button reaches the panel's own code once a press and leaves with its body when folded; the note shows
    /// on Home from the button and from the panel's own press, follows a write on the computer to its panel's store while
    /// it shows (INF-4339), counts a second press as a revision and leaves on Hide; the card's tap opens the seeded task's
    /// record on Tasks, and the panel's opens the task.
    private func verifyPanelCards(header: XCUIElement) async throws {
        // The title row: the note button and the asking button beside the fold; a press of the asking one reaches the
        // panel's own code once.
        let note = app.buttons["panel-button-phone-tally-note"]
        let mark = app.buttons["panel-button-phone-tally-mark"]
        XCTAssertTrue(note.waitForPresence(timeout: 20) && mark.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(note.label, "Open the note")
        picture("panel-title-buttons")
        tapOnPhone(mark, repeatDiscarded: false)
        XCTAssertTrue(app.webViews.staticTexts["Marked 1"].waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(mark.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(note.exists, "A button that puts up a card stays while the panel is folded")
        tapOnPhone(header, repeatDiscarded: false)
        XCTAssertTrue(mark.waitForPresence(timeout: 10), app.debugDescription)

        tapOnPhone(note, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: app.buttons["tab-home"], timeout: 10),
                       .completed, "The note shows on Home")
        let card = app.otherElements["panel-card-phone-tally-note"]
        XCTAssertTrue(card.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Tally note"].exists, app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Note from button"].waitForPresence(timeout: 60), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Put up 1 times"].exists, app.debugDescription)
        // The note in light and dark, as the release note's picture pair shows it.
        try await appearances("panel-card-home", showing: app.staticTexts["panel-card-title"])

        // INF-4339: the card's page hears the computer's pushes while it shows, as its panel's page does, so a write on
        // the computer to the store it reads reaches it without the card being put up again.
        XCTAssertTrue(app.webViews.staticTexts["Noted 0"].waitForPresence(timeout: 20), app.debugDescription)
        _ = try await home("panel-note")
        XCTAssertTrue(app.webViews.staticTexts["Noted 1"].waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Put up 1 times"].exists, "The same card, not put up again: \(app.debugDescription)")
        picture("panel-card-hears-push")

        tapOnPhone(app.webViews.buttons["Open the record"], repeatDiscarded: false)
        let recordTitle = app.staticTexts["task-record-title"]
        XCTAssertTrue(recordTitle.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(recordTitle.label, "Check the phone connection")
        picture("panel-opens-record")
        let close = app.buttons["close-record"]
        tapOnPhone(close)
        XCTAssertTrue(close.waitForAbsence(timeout: 10), app.debugDescription)

        try await pressPhoneKey("4", modifiers: .command, in: app)
        tapOnPhone(note, repeatDiscarded: false)
        XCTAssertTrue(app.webViews.staticTexts["Put up 2 times"].waitForPresence(timeout: 60), app.debugDescription)
        tapOnPhone(app.buttons["panel-card-hide"], repeatDiscarded: false)
        XCTAssertTrue(card.waitForAbsence(timeout: 10), app.debugDescription)

        try await pressPhoneKey("4", modifiers: .command, in: app)
        let raise = app.webViews.buttons["Raise a note"]
        XCTAssertTrue(raise.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(raise, repeatDiscarded: false)
        XCTAssertTrue(app.webViews.staticTexts["Note from the panel"].waitForPresence(timeout: 60), app.debugDescription)
        XCTAssertTrue(app.otherElements["panel-card-phone-tally-card-1"].exists, app.debugDescription)
        try await pressPhoneKey("4", modifiers: .command, in: app)
        let openTask = app.webViews.buttons["Open the task"]
        XCTAssertTrue(openTask.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(openTask, repeatDiscarded: false)
        XCTAssertTrue(recordTitle.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(recordTitle.label, "Check the phone connection")
        tapOnPhone(close)
        XCTAssertTrue(close.waitForAbsence(timeout: 10), app.debugDescription)
    }

    /// INF-6295's piece B, the captain's "Build them now as a second piece": `point.draft` and `point.openSettings` work
    /// on the phone for every panel, the captain's own included. Data: the fixture panel's two presses, a draft's words and
    /// Settings' Automation, on the test home's real core. Completion: the draft's words wait unsent in Home's message box,
    /// and Settings opens on Automation, its section's own page with Back.
    private func verifyPanelDraftAndSettings() async throws {
        try await pressPhoneKey("4", modifiers: .command, in: app)
        let draft = app.webViews.buttons["Start a message"]
        XCTAssertTrue(draft.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(draft, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: app.buttons["tab-home"], timeout: 10),
                       .completed, "The draft starts the message on Home")
        let box = keyboardInput("message-box")
        let drafted = NSPredicate(format: "value == %@", "Tell me about the tally")
        XCTAssertEqual(waitForPhonePredicate(drafted, object: box, timeout: 10), .completed, "\(String(describing: box.value))")
        picture("panel-draft-message")

        try await pressPhoneKey("4", modifiers: .command, in: app)
        let settings = app.webViews.buttons["Open Automation"]
        XCTAssertTrue(settings.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(settings, repeatDiscarded: false)
        let back = app.buttons["phone-settings-back"]
        XCTAssertTrue(back.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Automation"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["phone-settings-general"].exists, "Settings opens on the section, not its list")
        picture("panel-opens-settings")
        tapOnPhone(app.buttons["close-phone-settings"])
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForAbsence(timeout: 10), app.debugDescription)
    }
}
