import XCTest

/// The project-filter part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2820 piece 2, the captain's approved plan: "the phone's Filter button and sheet, Tasks, the tag row,
    /// Activity, the crew's light, Panels and messages follow a project focus saved on the phone per computer."
    /// Data: three projects (tests/helpers/phoneProjectFilter.ts), each with its tasks, a tag and an Activity line, one
    /// task in south-pier waiting on the captain, and the Panels fixture that reads the board.
    /// Completion: a pick in the Filter sheet narrows Tasks, its tag row and Activity to north-pier and shows the focus
    /// row on every tab, counting the one task waiting elsewhere, whose pill opens the sheet again; the panel hears the
    /// project; a message sent then carries it; a relaunch keeps the focus; after the ×, a message carries none, and a
    /// relaunch keeps every project shown and the panel hears none; Shift-Command-P opens the sheet on the checked row
    /// and the arrows and Return pick; Escape closes it; the row's × shows every project again.
    func testProjectFilter() async throws {
        try await launchJoined()
        let fixture = try await home("project-filter-fixture")
        // The Panels fixture reads the board, so it hears the focus (`view.focusedProjectId`).
        _ = try await home("panel-seed")
        let projects = try XCTUnwrap(fixture["projects"] as? [[String: Any]])
        XCTAssertEqual(projects.count, 3, "\(fixture)")
        func field(_ index: Int, _ name: String) throws -> String { try XCTUnwrap(projects[index][name] as? String) }
        let north = try field(0, "id"), northName = try field(0, "name")

        let filter = app.buttons["project-filter"]
        XCTAssertTrue(filter.waitForPresence(timeout: 20), "Two projects or more: Filter shows\n\(app.debugDescription)")
        XCTAssertEqual(filter.value as? String, "All projects")
        XCTAssertFalse(app.otherElements["project-focus-row"].exists, "All projects: no focus row")
        // Home draws its crew scene only on an empty stage, so the home's note and south-pier's decision are put aside;
        // the decision still waits on the captain, and its crewmate shows the light the focus sets. The decision is put
        // aside only once the stage has shown it and marked it seen, which also clears its new-card notice, so the order
        // never depends on which comes first.
        let aside = app.buttons["put-aside-card"]
        XCTAssertTrue(aside.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(aside)
        let decision = app.staticTexts.matching(NSPredicate(format: "identifier == 'card-title' AND label CONTAINS 'south pier'")).firstMatch
        XCTAssertTrue(decision.waitForPresence(timeout: 10), "South-pier's decision takes the stage\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["card-new"].waitForAbsence(timeout: 10), "The stage marks the decision seen\n\(app.debugDescription)")
        tapOnPhone(aside)
        XCTAssertTrue(aside.waitForAbsence(timeout: 10), "Both cards are put aside\n\(app.debugDescription)")
        let crewmate = app.buttons["crew-task-project-filter-spr-0"]
        XCTAssertTrue(crewmate.waitForPresence(timeout: 20), "South-pier's waiting crewmate shows on Home\n\(app.debugDescription)")
        picture("1-all-projects")

        // A pick applies at once and closes the sheet.
        tapOnPhone(filter)
        let row = app.buttons["project-filter-\(north)"]
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["project-filter-all-projects"].isSelected, "All projects is the checked row")
        for index in 1..<3 { XCTAssertTrue(app.buttons["project-filter-\(try field(index, "id"))"].exists, app.debugDescription) }
        picture("2-filter-sheet")
        tapOnPhone(row)
        XCTAssertTrue(row.waitForAbsence(timeout: 10), "A pick closes the sheet")
        focused(on: northName, elsewhere: 1)
        XCTAssertEqual(filter.value as? String, northName)
        XCTAssertTrue(crewmate.exists, "Focused on north-pier, south-pier's crewmate stays on Home")
        picture("3-home-focused")

        narrowed()
        tab("Activity")
        // Activity words a report's line as "Reported: <its words>", so each line is found inside its label.
        func activityLine(_ words: String) -> XCUIElement {
            app.staticTexts.matching(NSPredicate(format: "identifier == 'activity-text' AND label CONTAINS %@", words)).firstMatch
        }
        XCTAssertTrue(activityLine(try field(0, "line")).waitForPresence(timeout: 10), app.debugDescription)
        for index in 1..<3 { XCTAssertFalse(activityLine(try field(index, "line")).exists, "Another project's line leaves") }
        XCTAssertTrue(app.otherElements["project-focus-row"].exists, "The focus row shows on every tab")
        picture("5-activity-focused")
        tab("Panels")
        XCTAssertTrue(app.webViews.staticTexts["Focused on \(north)"].waitForPresence(timeout: 60),
                      "A panel that reads the board hears the phone's project\n\(app.debugDescription)")
        // The pill opens Filter on the focused project's checked row.
        tapOnPhone(app.buttons["project-focus-pill"])
        XCTAssertTrue(row.waitForPresence(timeout: 10), "The pill opens Filter\n\(app.debugDescription)")
        XCTAssertTrue(row.isSelected, "The focused project is the checked row")
        tapOnPhone(app.buttons["close-project-filter"])
        XCTAssertTrue(row.waitForAbsence(timeout: 10), app.debugDescription)

        // A message written while focused carries the project.
        tab("Home")
        let messages = try XCTUnwrap(fixture["messages"] as? [String: String])
        let message = try await send(try XCTUnwrap(messages["focused"]), heard: "project-filter-sent")
        XCTAssertEqual(message["focusedProjectId"] as? String, north, "The message carries the phone's project: \(message)")

        // Kept on the phone for this computer through a relaunch.
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        focused(on: northName, elsewhere: 1)

        // The iPad on its side keeps the release note's hero pair: Tasks narrowed under the focus row.
        if phoneTurnedLayout(app) == .wide {
            turnForProbe(.landscapeLeft)
            // The wide layout lists Tasks in its sidebar, with no tab strip. north-pier's tasks wait in Backlog, which
            // opens folded after the relaunch, so it is opened for the rows and the picture.
            let backlog = phoneSidebar(app).buttons["group-backlog"]
            XCTAssertTrue(backlog.waitForPresence(timeout: 10), app.debugDescription)
            tapOnPhone(backlog)
            XCTAssertTrue(app.buttons["task-project-filter-npr-0"].waitForPresence(timeout: 10), app.debugDescription)
            try await appearances("6-tasks-on-its-side", showing: app.buttons["project-focus-pill"])
            turnForProbe(.portrait)
            tab("Home")
        }

        // The × shows every project.
        tapOnPhone(app.buttons["project-focus-clear"])
        XCTAssertTrue(app.otherElements["project-focus-row"].waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertEqual(filter.value as? String, "All projects")
        tab("Tasks")
        XCTAssertTrue(app.buttons["task-project-filter-spr-0"].waitForPresence(timeout: 10), "All projects lists south-pier's task")
        // At All projects a message carries no project, and a relaunch keeps every project shown.
        tab("Home")
        let unfocused = try await send(try XCTUnwrap(messages["all"]), heard: "project-filter-sent-all")
        XCTAssertNil(unfocused["focusedProjectId"], "At All projects the message carries no project: \(unfocused)")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(filter.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(filter.value as? String, "All projects", "The focus stays let go after a relaunch")
        XCTAssertFalse(app.otherElements["project-focus-row"].exists, "No focus row after a relaunch at All projects")
        tab("Tasks")
        XCTAssertTrue(app.buttons["task-project-filter-spr-0"].waitForPresence(timeout: 10), "Tasks lists every project after the relaunch")
        tab("Panels")
        XCTAssertTrue(app.webViews.staticTexts["Every project"].waitForPresence(timeout: 60),
                      "At All projects the panel hears no project\n\(app.debugDescription)")

        // From the keyboard: Shift-Command-P opens the sheet on the checked row, Escape closes it, and the arrows and
        // Return pick. Focus is read by what the keys do, as the Settings journeys read it. Every computer keeps its
        // Scratch project beside the three seeded, so the rows the keys move through are read from the open sheet, top
        // to bottom: from All projects, the checked row, one Down and Return pick the first project listed. As
        // PhoneKeys owns, Xcode emits the physical Return for LF, not CR; Escape goes through the test home, since
        // XCTest's typist sends no event for it.
        let all = app.buttons["project-filter-all-projects"]
        func listed() -> [String] {
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'project-filter-' AND identifier != %@", all.identifier))
                .allElementsBoundByIndex.sorted { $0.frame.minY < $1.frame.minY }.map(\.label)
        }
        app.typeKey("p", modifierFlags: [.command, .shift])
        XCTAssertTrue(all.waitForPresence(timeout: 10), "Shift-Command-P opens Filter\n\(app.debugDescription)")
        waitForSteadyTarget(all)
        try await pressKeyThroughHome("escape")
        XCTAssertTrue(all.waitForAbsence(timeout: 10), "Escape closes Filter")
        XCTAssertEqual(filter.value as? String, "All projects", "Escape picks nothing")
        app.typeKey("p", modifierFlags: [.command, .shift])
        XCTAssertTrue(all.waitForPresence(timeout: 10), app.debugDescription)
        waitForSteadyTarget(all)
        let order = listed()
        XCTAssertGreaterThanOrEqual(order.count, 3, app.debugDescription)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(all.waitForAbsence(timeout: 10), "Return picks and closes Filter")
        XCTAssertEqual(filter.value as? String, order[0], "Down from All projects picks the first project listed")
        // All projects is also the first row, so the same keys with the first project checked tell the checked row
        // from the first: Down from it picks the second project listed.
        app.typeKey("p", modifierFlags: [.command, .shift])
        XCTAssertTrue(all.waitForPresence(timeout: 10), app.debugDescription)
        waitForSteadyTarget(all)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(all.waitForAbsence(timeout: 10), "Return picks and closes Filter")
        XCTAssertEqual(filter.value as? String, order[1], "The sheet opens on the checked row, \(order[0])")
        tapOnPhone(app.buttons["project-focus-clear"])
        XCTAssertTrue(app.otherElements["project-focus-row"].waitForAbsence(timeout: 10), app.debugDescription)
    }

    /// The focus row under the bar names `name` and how many tasks wait on the captain in other projects.
    private func focused(on name: String, elsewhere: Int) {
        let pill = app.buttons["project-focus-pill"]
        XCTAssertTrue(pill.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(pill.label.hasPrefix(name), pill.label)
        XCTAssertEqual(app.staticTexts["project-focus-elsewhere"].label, "\(elsewhere) waiting elsewhere")
        XCTAssertTrue(app.buttons["project-focus-clear"].exists, app.debugDescription)
    }

    /// Tasks and its tag row hold north-pier's alone: its rows and tag, never another project's or the waiting task.
    private func narrowed() {
        tab("Tasks")
        let list = app.scrollViews["tasks-list"]
        XCTAssertTrue(list.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["task-project-filter-spr-0"].exists, "The task waiting in south-pier leaves")
        pullDownOnPhone(list)
        let search = app.textFields["task-search"]
        XCTAssertTrue(search.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(tagChipNamed("pilings").waitForPresence(timeout: 10), "The tag row offers north-pier's tag")
        XCTAssertFalse(tagChipNamed("lamps").exists, "The tag row leaves out south-pier's tag")
        XCTAssertFalse(tagChipNamed("tables").exists, "The tag row leaves out tide-tables' tag")
        // Words open every group, so a folded Backlog shows its rows; every title holds "the".
        focusForPhoneTyping(search, in: app); search.typeText("the")
        for index in 0..<2 {
            XCTAssertTrue(app.buttons["task-project-filter-npr-\(index)"].waitForPresence(timeout: 10), app.debugDescription)
        }
        XCTAssertFalse(app.buttons["task-project-filter-tid-0"].exists, "tide-tables' task leaves")
        XCTAssertFalse(app.buttons["task-project-filter-spr-0"].exists, "south-pier's task leaves")
        picture("4-tasks-focused")
        tapOnPhone(app.buttons["close-task-search"])
        XCTAssertTrue(search.waitForAbsence(timeout: 10), app.debugDescription)
    }

    /// Types `words` in the message box and sends them, returning the message as the computer received it (`heard`).
    private func send(_ words: String, heard: String) async throws -> [String: Any] {
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(words)
        tapOnPhone(app.buttons["send-message"])
        let message = try await home(heard)
        if app.navigationBars.buttons["dismiss-phone-keyboard"].exists { try await dismissKeyboardForProbe() }
        return message
    }

    private func tagChipNamed(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "tag-chip-", name)).firstMatch
    }
}
