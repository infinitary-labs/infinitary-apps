import XCTest

/// The cards-top-bar part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-6136, the captain: "now the header area is sticky and takes a massive vertical space, leaving not much space
    /// for card content, and the bottom action buttons area can't even show. i do appreciate a sticky header but i think
    /// it should limit to only the top bar to provide the minimize button row (whose Y offset seems off too, but
    /// vertically centered on the same line as the text line)".
    /// Data: a crewmate's decision with the tallest head a card draws (task key, place, model, a four-line title and a
    /// revised line), a body several screens long with a required question, three choices and a thread, beside a short
    /// first mate card.
    /// Completion, on an upright iPhone, for both cards, as each first shows and after the thread, a revision and Card, a
    /// choice pressed with the question unanswered, a swipe to the neighbour and back, and a turn onto the side and back:
    /// only a 44-point bar stays in place, the minus's centre sits on its line's centre, the title scrolls away with the
    /// body, and every choice can be pressed at rest or after one scroll to the body's end. Each step's problems are
    /// gathered and reported together, so a failing run names every step that broke.
    func testCardTopBar() async throws {
        try await launchJoined()
        let fixture = try await home("top-bar-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let shortTitle = try XCTUnwrap(fixture["shortTitle"] as? String)
        var problems: [String] = []
        showCard(title)
        waitForShownBodyRevealed()
        problems += topBarProblems("1 first shown")
        // The release note's hero pair: the card at rest, its bar, title and body's start, in both appearances.
        try await appearances("top-bar-hero", showing: app.buttons["put-aside-card"])

        // The thread, the crewmate's revision while it shows, then Card back to the face.
        let cue = app.buttons["thread-cue"]
        XCTAssertTrue(cue.waitForPresence(timeout: 10), app.debugDescription)
        reveal(cue); tapOnPhone(cue)
        let back = app.descendants(matching: .any).matching(identifier: "card-back").firstMatch
        XCTAssertTrue(back.waitForPresence(timeout: 10), app.debugDescription)
        let revised = try await home("top-bar-card-revise")
        let added = try XCTUnwrap(revised["added"] as? String)
        let cardButton = app.buttons["thread-return"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == 'updated'"), object: cardButton, timeout: 20), .completed,
                       app.debugDescription)
        tapOnPhone(cardButton)
        XCTAssertTrue(back.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts[added].waitForPresence(timeout: 10), app.debugDescription)
        problems += topBarProblems("2 thread, revision and Card")

        // A choice pressed with the required question unanswered keeps the card and says the question waits.
        let both = app.buttons["card-action-both"]
        reveal(both); tapOnPhone(both)
        XCTAssertTrue(app.staticTexts["card-error"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(cardHeading(title).exists, "The default choice was sent with its required question unanswered")
        problems += topBarProblems("3 choice with the question unanswered")

        // A swipe to the neighbour, whose short card keeps the same bar, and back.
        cardHeading(title).swipeLeft()
        if !cardHeading(shortTitle).waitForPresence(timeout: 10) { cardHeading(title).swipeRight() }
        XCTAssertTrue(cardHeading(shortTitle).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        problems += topBarProblems("4a the short neighbour")
        cardHeading(shortTitle).swipeRight()
        if !cardHeading(title).waitForPresence(timeout: 10) { cardHeading(shortTitle).swipeLeft() }
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        problems += topBarProblems("4b back from the neighbour")

        // On its side and upright again.
        let minus = app.buttons["put-aside-card"]
        turnPhone(to: .landscapeLeft, in: app, moving: minus)
        picture("top-bar-on-its-side")
        turnPhone(to: .portrait, in: app, moving: minus)
        problems += topBarProblems("5 turned on its side and back")

        XCTAssertTrue(problems.isEmpty, problems.joined(separator: "\n"))
    }

    /// The shown card's layout after one step: what stays in place, where the minus sits and whether every choice can be
    /// pressed; the card is left scrolled back to its top.
    private func topBarProblems(_ step: String) -> [String] {
        let minus = app.buttons["put-aside-card"]
        let key = app.buttons["card-task-key"]
        let title = app.staticTexts["card-title"]
        let scroll = app.scrollViews["card-scroll"].firstMatch
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        guard minus.waitForPresence(timeout: 10), scroll.exists, title.exists else {
            return ["\(step): no minus, scroller or title\n\(app.debugDescription)"]
        }
        settleCardScroll(scroll, body: body, up: false)
        // The card's frame holds the part that stays and the scroller: named card-frame while its choices stay at its foot,
        // and card-scroll, beside its scroller of that name, while they scroll; a frame holding only its scroller is it.
        let frame = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'card-frame' OR (identifier == 'card-scroll' AND elementType != %d)",
            XCUIElement.ElementType.scrollView.rawValue)).firstMatch
        let card = frame.exists ? frame.frame : scroll.frame
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        let visibleFoot = min(card.maxY, pager.exists ? pager.frame.minY : app.frame.maxY)
        let stays = scroll.frame.minY - card.minY
        let atRest = minus.frame
        // The bar's line: the kind of card leads it on every card; a card drawn before the bar named it has its task's key.
        let kind = app.staticTexts["card-kind"]
        let line = kind.exists ? kind.frame.midY : key.exists ? key.frame.midY : title.frame.midY
        var problems: [String] = []
        let say = { (words: String) in problems.append("\(step): \(words)") }
        if abs(stays - 44) > 1 { say(String(format: "%.1f pt stays in place above the scroller, not 44", stays)) }
        if abs(atRest.midY - line) > 1 { say(String(format: "the minus's centre is %.1f pt from its line's centre", atRest.midY - line)) }
        func pressable(_ button: XCUIElement) -> Bool {
            button.exists && button.isHittable && button.frame.minY >= card.minY - 0.5 && button.frame.maxY <= visibleFoot + 0.5
        }
        let choices = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'card-action-'")).allElementsBoundByIndex
        if choices.isEmpty { say("no choice is drawn") }
        let atRestChoices = Set(choices.filter(pressable).map(\.identifier))
        picture("top-bar \(step) at rest")
        settleCardScroll(scroll, body: body, up: true)
        picture("top-bar \(step) at the end")
        if abs(minus.frame.minY - atRest.minY) > 1 {
            say(String(format: "the minus moved %.1f pt as the body scrolled to its end", minus.frame.minY - atRest.minY))
        }
        let bodyTall = body.exists && body.frame.height > scroll.frame.height
        if bodyTall && title.frame.maxY > scroll.frame.minY + 1 { say("the title stayed in view with the body scrolled to its end") }
        for choice in app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'card-action-'")).allElementsBoundByIndex
            where !atRestChoices.contains(choice.identifier) && !pressable(choice) {
            say("\(choice.identifier) cannot be pressed at rest or at the body's end, at \(choice.frame) in a card to \(visibleFoot)")
        }
        let summary = String(format: "TOP BAR %@: card %@ scroll %@ minus %@ line %.1f -> ", step, "\(card)", "\(scroll.frame)", "\(atRest)", line)
        print(summary + (problems.isEmpty ? "ok" : problems.joined(separator: "; ")))
        settleCardScroll(scroll, body: body, up: false)
        return problems
    }

    /// Swipes the card's scroller to one end, until the body holds still between swipes.
    private func settleCardScroll(_ scroll: XCUIElement, body: XCUIElement, up: Bool) {
        for _ in 0..<12 {
            let before = body.exists ? body.frame.minY : scroll.frame.minY
            up ? scroll.swipeUp() : scroll.swipeDown()
            waitForSteadyTarget(scroll)
            if abs((body.exists ? body.frame.minY : scroll.frame.minY) - before) < 1 { return }
        }
    }
}
