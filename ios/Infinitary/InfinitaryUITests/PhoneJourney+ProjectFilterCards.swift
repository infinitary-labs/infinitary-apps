import XCTest

/// The project-filter-cards part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2820 piece 3, the captain's answer "Held back until you pick their project or All projects, as on your Mac":
    /// while the phone is focused on a project, Home holds back the cards about other projects' tasks; picking All
    /// projects brings them back in their place, the one that arrived while held still new; a notification's tap shows a
    /// held card without moving the focus, until the focus changes.
    /// Data: the project-filter part's three projects (tests/helpers/phoneProjectFilter.ts), with the test home's note
    /// about no task and south-pier's decision on Home, and two later south-pier decisions the home sends while the phone
    /// is focused on north-pier.
    /// Completion: focused on north-pier, Home counts the note alone and the tail one task waiting elsewhere; a south-pier
    /// card that arrives then adds nothing to Home; All projects counts every card, the late one as new; the new-card
    /// notice of a card that arrived while held shows it on Home, drawn and ready to answer, with the focus still on
    /// north-pier; after Show all projects and north-pier again, that card is held once more.
    func testProjectFilterCards() async throws {
        try await launchJoined()
        let fixture = try await home("project-filter-fixture")
        let projects = try XCTUnwrap(fixture["projects"] as? [[String: Any]])
        let north = try XCTUnwrap(projects.first?["id"] as? String), northName = try XCTUnwrap(projects.first?["name"] as? String)
        let filter = app.buttons["project-filter"]
        XCTAssertTrue(filter.waitForPresence(timeout: 20), "Two projects or more: Filter shows\n\(app.debugDescription)")
        let pager = app.buttons["card-pager"]

        // At All projects Home holds the note and south-pier's decision; both are read, so the decision comes back seen.
        // Each is read only once it takes the stage, and the stack may open on either (run 46117747267 opened on the
        // decision and left the note new), so the part shows each in turn and waits for the home's mark of it.
        XCTAssertTrue(pager.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(waitForPhonePager(pager, " of 2", suffix: true), pager.label)
        let decision = cardTitle(containing: "south pier")
        if !decision.exists { tapOnPhone(app.buttons["next-card"]) }
        XCTAssertTrue(decision.waitForPresence(timeout: 10), "South-pier's decision takes the stage\n\(app.debugDescription)")
        _ = try await home("seen-wait", body: decision.label)
        tapOnPhone(app.buttons["next-card"])
        let note = app.staticTexts.matching(NSPredicate(format: "identifier == 'card-title' AND NOT (label CONTAINS 'south pier')")).firstMatch
        XCTAssertTrue(note.waitForPresence(timeout: 10), "The note takes the stage\n\(app.debugDescription)")
        _ = try await home("seen-wait", body: note.label)
        XCTAssertTrue(app.buttons["card-new"].waitForAbsence(timeout: 10), "Both cards are read")
        tapOnPhone(app.buttons["next-card"])
        XCTAssertTrue(decision.waitForPresence(timeout: 10), "South-pier's decision takes the stage again\n\(app.debugDescription)")
        picture("1-home-all-projects")

        // Focused on north-pier, south-pier's decision leaves Home; the note about no task stays.
        pickInFilter(north)
        XCTAssertTrue(app.buttons["project-focus-pill"].waitForPresence(timeout: 20), app.debugDescription)
        // Taken before the checks, so a run without the hold keeps the picture of Home it fails on.
        _ = waitForPhonePager(pager, "1 of 1")
        picture("2-home-focused")
        XCTAssertTrue(decision.waitForAbsence(timeout: 10), "South-pier's decision is held back\n\(app.debugDescription)")
        XCTAssertTrue(waitForPhonePager(pager, "1 of 1"), "Home counts the note alone: \(pager.label)")
        XCTAssertEqual(app.staticTexts["project-focus-elsewhere"].label, "1 waiting elsewhere", "The tail counts the held decision's task")
        // The release note's hero pair: the focused Home in both themes, from this one run.
        try await appearances("hero-home-focused", showing: app.buttons["project-focus-pill"])

        // A south-pier card that arrives while held adds nothing to Home. Its notice on Tasks says the phone has it.
        let postCard = try await home("project-filter-card-post")
        let post = try XCTUnwrap(postCard["title"] as? String)
        tab("Tasks")
        let notice = app.buttons["phone-notice"]
        XCTAssertTrue(notice.waitForPresence(timeout: 20), "The held card's notice shows on Tasks\n\(app.debugDescription)")
        XCTAssertTrue(notice.label.contains(post), notice.label)
        tab("Home")
        XCTAssertTrue(waitForPhonePager(pager, "1 of 1"), "The held arrival adds no card: \(pager.label)")
        XCTAssertFalse(app.buttons["card-new"].exists, "The held arrival adds no NEW count")

        // All projects brings both back in their place: the decision read before stays read, the arrival comes back new.
        pickInFilter("all-projects")
        XCTAssertTrue(app.buttons["project-focus-pill"].waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(waitForPhonePager(pager, " of 3", suffix: true), "All projects counts every card: \(pager.label)")
        let fresh = app.buttons["card-new"]
        XCTAssertTrue(fresh.waitForPresence(timeout: 10), "The card that arrived while held comes back new\n\(app.debugDescription)")
        XCTAssertEqual(fresh.label, "1 new", "Only the arrival is new; the decision read before comes back read")
        picture("3-home-all-projects-again")

        // Focused again on Tasks, a new south-pier card's notice shows it on Home, and the focus stays on north-pier.
        pickInFilter(north)
        XCTAssertTrue(waitForPhonePager(pager, "1 of 1"), pager.label)
        tab("Tasks")
        let hourCard = try await home("project-filter-card-hour")
        let hour = try XCTUnwrap(hourCard["title"] as? String)
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in notice.exists && notice.label.contains(hour) }, object: nil,
                                            timeout: 20) == .completed, "The new card's notice: \(notice.label)")
        tapOnPhone(notice)
        let pointed = cardTitle(containing: hour)
        XCTAssertTrue(pointed.waitForPresence(timeout: 10), "The notice's tap shows the held card\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["project-focus-pill"].label.hasPrefix(northName), "The focus stays on north-pier")
        XCTAssertTrue(waitForPhonePager(pager, " of 2", suffix: true), "Only the card pointed at comes through: \(pager.label)")
        // The pager counts the card before its body draws, and a choice takes a press only once it has, so the picture
        // waits for the choice and shows the card whole rather than an empty body with dimmed choices.
        let choice = app.buttons["card-action-first"]
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in choice.exists && choice.isEnabled }, object: nil, timeout: 10) == .completed,
                      "The pointed card draws its body and takes a choice\n\(app.debugDescription)")
        picture("4-home-pointed")

        // Show all projects, then north-pier again: the card pointed at is held once more.
        tapOnPhone(app.buttons["project-focus-clear"])
        XCTAssertTrue(waitForPhonePager(pager, " of 4", suffix: true), pager.label)
        pickInFilter(north)
        XCTAssertTrue(pointed.waitForAbsence(timeout: 10), "A new focus holds the pointed card again\n\(app.debugDescription)")
        XCTAssertTrue(waitForPhonePager(pager, "1 of 1"), pager.label)
        tapOnPhone(app.buttons["project-focus-clear"])
        XCTAssertTrue(app.buttons["project-focus-pill"].waitForAbsence(timeout: 10), app.debugDescription)
    }

    /// Picks `id` (a project's id, or all-projects) in the Filter sheet, which closes on the pick.
    private func pickInFilter(_ id: String) {
        tapOnPhone(app.buttons["project-filter"])
        let row = app.buttons["project-filter-\(id)"]
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(row)
        XCTAssertTrue(row.waitForAbsence(timeout: 10), "A pick closes the sheet")
    }

    private func cardTitle(containing words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "identifier == 'card-title' AND label CONTAINS %@", words)).firstMatch
    }

    /// Waits for the pager to read `label`, or to end with it when `suffix`; the stack takes the focus in the next update.
    private func waitForPhonePager(_ pager: XCUIElement, _ label: String, suffix: Bool = false) -> Bool {
        waitForPhonePredicate(NSPredicate { _, _ in
            pager.exists && (suffix ? pager.label.hasSuffix(label) : pager.label == label)
        }, object: nil, timeout: 10) == .completed
    }
}
