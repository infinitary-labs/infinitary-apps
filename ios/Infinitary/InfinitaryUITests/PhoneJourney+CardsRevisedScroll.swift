import XCTest

/// The cards-revised-scroll part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-6865, the captain: "having a problem with this card - i can't scroll further up, so i can't see the action
    /// buttons". INF-6866 found the cause: a long card revised in place into folded sections with marked new parts, while
    /// the captain read it at its end, left the body frame an inner scroller of a stale height that took the swipe.
    /// Data: a crewmate's long decision as card 2 of 3, with figures, two questions, six sections and three choices,
    /// revised in place with its new parts marked and every section open, then, while read at its end, revised in place
    /// again into folded sections with its new parts marked.
    /// Completion, after each version: the body's first words sit at the body's top at rest and at the card's end, a
    /// swipe moves the whole body, and every choice can be pressed at rest or at the card's end. Each step's problems are
    /// gathered and reported together, so a failing run names every step that broke.
    func testRevisedCardScrollsToItsChoices() async throws {
        try await launchJoined()
        let fixture = try await home("revised-scroll-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let first = try XCTUnwrap(fixture["first"] as? String)
        let actions = try XCTUnwrap(fixture["actions"] as? [String])
        showCard(title)
        waitForShownBodyRevealed()
        var problems: [String] = []
        problems += revisedScrollProblems("1 first shown", first: first, actions: actions)

        try await reviseInPlace("marked")
        problems += revisedScrollProblems("2 revised with its new parts marked, read from its top", first: first, actions: actions)

        // The captain reads down to the card's end, and the crewmate folds every section while it is there.
        settleRevisedScroll(up: true)
        try await reviseInPlace("folded-marked")
        problems += revisedScrollProblems("3 revised into folded sections with new parts marked, read at its end",
                                          first: first, actions: actions)

        XCTAssertTrue(problems.isEmpty, problems.joined(separator: "\n"))
    }

    /// The crewmate's revision in place, once the phone draws it: its revised line names the new version's changes.
    private func reviseInPlace(_ version: String) async throws {
        let revised = app.staticTexts["card-revised"]
        let before = revised.exists ? revised.label : ""
        _ = try await home("revised-scroll-card-revise", body: #"{"version":"\#(version)"}"#)
        let changed = NSPredicate { _, _ in revised.exists && revised.label != before }
        XCTAssertEqual(waitForPhonePredicate(changed, object: nil, timeout: 20), .completed,
                       "The \(version) revision never reached the card\n\(app.debugDescription)")
        waitForShownBodyRevealed()
        // The scroller, not the body: a body several screens tall is too large for a target reading's screenshot.
        waitForSteadyTarget(app.scrollViews["card-scroll"].firstMatch)
    }

    /// The shown card after one step, read where it rests and again at its end; the card is left where it rested.
    private func revisedScrollProblems(_ step: String, first: String, actions: [String]) -> [String] {
        let scroll = app.scrollViews["card-scroll"].firstMatch
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        let words = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", first)).firstMatch
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        var problems: [String] = []
        let say = { (text: String) in problems.append("\(step): \(text)") }
        guard scroll.waitForPresence(timeout: 10), body.waitForPresence(timeout: 10) else {
            return ["\(step): no scroller or body\n\(app.debugDescription)"]
        }
        waitForSteadyTarget(scroll)
        let foot = pager.exists ? pager.frame.minY : app.frame.maxY
        func pressable(_ id: String) -> Bool {
            let button = app.buttons[id]
            return button.exists && button.isHittable && button.frame.minY >= scroll.frame.minY - 0.5 && button.frame.maxY <= foot + 0.5
        }
        // The words slide up inside the frame when its own scroller takes the swipe, so they sit above the body's top.
        func wordsAtTop(_ place: String) {
            if !words.exists { say("the body's first words are not in the body \(place)"); return }
            let gap = words.frame.minY - body.frame.minY
            if gap < -1 { say(String(format: "the body's first words sit %.0f pt above the body's own top %@", -gap, place)) }
        }
        wordsAtTop("at rest")
        let atRest = Set(actions.filter { pressable("card-action-\($0)") })
        let bodyAtRest = body.frame.minY
        picture("revised-scroll \(step) at rest")
        settleRevisedScroll(up: true)
        picture("revised-scroll \(step) at the end")
        wordsAtTop("at the card's end")
        if atRest.count < actions.count && abs(body.frame.minY - bodyAtRest) < 1 {
            say("a swipe up did not move the card's body, and not every choice shows at rest")
        }
        for id in actions where !atRest.contains(id) && !pressable("card-action-\(id)") {
            say("card-action-\(id) cannot be pressed at rest or at the card's end, at \(app.buttons["card-action-\(id)"].frame), card foot \(foot)")
        }
        print(String(format: "REVISED SCROLL %@: scroll %@ body at rest %.1f, at the end %@, inner scroll areas %d -> %@",
                     step, "\(scroll.frame)", bodyAtRest, "\(body.frame)", body.scrollViews.count,
                     problems.isEmpty ? "ok" : problems.joined(separator: "; ")))
        settleRevisedScroll(up: false)
        return problems
    }

    /// Swipes the card's scroller to one end, until the body holds still between swipes.
    private func settleRevisedScroll(up: Bool) {
        let scroll = app.scrollViews["card-scroll"].firstMatch
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        for _ in 0..<14 {
            let before = body.exists ? body.frame.minY : scroll.frame.minY
            up ? scroll.swipeUp() : scroll.swipeDown()
            waitForSteadyTarget(scroll)
            if abs((body.exists ? body.frame.minY : scroll.frame.minY) - before) < 1 { return }
        }
    }
}
