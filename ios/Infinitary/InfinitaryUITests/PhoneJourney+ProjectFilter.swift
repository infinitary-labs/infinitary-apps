import XCTest

/// The project-filter part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2820 piece 2, the captain's approved plan: "the phone's Filter button and sheet, Tasks, the tag row,
    /// Activity, the crew's light, Panels and messages follow a project focus saved on the phone per computer."
    /// Data: three projects (tests/helpers/phoneProjectFilter.ts), each with its tasks, a tag and an Activity line, and
    /// one task in south-pier waiting on the captain.
    /// Completion: a pick in the Filter sheet narrows Tasks, its tag row and Activity to north-pier and shows the focus
    /// row on every tab, counting the one task waiting elsewhere, whose pill opens the sheet again; a message sent then
    /// carries the project; a relaunch keeps the focus; Shift-Command-P opens the sheet on the checked row and the
    /// arrows and Return pick; Escape closes it; the row's × shows every project again.
    func testProjectFilter() async throws {
        try await launchJoined()
        let fixture = try await home("project-filter-fixture")
        let projects = try XCTUnwrap(fixture["projects"] as? [[String: Any]])
        XCTAssertEqual(projects.count, 3, "\(fixture)")
        func field(_ index: Int, _ name: String) throws -> String { try XCTUnwrap(projects[index][name] as? String) }
        let north = try field(0, "id"), northName = try field(0, "name")

        let filter = app.buttons["project-filter"]
        XCTAssertTrue(filter.waitForPresence(timeout: 20), "Two projects or more: Filter shows\n\(app.debugDescription)")
        XCTAssertEqual(filter.value as? String, "All projects")
        XCTAssertFalse(app.otherElements["project-focus-row"].exists, "All projects: no focus row")
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
        picture("3-home-focused")

        narrowed()
        tab("Activity")
        XCTAssertTrue(app.staticTexts[try field(0, "line")].waitForPresence(timeout: 10), app.debugDescription)
        for index in 1..<3 { XCTAssertFalse(app.staticTexts[try field(index, "line")].exists, "Another project's line leaves") }
        XCTAssertTrue(app.otherElements["project-focus-row"].exists, "The focus row shows on every tab")
        picture("5-activity-focused")
        // The pill opens Filter on the focused project's checked row.
        tapOnPhone(app.buttons["project-focus-pill"])
        XCTAssertTrue(row.waitForPresence(timeout: 10), "The pill opens Filter\n\(app.debugDescription)")
        XCTAssertTrue(row.isSelected, "The focused project is the checked row")
        tapOnPhone(app.buttons["close-project-filter"])
        XCTAssertTrue(row.waitForAbsence(timeout: 10), app.debugDescription)

        // A message written while focused carries the project.
        tab("Home")
        let words = try XCTUnwrap(fixture["message"] as? String)
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(words)
        tapOnPhone(app.buttons["send-message"])
        let message = try await home("project-filter-sent")
        XCTAssertEqual(message["focusedProjectId"] as? String, north, "The message carries the phone's project: \(message)")
        if app.navigationBars.buttons["dismiss-phone-keyboard"].exists { try await dismissKeyboardForProbe() }

        // Kept on the phone for this computer through a relaunch.
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        focused(on: northName, elsewhere: 1)

        // The iPad on its side keeps the release note's hero pair: Tasks narrowed under the focus row.
        if phoneTurnedLayout(app) == .wide {
            turnForProbe(.landscapeLeft)
            tab("Tasks")
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

        // From the keyboard: Shift-Command-P opens the sheet on the checked row, Escape closes it, and the arrows and
        // Return pick.
        let all = app.buttons["project-filter-all-projects"]
        app.typeKey("p", modifierFlags: [.command, .shift])
        XCTAssertTrue(all.waitForPresence(timeout: 10), "Shift-Command-P opens Filter\n\(app.debugDescription)")
        XCTAssertTrue(all.hasFocus, "The sheet opens on the checked row")
        app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
        XCTAssertTrue(all.waitForAbsence(timeout: 10), "Escape closes Filter")
        XCTAssertEqual(filter.value as? String, "All projects", "Escape picks nothing")
        app.typeKey("p", modifierFlags: [.command, .shift])
        XCTAssertTrue(all.waitForPresence(timeout: 10), app.debugDescription)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "hasFocus == true"), object: row, timeout: 10), .completed,
                       "Down moves to the first project")
        app.typeKey("\r", modifierFlags: [])
        XCTAssertTrue(all.waitForAbsence(timeout: 10), "Return picks and closes Filter")
        focused(on: northName, elsewhere: 1)
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

    private func tagChipNamed(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "tag-chip-", name)).firstMatch
    }
}
