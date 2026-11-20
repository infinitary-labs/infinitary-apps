import XCTest

/// The homes part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-5265, the captain's approved plan on INF-5264 (docs/ios.md, "Several computers"). Intent: one phone keeps two
    /// computers it joined, shows one at a time and switches with one tap, never by itself, and each computer pushes
    /// under its own key; a notification from the one not shown shows it and opens its card. Data: the test home and a
    /// second real home in a process of its own (tests/helpers/phoneSecondHome.ts), each with its own key, port, link and
    /// stand-in relay. A simulated push runs no notification part, so the tap's notification is what the part leaves
    /// once it opened a card (`push-opened`); each home's own sealed send is read at its relay, and `PhonePushTests`
    /// owns opening each computer's sealed card under its own key. Completion: the bar names the computer shown, each
    /// computer shows only its own cards, the sheet marks the other as answering or not as its home goes away and comes
    /// back with no switch, a keyboard's Return shows it, both stay kept through a relaunch and hand each home its own
    /// key again (each home let go of its registration first) under which it seals a new card, the push's tap shows its
    /// computer with its card, and leaving each in turn ends on the first screen. Not proven here: a test cannot change
    /// the simulator's own network, so the sheet's answer to the phone's network changing while it stays open (every
    /// mark cleared on a lost path, a new look once a new one settles) is not driven; the home going away and back
    /// proves the look each opening of the sheet makes.
    func testSeveralComputers() async throws {
        let standIn = try await home("push-state", method: "GET")
        app.launchEnvironment["INFINITARY_TEST_PUSH"] = "1"
        app.launchEnvironment["INFINITARY_TEST_PUSH_RELAY"] = try XCTUnwrap(standIn["relay"] as? String)
        app.launchEnvironment["INFINITARY_TEST_PUSH_ADDRESS"] = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        try await launchFresh()
        try await join()
        // The pushes are asked for once, on the first computer.
        let ask = app.alerts["Get a notification for each card?"]
        XCTAssertTrue(ask.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(ask.buttons["Turn on"].firstMatch, repeatDiscarded: false)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForPresence(timeout: 20), springboard.debugDescription)
        tapOnPhone(allow, repeatDiscarded: false)
        let first = try await home("push-registered", budget: 90)
        XCTAssertEqual(first["registered"] as? Bool, true, "\(first)")
        let firstKeys = try XCTUnwrap(first["keys"] as? [String])
        XCTAssertEqual(firstKeys.count, 1, "\(first)")
        // With one computer kept, the bar shows its one icon.
        let computer = app.buttons["computer-details"]
        XCTAssertEqual(computer.label, "Your computer", "One computer kept: the bar names none")

        // A second computer joins from the sheet's Add another computer and its pasted link, while the first stays kept.
        let second = try await home("second-home", budget: 150)
        let secondControl = try XCTUnwrap(second["control"] as? String)
        let secondName = try XCTUnwrap(second["name"] as? String)
        tapOnPhone(app.buttons["computer-details"], repeatDiscarded: false)
        let add = app.buttons["add-computer"]
        XCTAssertTrue(add.waitForPresence(timeout: 10), app.debugDescription)
        picture("homes-sheet-one")
        tapOnPhone(add, repeatDiscarded: false)
        let paste = app.buttons["add-paste-link"].firstMatch
        XCTAssertTrue(paste.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(paste, repeatDiscarded: false)
        let field = app.textFields["join-link"]
        XCTAssertTrue(field.waitForPresence(timeout: 10), "Add another computer opens the paste way in: \(app.debugDescription)")
        let invitation = try await homeAt(secondControl, "link")
        let link = try XCTUnwrap(invitation["link"] as? String)
        let secondPin = try XCTUnwrap(URLComponents(string: link)?.queryItems?.first { $0.name == "key" }?.value)
        focusForPhoneTyping(field, in: app)
        field.typeText(link)
        tapOnPhone(app.buttons["read-link"])
        let confirm = app.buttons["confirm-join"].firstMatch
        XCTAssertTrue(confirm.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(confirm)
        reach("Live", timeout: 30)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", secondName), object: computer, timeout: 10),
                       .completed, "The bar names the computer shown: \(app.debugDescription)")
        XCTAssertFalse(app.alerts["Get a notification for each card?"].waitForPresence(timeout: 3), "The question is asked once")
        // The second computer gets its own registration under a key of its own, with no second ask of the relay.
        let secondPushes = try await homeAt(secondControl, "push-registered", budget: 90)
        XCTAssertEqual(secondPushes["registered"] as? Bool, true, "\(secondPushes)")
        let secondKeys = try XCTUnwrap(secondPushes["keys"] as? [String])
        XCTAssertEqual(secondKeys.count, 1, "\(secondPushes)")
        XCTAssertNotEqual(secondKeys, firstKeys, "Each computer seals under its own key")
        picture("homes-bar")

        // Each computer shows its own cards: a card on the second shows there, and its home sends it sealed to its relay.
        _ = try await homeAt(secondControl, "review-finding")
        XCTAssertTrue(cardHeading("Review the phone connection finding").waitForPresence(timeout: 30), app.debugDescription)
        try await sentSealed(secondControl, after: 0)

        // By keys: Command-I opens the sheet on the first computer's row, marked as answering.
        try await pressPhoneKey("i", modifiers: .command, in: app)
        let row = app.buttons["kept-computer"].firstMatch
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(row.label, "Test Mac mini")
        try reachMark(row, "Answers now")
        try await appearances("homes-sheet", showing: row)
        // The first computer's home goes away and comes back: the mark follows it, and the phone stays on the second.
        tapOnPhone(app.buttons["close-computer-details"], repeatDiscarded: false)
        XCTAssertTrue(row.waitForAbsence(timeout: 10))
        _ = try await home("offline")
        tapOnPhone(app.buttons["computer-details"], repeatDiscarded: false)
        try reachMark(row, "Not answering from here")
        XCTAssertEqual(computer.label, secondName, "A computer that stops answering switches nothing")
        tapOnPhone(app.buttons["close-computer-details"], repeatDiscarded: false)
        XCTAssertTrue(row.waitForAbsence(timeout: 10))
        _ = try await home("online")
        try await pressPhoneKey("i", modifiers: .command, in: app)
        try reachMark(row, "Answers now")
        XCTAssertEqual(computer.label, secondName, "A computer that answers again switches nothing")
        // Return on the row shows the first computer, with its own cards and not the second's.
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(row.waitForAbsence(timeout: 10), "Return on the row shows its computer and closes the sheet")
        reach("Live", timeout: 30)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", "Test Mac mini"), object: computer, timeout: 10),
                       .completed, app.debugDescription)
        XCTAssertTrue(cardHeading("Your phone is reading your Mac").waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(cardHeading("Review the phone connection finding").exists, "The second computer's card is not the first's")

        // Both computers stay kept through a relaunch, the one shown last still shown, each keeping its key. Each home
        // first lets go of the registration it holds, so what it holds after is what the relaunched phone handed it.
        let firstCleared = try await home("push-cleared")
        let firstSent = try XCTUnwrap(firstCleared["pushes"] as? Int)
        let secondCleared = try await homeAt(secondControl, "push-cleared")
        let secondSent = try XCTUnwrap(secondCleared["pushes"] as? Int)
        XCTAssertEqual(firstCleared["registered"] as? Bool, false, "\(firstCleared)")
        XCTAssertEqual(secondCleared["registered"] as? Bool, false, "\(secondCleared)")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 30)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", "Test Mac mini"), object: computer, timeout: 10),
                       .completed, app.debugDescription)
        let relaunched = try await home("push-registered", budget: 90)
        XCTAssertEqual(relaunched["keys"] as? [String], firstKeys, "The first computer keeps its key through a relaunch")
        // The key it handed again still seals: a new card on the first computer goes to its relay sealed.
        _ = try await home("homes-card")
        try await sentSealed(control, after: firstSent)
        tapOnPhone(app.buttons["computer-details"], repeatDiscarded: false)
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(row.label, secondName, "The second computer is still kept after the relaunch")
        tapOnPhone(app.buttons["close-computer-details"], repeatDiscarded: false)
        XCTAssertTrue(row.waitForAbsence(timeout: 10))

        // A card on the computer not shown arrives as a notification naming that computer; its tap shows it and the card.
        XCUIDevice.shared.press(.home)
        let away = waitForPhonePredicate(NSPredicate { _, _ in
            [.runningBackground, .runningBackgroundSuspended].contains(self.app.state)
        }, object: nil, timeout: 20)
        XCTAssertEqual(away, .completed, "Infinitary left the front: \(app.state.rawValue)")
        let opened = try JSONSerialization.data(withJSONObject: [
            "cardId": "phone-review-finding", "computer": secondPin,
            "title": "Review the phone connection finding", "subtitle": secondName
        ])
        _ = try await home("push-opened", body: String(decoding: opened, as: UTF8.self))
        let notification = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", secondName)).firstMatch
        XCTAssertTrue(notification.waitForPresence(timeout: 30), springboard.debugDescription)
        picture("homes-notification")
        tapOnPhone(notification, repeatDiscarded: false)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "\(app.state.rawValue)")
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", secondName), object: computer, timeout: 30),
                       .completed, "The tap shows the computer the card came from: \(app.debugDescription)")
        XCTAssertTrue(cardHeading("Review the phone connection finding").waitForPresence(timeout: 30), app.debugDescription)
        picture("homes-opened")
        reach("Live", timeout: 30)
        let secondAgain = try await homeAt(secondControl, "push-registered", budget: 90)
        XCTAssertEqual(secondAgain["keys"] as? [String], secondKeys, "The second computer keeps its key through the relaunch")
        _ = try await homeAt(secondControl, "homes-card")
        try await sentSealed(secondControl, after: secondSent)

        // Leaving the shown computer shows the other, and the bar goes back to its one icon.
        try leaveShown()
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", "Your computer"), object: computer, timeout: 30),
                       .completed, "One computer left: the bar names none")
        reach("Live", timeout: 30)
        XCTAssertFalse(app.buttons["paste-link"].exists, "The first computer shows, not the first screen")
        let kept = try await home("push-state", method: "GET")
        XCTAssertEqual(kept["keys"] as? [String], firstKeys, "The first computer keeps the phone's registration and key: \(kept)")
        // Leaving the last computer ends on the first screen.
        try leaveShown()
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 30), "No computer left: the first screen")
    }

    /// Waits for the kept computer's row to say `words` of its reach.
    private func reachMark(_ row: XCUIElement, _ words: String) throws {
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == %@", words), object: row, timeout: 30),
                       .completed, "The row says \(words): \(row.debugDescription)")
    }

    /// A home's relay has taken a sealed card from it beyond the `after` it took before: the home waits for it
    /// (`push-sent`).
    private func sentSealed(_ control: String, after: Int) async throws {
        let state = try await homeAt(control, "push-sent", body: "{\"after\":\(after)}", budget: 60)
        XCTAssertGreaterThan(state["pushes"] as? Int ?? 0, after, "The home sent its card sealed to its relay: \(state)")
        XCTAssertEqual((state["problems"] as? [String])?.isEmpty, true, "\(state)")
    }

    /// Leaves the computer shown, from its sheet.
    private func leaveShown() throws {
        reach("Live", timeout: 30)
        tapOnPhone(app.buttons["computer-details"], repeatDiscarded: false)
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(leave, repeatDiscarded: false)
        let leaving = app.buttons["confirm-leave"].firstMatch
        XCTAssertTrue(leaving.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(leaving, repeatDiscarded: false)
    }

    /// A command to the second computer's control, as `home` sends one to the test home's.
    private func homeAt(_ control: String, _ command: String, method: String = "POST", body: String? = nil,
                        budget: TimeInterval = 60) async throws -> [String: Any] {
        var request = URLRequest(url: try XCTUnwrap(URL(string: control + "/" + command)), timeoutInterval: budget)
        request.httpMethod = method
        request.httpBody = body.map { Data($0.utf8) }
        let (data, response) = try await phoneTestSession.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
