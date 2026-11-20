import XCTest

/// The cards-secret part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-4239 piece 4, the captain: "all macs windows and phone app in one build piece". Result: a task's ask to keep
    /// a secret reaches the phone as Infinitary's own card with one masked field; the value typed there is kept in
    /// Secrets under the asked name and place, and the card goes. A Keep that cannot finish because what the card
    /// replaces changed on the computer leaves the card up with new passes, and the phone says why under it.
    /// Data: the real Secrets controller over disposable custody (`secrets-ready`), its kept calendar sign-in and an
    /// invented key. Completion: the computer's Secrets lists the replaced sign-in at version 3 and the asked secret at
    /// version 1, and no ask card is left.
    func testSecretAskKeptFromPhone() async throws {
        try await launchJoined()
        _ = try await home("secrets-ready")

        // A Keep that cannot finish: the card comes back with new passes, and its reason stays on the phone.
        let replace = try await home("secrets-ask-replace")
        XCTAssertEqual(replace["state"] as? String, "waiting")
        let replaceTitle = try XCTUnwrap(replace["title"] as? String)
        let stale = try XCTUnwrap(replace["stale"] as? String)
        showCard(replaceTitle)
        waitForShownBodyRevealed()
        let replaceField = app.secureTextFields["secret-ask-s1"]
        XCTAssertTrue(replaceField.waitForPresence(timeout: 10), app.debugDescription)
        reveal(replaceField); tapOnPhone(replaceField)
        replaceField.typeText("ya29.invented_phone_replacement\n")
        XCTAssertTrue(app.staticTexts[stale].waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(cardHeading(replaceTitle).exists, app.debugDescription)
        picture("0-secret-ask-stale")
        let again = app.secureTextFields["secret-ask-s1"]
        XCTAssertTrue(again.waitForPresence(timeout: 10), app.debugDescription)
        reveal(again); tapOnPhone(again)
        again.typeText("ya29.invented_phone_replacement\n")
        let replaced = NSPredicate { _, _ in !self.cardHeading(replaceTitle).exists }
        XCTAssertEqual(waitForPhonePredicate(replaced, object: nil, timeout: 20), .completed, app.debugDescription)

        let asked = try await home("secrets-ask-keep")
        XCTAssertEqual(asked["state"] as? String, "waiting")
        let title = try XCTUnwrap(asked["title"] as? String)
        // A new card joins the stack behind the one on screen, as "1 new"; open it from the pager.
        showCard(title)
        waitForShownBodyRevealed()
        let field = app.secureTextFields["secret-ask-s1"]
        XCTAssertTrue(field.waitForPresence(timeout: 10), app.debugDescription)
        reveal(field); tapOnPhone(field)
        field.typeText("sk_test_invented_phone_value")
        picture("1-secret-ask-typed")
        // A return in the only field keeps, as the Keep in Secrets button does.
        field.typeText("\n")
        let gone = NSPredicate { _, _ in !self.cardHeading(title).exists }
        XCTAssertEqual(waitForPhonePredicate(gone, object: nil, timeout: 20), .completed, app.debugDescription)
        let kept = try await home("secrets-kept", method: "GET")
        let entries = try XCTUnwrap(kept["entries"] as? [[String: Any]])
        XCTAssertTrue(entries.contains { $0["label"] as? String == "Stripe test key" && $0["environment"] as? String == "Test"
            && $0["version"] as? Int == 1 }, "\(entries)")
        XCTAssertTrue(entries.contains { $0["label"] as? String == "Planning calendar" && $0["version"] as? Int == 3 }, "\(entries)")
        XCTAssertEqual(kept["asks"] as? Int, 0)
        picture("2-secret-ask-kept")
    }
}
