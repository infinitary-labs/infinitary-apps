import XCTest

/// The settings-pages part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3563, the approved plan and the captain's choices on it: the phone's Settings shows the computer's
    /// Intelligence (the allowance only), Automation (Pause, Resume, Pause all, and a draft turned on after the
    /// computer's review), Usage (read only), Projects and Runbooks, in the computer's own words, and signing in stays
    /// on the computer.
    /// Data: this part's computer starts with three accounts and their allowance readings, two projects, a few weeks
    /// of recorded usage and four automations (tests/helpers/phoneSettings.ts), each written by the app's own writers.
    /// Completion: each page shows what the computer holds; each change asked here is the computer's own afterwards
    /// (`settings-state`); a new allowance reading reaches the open page; the arrows, Return and Command-[ reach and
    /// leave every page. Escape leaves a page too, but XCTest's typist sends the simulator no key event for it, so
    /// no step here presses it.
    /// Resources: this part's own simulator and test home; no account, sign-in or signing material.
    func testSettingsPages() async throws {
        try await launchFresh()
        try await join()
        let start = try await home("settings-state", method: "GET")
        let rules = try XCTUnwrap(start["rules"] as? [String: [String: Any]])
        let morning = try XCTUnwrap(rules["morning"]?["id"] as? String), weekly = try XCTUnwrap(rules["weekly"]?["id"] as? String)
        let draft = try XCTUnwrap(rules["draft"]?["id"] as? String), once = try XCTUnwrap(rules["once"]?["id"] as? String)
        let books = try XCTUnwrap(start["runbooks"] as? [String: Bool])

        // The list: the computer's sections in the computer's order, each row saying its state in the computer's words.
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        let rows = ["general", "appearance", "projects", "intelligence", "runbooks", "usage", "automation", "integrations", "devices"]
            .map { app.buttons["phone-settings-\($0)"] }
        for row in rows { XCTAssertTrue(row.waitForPresence(timeout: 20), "\(row)\n\(app.debugDescription)") }
        for (above, below) in zip(rows, rows.dropFirst()) { XCTAssertLessThan(above.frame.maxY, below.frame.minY + 1, "\(above) sits above \(below)") }
        let on = books.values.filter { $0 }.count
        settingsShows(rows[2], "2 projects")
        settingsShows(rows[3], "3 accounts · 1 needs a sign-in")
        settingsShows(rows[4], "\(on) on · \(books.count - on) off")
        settingsShows(rows[5], "19.00M tokens · Last 30 days")
        settingsShows(rows[6], "1 active · 1 paused")
        try await appearances("settings-pages", showing: rows[3])

        try await settingsIntelligence(from: rows[3])
        try await settingsBackToList()

        // The ring rests where the last page opened, on Intelligence: three rows down is Automation.
        waitForSteadyTarget(rows[6])
        for _ in 0..<3 { app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: []) }
        app.typeKey("\n", modifierFlags: [])
        try await settingsAutomation(morning: morning, weekly: weekly, draft: draft, once: once)
        try await settingsBackToList()

        tapOnPhone(rows[5], repeatDiscarded: false)
        try await settingsUsage()
        try await settingsBackToList()

        waitForSteadyTarget(rows[2])
        tapOnPhone(rows[2], repeatDiscarded: false)
        try await settingsProjects()
        try await settingsBackToList()

        waitForSteadyTarget(rows[4])
        tapOnPhone(rows[4], repeatDiscarded: false)
        try await settingsRunbooks()
        tapOnPhone(app.buttons["close-phone-settings"])
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForAbsence(timeout: 10))
    }

    /// Intelligence: every account in the computer's order with its allowance and its one verdict, nothing to change,
    /// and a new reading on the computer reaching the open page.
    private func settingsIntelligence(from row: XCUIElement) async throws {
        tapOnPhone(row, repeatDiscarded: false)
        let summary = app.staticTexts["intelligence-summary"]
        XCTAssertTrue(summary.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(summary.label, "3 accounts · 1 needs a sign-in")
        let accounts = ["personal", "work", "team"].map { settingsPart("intelligence-account-acct_phone_\($0)") }
        for account in accounts { XCTAssertTrue(account.waitForPresence(timeout: 10), "\(account)\n\(app.debugDescription)") }
        for (above, below) in zip(accounts, accounts.dropFirst()) { XCTAssertLessThan(above.frame.minY, below.frame.minY, "The computer's order") }
        settingsShows(accounts[0], "Personal")
        settingsShows(accounts[0], "Plus · ada@example.com")
        let session = settingsPart("intelligence-meter-session")
        XCTAssertTrue(session.label.hasPrefix("session, 74%"), session.label)
        XCTAssertTrue(settingsPart("intelligence-meter-weekly").label.hasPrefix("weekly, 62%"))
        XCTAssertTrue(settingsPart("intelligence-verdict-acct_phone_personal").exists, "The row's one verdict")
        // An account that waits for a sign-in says where it happens: on the computer.
        XCTAssertEqual(settingsPart("intelligence-sign-in-acct_phone_work").label, "Sign in on Test Mac mini.")
        // A stale reading keeps its last figure.
        XCTAssertTrue(settingsPart("intelligence-meter-credits").label.hasPrefix("credits, 57%"))
        // The captain's choice: the page shows the allowance only. The computer's own card asking for that sign-in
        // waits on the home screen behind this sheet, so the rows are read, not the whole app.
        XCTAssertEqual(app.switches.count, 0, "Nothing on Intelligence changes an account")
        for account in accounts { XCTAssertEqual(account.buttons.count, 0, "An account's row has nothing to press") }
        settingsShows(settingsPart("intelligence-foot"), "Sign-ins stay on Test Mac mini.")
        try await appearances("settings-intelligence", showing: summary)

        // The computer reads its allowance again; the open page follows it with nothing pressed here.
        let later = try await home("settings-allowance")
        let left = try XCTUnwrap(later["session"] as? Int)
        let follows = NSPredicate { _, _ in session.exists && session.label.hasPrefix("session, \(left)%") }
        XCTAssertEqual(waitForPhonePredicate(follows, object: nil, timeout: 30), .completed, session.label)
    }

    /// Automation: each rule's state, Pause by keys, Resume and Pause all by touch, a rule's own page with its run, and
    /// a draft turned on by keys after its review.
    private func settingsAutomation(morning: String, weekly: String, draft: String, once: String) async throws {
        let pauseAll = app.buttons["automation-pause-all"]
        XCTAssertTrue(pauseAll.waitForPresence(timeout: 10), app.debugDescription)
        // Each row: its name, its schedule, then its next run under its term, or its state alone when it has none.
        let rows = [
            (morning, ["Morning summary", "Every day at 8:00 AM", "Next run"]),
            (weekly, ["Check for outdated packages", "Mondays at 9:30 AM", "Paused"]),
            (draft, ["Friday wrap-up", "Fridays at 4:00 PM", "Draft"]),
            (once, ["Release notes reminder", "Once, ", "Done"]),
        ]
        for (id, words) in rows { for said in words { settingsShows(app.buttons["automation-rule-\(id)"], said) } }
        XCTAssertTrue(app.buttons["automation-pause-\(morning)"].exists)
        XCTAssertTrue(app.buttons["automation-resume-\(weekly)"].exists)
        XCTAssertTrue(app.buttons["automation-review-\(draft)"].exists)
        for action in ["pause", "resume", "review"] { XCTAssertFalse(app.buttons["automation-\(action)-\(once)"].exists, "A finished rule has nothing to do") }
        settingsShows(settingsPart("automation-foot"), "Test Mac mini")
        try await appearances("settings-automation", showing: pauseAll)

        // Down rests on the first rule, Down again on its Pause, and Return presses it.
        waitForSteadyTarget(pauseAll)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(app.buttons["automation-resume-\(morning)"].waitForPresence(timeout: 20), app.debugDescription)
        try await settingsKeeps("rules.morning.state", "paused")

        tapOnPhone(app.buttons["automation-resume-\(weekly)"], repeatDiscarded: false)
        XCTAssertTrue(app.buttons["automation-pause-\(weekly)"].waitForPresence(timeout: 20), app.debugDescription)
        try await settingsKeeps("rules.weekly.state", "enabled")

        // Pause all asks once, then pauses what runs.
        waitForSteadyTarget(pauseAll)
        tapOnPhone(pauseAll, repeatDiscarded: false)
        let confirm = app.buttons["automation-pause-all-confirm"].firstMatch
        XCTAssertTrue(confirm.waitForPresence(timeout: 10), app.debugDescription)
        try await settingsKeeps("rules.weekly.state", "enabled")
        waitForSteadyTarget(confirm)
        tapOnPhone(confirm, repeatDiscarded: false)
        XCTAssertTrue(app.buttons["automation-resume-\(weekly)"].waitForPresence(timeout: 20), app.debugDescription)
        try await settingsKeeps("rules.weekly.state", "paused")
        try await settingsKeeps("rules.morning.state", "paused")

        // A rule's own page: its whole name, its state, its project as the computer names it, and the prompt as the
        // first mate gets it.
        let state = app.staticTexts["rule-state"], name = app.staticTexts["phone-settings-page-name"]
        waitForSteadyTarget(app.buttons["automation-rule-\(morning)"])
        tapOnPhone(app.buttons["automation-rule-\(morning)"], repeatDiscarded: false)
        XCTAssertTrue(state.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(state.label, "Paused")
        XCTAssertEqual(name.label, "Morning summary")
        XCTAssertTrue(settingsFact("Project", "Website").waitForPresence(timeout: 10), app.debugDescription)
        let prompt = settingsPart("rule-prompt")
        XCTAssertTrue(prompt.waitForPresence(timeout: 20), app.debugDescription)
        settingsShows(prompt, "Summarize what changed in the project since yesterday. It is ")
        XCTAssertFalse(settingsEveryWord(prompt).contains("{{"), "The prompt names its time, as the first mate gets it")
        XCTAssertTrue(app.buttons["rule-resume"].exists)
        XCTAssertTrue(settingsPart("rule-history-empty").waitForPresence(timeout: 20), app.debugDescription)
        picture("settings-rule")
        try await pressPhoneKey("[", modifiers: .command, in: app)
        XCTAssertTrue(pauseAll.waitForPresence(timeout: 10), app.debugDescription)

        // A rule that ran shows the run, and the prompt as it was sent.
        waitForSteadyTarget(app.buttons["automation-rule-\(once)"])
        tapOnPhone(app.buttons["automation-rule-\(once)"], repeatDiscarded: false)
        XCTAssertTrue(state.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(state.label, "Done")
        XCTAssertEqual(name.label, "Release notes reminder")
        // It ran at its one time, so its prompt names that time, with nothing left to fill in.
        let ran = settingsPart("rule-prompt")
        settingsShows(ran, "Remind me to send the release notes. It is ")
        XCTAssertFalse(settingsEveryWord(ran).contains("{{"), settingsEveryWord(ran))
        let sent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "rule-run-prompt-")).firstMatch
        XCTAssertTrue(sent.waitForPresence(timeout: 20), app.debugDescription)
        let run = app.descendants(matching: .any).matching(NSPredicate(format: "identifier MATCHES %@", "rule-run-[0-9]+")).firstMatch
        XCTAssertFalse(settingsEveryWord(run).contains("Remind me to send the release notes."), "The prompt stays folded until asked for")
        waitForSteadyTarget(sent)
        tapOnPhone(sent, repeatDiscarded: false)
        settingsShows(run, "Remind me to send the release notes. It is ")
        XCTAssertFalse(settingsEveryWord(run).contains("{{"))
        picture("settings-rule-ran")
        try await pressPhoneKey("[", modifiers: .command, in: app)
        XCTAssertTrue(pauseAll.waitForPresence(timeout: 10), app.debugDescription)

        // A draft turns on only from the computer's review: Down rests on Back, Down again on Turn on, Return presses it.
        waitForSteadyTarget(app.buttons["automation-review-\(draft)"])
        tapOnPhone(app.buttons["automation-review-\(draft)"], repeatDiscarded: false)
        let turnOn = app.buttons["review-turn-on"]
        XCTAssertTrue(turnOn.waitForPresence(timeout: 10), app.debugDescription)
        // The review leads with its question, then the rule it is about.
        XCTAssertEqual(name.label, "Turn on this automation?")
        XCTAssertEqual(app.staticTexts["review-rule"].label, "Friday wrap-up")
        XCTAssertTrue(settingsFact("Next runs").waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["review-back"].exists)
        waitUntilEnabled(turnOn)
        try await settingsKeeps("rules.draft.state", "draft")
        waitForSteadyTarget(turnOn)
        picture("settings-review")
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(app.buttons["automation-pause-\(draft)"].waitForPresence(timeout: 20), app.debugDescription)
        try await settingsKeeps("rules.draft.state", "enabled")
        // Making, changing and deleting a rule stay on the computer.
        for words in ["New automation", "Edit", "Delete"] { XCTAssertFalse(app.buttons[words].exists, words) }
    }

    /// Usage: the period's figures in either unit and the period by keys, with nothing to change on the computer.
    private func settingsUsage() async throws {
        let total = settingsPart("usage-total")
        XCTAssertTrue(total.waitForPresence(timeout: 10), app.debugDescription)
        settingsShows(total, "19.00M")
        settingsShows(settingsPart("usage-where-firstmate"), "First mate")
        settingsShows(settingsPart("usage-milestone"), "8 tasks finished")
        XCTAssertEqual(app.switches.count, 0, "Usage only shows")
        waitForSteadyTarget(total)
        picture("settings-usage")
        let unit = app.segmentedControls["usage-unit"]
        tapOnPhone(unit.buttons["Estimated $"], repeatDiscarded: false)
        settingsShows(total, "$29.54")
        // Down rests on the period; the right arrow moves it one along.
        let period = app.segmentedControls["usage-period"]
        XCTAssertTrue(period.buttons["Last 30 days"].isSelected)
        waitForSteadyTarget(total)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
        let all = period.buttons["All recorded time"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in all.isSelected }, object: nil, timeout: 20), .completed, app.debugDescription)
        settingsShows(total, "$29.54")
    }

    /// Projects: the list, then one project's standing choices, each kept by the computer as it is chosen.
    private func settingsProjects() async throws {
        let website = app.buttons["project-phone-website"]
        XCTAssertTrue(website.waitForPresence(timeout: 10), app.debugDescription)
        settingsShows(website, "Website")
        settingsShows(app.buttons["project-phone-app"], "Field notes")
        settingsShows(settingsPart("projects-foot"), "Test Mac mini")
        waitForSteadyTarget(website)
        picture("settings-projects")
        tapOnPhone(website, repeatDiscarded: false)
        let rigor = app.segmentedControls["project-rigor"]
        XCTAssertTrue(rigor.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(rigor.buttons["Default"].isSelected)
        XCTAssertEqual(app.staticTexts["phone-settings-page-name"].label, "Website")
        waitForSteadyTarget(rigor)
        picture("settings-project")

        // Five stops down is Rigor (three places changes can go, then Ask before merging); the right arrow chooses Careful.
        for _ in 0..<5 { app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: []) }
        app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
        let careful = rigor.buttons["Careful"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in careful.isSelected }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("projects.phone-website.rigor", "reviewed")

        let asks = app.switches["project-asks"]
        XCTAssertEqual(asks.value as? String, "1", "It asks before merging")
        tapOnPhone(asks, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in asks.value as? String == "0" }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("projects.phone-website.autonomy", "true")

        let local = app.buttons["project-delivery-local-only"]
        tapOnPhone(local, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in local.isSelected }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("projects.phone-website.delivery", "local-only")

        // A cost limit of its own starts at the app's amount; a typed one is kept as typed.
        let cost = app.segmentedControls["project-cost"]
        tapOnPhone(cost.buttons["Own amount"], repeatDiscarded: false)
        let amount = app.textFields["project-cost-amount"]
        XCTAssertTrue(amount.waitForPresence(timeout: 20), app.debugDescription)
        let save = app.buttons["project-cost-save"]
        XCTAssertFalse(save.isEnabled, "Nothing to save until the amount changes")
        focusForPhoneTyping(amount, in: app)
        amount.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "75")
        waitUntilEnabled(save)
        tapOnPhone(save, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in !save.isEnabled }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("projects.phone-website.costLimit.usd", "75")
        XCTAssertFalse(settingsPart("phone-settings-problem").exists, "Every change went through")

        try await pressPhoneKey("[", modifiers: .command, in: app)
        XCTAssertTrue(website.waitForPresence(timeout: 10), app.debugDescription)
    }

    /// Runbooks: each runbook's switch is the computer's own, by touch and by keys.
    private func settingsRunbooks() async throws {
        let first = app.switches["runbook-sequences"], second = app.switches["runbook-delivery"]
        XCTAssertTrue(second.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(second.value as? String, "1")
        settingsShows(settingsPart("runbooks-foot"), "Test Mac mini")
        waitForSteadyTarget(second)
        picture("settings-runbooks")
        tapOnPhone(second, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in second.value as? String == "0" }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("runbooks.delivery", "false")
        // Down rests on the first runbook, and Return turns its switch.
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in first.value as? String == "0" }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("runbooks.sequences", "false")
        app.typeKey("\n", modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in first.value as? String == "1" }, object: nil, timeout: 20), .completed, app.debugDescription)
        try await settingsKeeps("runbooks.sequences", "true")
        try await settingsBackToList()
    }

    /// Command-[ from a section's page, back to the list of sections.
    private func settingsBackToList() async throws {
        let back = app.buttons["phone-settings-back"]
        XCTAssertTrue(back.waitForPresence(timeout: 10), app.debugDescription)
        waitForSteadyTarget(back)
        try await pressPhoneKey("[", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["phone-settings-general"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(back.waitForAbsence(timeout: 10), "Back leaves the page once its transition finishes")
    }

    /// A part of a page by its name, whatever kind of element draws it.
    private func settingsPart(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// A page's fact by its term, and its value when one is given: a fact reads as its term, then its value.
    private func settingsFact(_ term: String, _ value: String? = nil) -> XCUIElement {
        let says = value.map { NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", term, $0) }
            ?? NSPredicate(format: "label BEGINSWITH %@", term)
        return app.descendants(matching: .any).matching(says).firstMatch
    }

    /// Every word a part shows: its own and those of the texts inside it.
    private func settingsEveryWord(_ element: XCUIElement) -> String {
        guard element.exists else { return "" }
        return ([element.label] + element.descendants(matching: .staticText).allElementsBoundByIndex.map(\.label)).joined(separator: "\n")
    }

    /// The part says these words, now or once the computer's answer reaches it.
    private func settingsShows(_ element: XCUIElement, _ words: String, file: StaticString = #filePath, line: UInt = #line) {
        let says = NSPredicate { _, _ in self.settingsEveryWord(element).contains(words) }
        XCTAssertEqual(waitForPhonePredicate(says, object: nil, timeout: 20), .completed,
                       "\(words) is not in \(settingsEveryWord(element))\n\(app.debugDescription)", file: file, line: line)
    }

    /// What the computer holds at a dotted path of `settings-state`, read once after the page showed the change.
    private func settingsKeeps(_ path: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        var value: Any? = try await home("settings-state", method: "GET")
        for key in path.split(separator: ".") { value = (value as? [String: Any])?[String(key)] }
        let kept: String
        if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { kept = number.boolValue ? "true" : "false" }
        else if let number = value as? NSNumber { kept = number.stringValue }
        else if let words = value as? String { kept = words }
        else { kept = String(describing: value) }
        XCTAssertEqual(kept, expected, path, file: file, line: line)
    }
}
