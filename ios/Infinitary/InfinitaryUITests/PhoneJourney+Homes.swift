import XCTest

/// The homes part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-5265, the captain's approved plan on INF-5264 (docs/ios.md, "Several computers"). Intent: one phone keeps two
    /// computers it joined, shows one at a time and switches with one tap, and a notification from the one not shown
    /// shows it and opens its card. Data: the test home and a second real home in a process of its own
    /// (tests/helpers/phoneSecondHome.ts), each with its own key, port and link. A simulated push runs no notification
    /// part, so the test home pushes what the part leaves once it opened a card (`push-opened`), naming the card and its
    /// computer; `PhonePushTests` owns opening each computer's sealed card under its own key. Completion: the bar names
    /// the computer shown, the sheet marks the other as answering, a keyboard's Return on its row shows it, the push's
    /// tap shows its computer with its card, and leaving one shows the other with the bar back to its one icon.
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
        // With one computer kept, the bar shows its one icon.
        let computer = app.buttons["computer-details"]
        XCTAssertEqual(computer.label, "Your computer", "One computer kept: the bar names none")

        // A second computer joins from the sheet's Add another computer, while the first stays kept.
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
        tapOnPhone(app.buttons["Cancel"].firstMatch, repeatDiscarded: false)
        XCTAssertTrue(field.waitForAbsence(timeout: 10))
        let invitation = try await homeAt(secondControl, "link")
        let link = try XCTUnwrap(invitation["link"] as? String)
        let secondPin = try XCTUnwrap(URLComponents(string: link)?.queryItems?.first { $0.name == "key" }?.value)
        XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: link)))
        let confirm = app.buttons["confirm-join"].firstMatch
        XCTAssertTrue(confirm.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(confirm)
        reach("Live", timeout: 30)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", secondName), object: computer, timeout: 10),
                       .completed, "The bar names the computer shown: \(app.debugDescription)")
        XCTAssertFalse(app.alerts["Get a notification for each card?"].waitForPresence(timeout: 3), "The question is asked once")
        // The second computer gets its own registration, with no second ask of the relay for the same address.
        let secondPushes = try await homeAt(secondControl, "push-registered", budget: 90)
        XCTAssertEqual(secondPushes["registered"] as? Bool, true, "\(secondPushes)")
        picture("homes-bar")

        // By keys: Command-I opens the sheet on the first computer's row, marked as answering, and Return shows it.
        try await pressPhoneKey("i", modifiers: .command, in: app)
        let row = app.buttons["kept-computer"].firstMatch
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(row.label, "Test Mac mini")
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == %@", "Answers now"), object: row, timeout: 30),
                       .completed, "The first computer answers its pinned check: \(row.debugDescription)")
        try await appearances("homes-sheet", showing: row)
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(row.waitForAbsence(timeout: 10), "Return on the row shows its computer and closes the sheet")
        reach("Live", timeout: 30)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", "Test Mac mini"), object: computer, timeout: 10),
                       .completed, app.debugDescription)

        // A card on the computer not shown arrives as a notification naming that computer; its tap shows it and the card.
        _ = try await homeAt(secondControl, "review-finding")
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

        // Leaving the shown computer shows the other, and the bar goes back to its one icon.
        reach("Live", timeout: 30)
        tapOnPhone(app.buttons["computer-details"], repeatDiscarded: false)
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(leave, repeatDiscarded: false)
        let leaving = app.buttons["confirm-leave"].firstMatch
        XCTAssertTrue(leaving.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(leaving, repeatDiscarded: false)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "label == %@", "Your computer"), object: computer, timeout: 30),
                       .completed, "One computer left: the bar names none")
        reach("Live", timeout: 30)
        XCTAssertFalse(app.buttons["paste-link"].exists, "The first computer shows, not the first screen")
        let kept = try await home("push-state", method: "GET")
        XCTAssertEqual(kept["registered"] as? Bool, true, "The first computer keeps the phone's registration: \(kept)")
    }

    /// A command to the second computer's control, as `home` sends one to the test home's.
    private func homeAt(_ control: String, _ command: String, budget: TimeInterval = 60) async throws -> [String: Any] {
        var request = URLRequest(url: try XCTUnwrap(URL(string: control + "/" + command)), timeoutInterval: budget)
        request.httpMethod = "POST"
        let (data, response) = try await phoneTestSession.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
