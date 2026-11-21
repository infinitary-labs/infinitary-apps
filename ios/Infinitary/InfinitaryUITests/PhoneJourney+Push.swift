import XCTest

/// The push part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-4794, the phone's half of card pushes (INF-4774's approved plan; docs/ios.md, "Card pushes"). Intent: the phone
    /// asks once after joining, hands its computer a registration, and a new card on the computer reaches the phone as a
    /// notification whose tap opens Infinitary. Data: the test home's real phone sender and real cards; a stand-in relay
    /// (tests/helpers/phonePushRelay.ts) stands in for Infinitary's, and the simulator delivers what it pushes as Apple
    /// would. A simulated push runs no notification part (Xcode's known limit), so the notification keeps the relay's own
    /// words; `PhonePushTests` owns opening the sealed card, its title and the card it names. Completion: the home keeps
    /// the phone's registration, the notification arrives with the relay's words, its tap brings Infinitary back, and after
    /// a reconnect the welcome hands the held grant again with no new relay ask and no second question. With the grant the
    /// phone leaves the computer a letter in its box at the stand-in relay (INF-5275); `PhonePushTests` owns what it says.
    func testCardPushes() async throws {
        let standIn = try await home("push-state", method: "GET")
        let relay = try XCTUnwrap(standIn["relay"] as? String)
        app.launchEnvironment["INFINITARY_TEST_PUSH"] = "1"
        app.launchEnvironment["INFINITARY_TEST_PUSH_RELAY"] = relay
        // The simulator never reaches Apple's push service, so the phone takes this push address instead of iOS's.
        app.launchEnvironment["INFINITARY_TEST_PUSH_ADDRESS"] = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        try await launchFresh()
        try await join()

        // The one-sentence ask, then iOS's own question.
        let ask = app.alerts["Get a notification for each card?"]
        XCTAssertTrue(ask.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(ask.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "cannot read it")).firstMatch.exists,
                      ask.debugDescription)
        picture("push-ask")
        tapOnPhone(ask.buttons["Turn on"].firstMatch, repeatDiscarded: false)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForPresence(timeout: 20), springboard.debugDescription)
        tapOnPhone(allow, repeatDiscarded: false)

        // The phone asked the stand-in relay for a grant, kept the one it pushed and handed it on.
        let registered = try await home("push-registered", budget: 90)
        XCTAssertEqual(registered["registered"] as? Bool, true, "\(registered)")
        XCTAssertEqual(registered["asks"] as? Int, 1, "One ask of the relay for one push address")
        // INF-5275: with the grant it left its computer a sealed letter, in the box only that computer's key names.
        let lettered = try await home("push-lettered", budget: 60)
        XCTAssertEqual(lettered["lettered"] as? Bool, true, "\(lettered)")
        XCTAssertEqual(lettered["letters"] as? Int, 1, "One letter for one computer: \(lettered)")

        // Settings → Devices says notifications are on.
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        let devices = app.buttons["phone-settings-devices"]
        XCTAssertTrue(devices.waitForPresence(timeout: 20), app.debugDescription)
        tapOnPhone(devices, repeatDiscarded: false)
        let state = app.staticTexts["push-state"]
        XCTAssertTrue(state.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(state.label.hasPrefix("On."), state.label)
        reveal(state)
        // Both appearances of the Devices section supply the release note's hero pair.
        try await appearances("push-settings-on", showing: state)
        let close = app.buttons["close-phone-settings"]
        tapOnPhone(close, repeatDiscarded: false)
        XCTAssertTrue(close.waitForAbsence(timeout: 10))

        // Away from Infinitary, a new card on the computer arrives as a push. iOS asks an app still leaving the front
        // whether to show it, and Infinitary stays quiet in front, so the card waits until it is in the background.
        XCUIDevice.shared.press(.home)
        let away = waitForPhonePredicate(NSPredicate { _, _ in
            [.runningBackground, .runningBackgroundSuspended].contains(self.app.state)
        }, object: nil, timeout: 20)
        XCTAssertEqual(away, .completed, "Infinitary left the front: \(app.state.rawValue)")
        let words = try XCTUnwrap(standIn["words"] as? String)
        _ = try await home("review-finding")
        let notification = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        XCTAssertTrue(notification.waitForPresence(timeout: 30), springboard.debugDescription)
        let pushed = try await home("push-state", method: "GET")
        XCTAssertEqual(pushed["pushes"] as? Int, 1, "\(pushed)")
        XCTAssertEqual((pushed["problems"] as? [String])?.isEmpty, true, "\(pushed)")
        picture("push-notification")

        // Its tap brings Infinitary back to the front.
        tapOnPhone(notification, repeatDiscarded: false)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "\(app.state.rawValue)")
        XCTAssertTrue(app.buttons["phone-settings"].waitForPresence(timeout: 20), app.debugDescription)
        picture("push-opened")

        // A reconnect: the home lets go of the registration and Infinitary opens again. Its welcome hands the grant it
        // holds, with no new ask of the relay for the same address and no second question.
        let cleared = try await home("push-cleared")
        XCTAssertEqual(cleared["registered"] as? Bool, false, "\(cleared)")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        let again = try await home("push-registered", budget: 90)
        XCTAssertEqual(again["registered"] as? Bool, true, "The welcome handed the held grant again: \(again)")
        XCTAssertEqual(again["asks"] as? Int, 1, "No second ask of the relay while the grant lasts: \(again)")
        XCTAssertFalse(app.alerts["Get a notification for each card?"].exists, "The question is asked once")
    }
}
