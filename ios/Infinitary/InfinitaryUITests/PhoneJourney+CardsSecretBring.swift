import XCTest

/// The cards-secret-bring part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-7282's approved plan, part 1, the captain: "let's plan how to allow phone to approve this". Result: a task's
    /// bring from another tool reaches the phone with one tick row per secret, the name Secrets already keeps unticked;
    /// Bring into Secrets waits for a tick, and keeps only the ticked rows. A .env file's bring offers Read it, then the
    /// names it found, and Don't bring ends it with nothing kept. The iPad's keyboard reaches the rows: Tab, the arrows,
    /// Space to tick and Return to bring. Data: the real SecretBrings over disposable custody, a stand-in tool and file
    /// holding invented values (tests/helpers/phoneSecretBrings.ts). Completion: Secrets keeps the ticked name at
    /// version 1 and the unticked one unchanged, both brings have ended, and no frame the phone received held a value.
    func testSecretBringFromPhone() async throws {
        try await launchJoined()
        _ = try await home("secrets-ready")

        let asked = try await home("secrets-bring")
        XCTAssertEqual(asked["state"] as? String, "waiting")
        let title = try XCTUnwrap(asked["title"] as? String)
        showCard(title)
        waitForShownBodyRevealed()
        let token = app.switches["secret-bring-s1"]
        let kept = app.switches["secret-bring-s2"]
        // A tick row is a switch to XCTest: its .isToggle trait reads as value "1" or "0", not as selected.
        let ticked = NSPredicate(format: "value == %@", "1"), unticked = NSPredicate(format: "value == %@", "0")
        XCTAssertTrue(token.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(token.value as? String, "1", "The new name arrives ticked")
        XCTAssertEqual(kept.value as? String, "0", "A name Secrets already keeps arrives unticked")
        // The phone draws the rows, so the host leaves out the line sending the captain to the computer.
        XCTAssertFalse(app.staticTexts[try XCTUnwrap(asked["elsewhere"] as? String)].exists, app.debugDescription)
        let bring = app.buttons["card-action-\(try XCTUnwrap(asked["go"] as? String))"]
        XCTAssertTrue(bring.exists, "Bring into Secrets is on the phone's face\n\(app.debugDescription)")
        // Both appearances of the bring card supply the release note's hero pair.
        try await appearances("secret-bring-rows", showing: cardHeading(title))

        if UIDevice.current.userInterfaceIdiom == .pad {
            // As PhoneKeys owns, each unmodified key is one actual input with visible-result proof, no wait or retry.
            app.typeKey("\t", modifierFlags: [])
            XCTAssertTrue(app.descendants(matching: .any)["secret-bring-ring-s1"].waitForPresence(timeout: 10),
                          "Tab reaches the first row\n\(app.debugDescription)")
            app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
            XCTAssertTrue(app.descendants(matching: .any)["secret-bring-ring-s2"].waitForPresence(timeout: 10), app.debugDescription)
            app.typeKey(" ", modifierFlags: [])
            XCTAssertEqual(waitForPhonePredicate(ticked, object: kept, timeout: 10), .completed,
                           "Space ticks the row under the ring")
            app.typeKey(" ", modifierFlags: [])
            XCTAssertEqual(waitForPhonePredicate(unticked, object: kept, timeout: 10), .completed,
                           "Space unticks it again")
            app.typeKey(XCUIKeyboardKey.upArrow.rawValue, modifierFlags: [])
            XCTAssertTrue(app.descendants(matching: .any)["secret-bring-ring-s1"].waitForPresence(timeout: 10), app.debugDescription)
            // The row Return brings is one Space ticked: untick it, then tick it again.
            app.typeKey(" ", modifierFlags: [])
            XCTAssertEqual(waitForPhonePredicate(unticked, object: token, timeout: 10), .completed)
            app.typeKey(" ", modifierFlags: [])
            XCTAssertEqual(waitForPhonePredicate(ticked, object: token, timeout: 10), .completed)
            picture("1-secret-bring-keys")
            // As PhoneKeys owns, Xcode emits the physical Return for LF, not CR.
            app.typeKey("\n", modifierFlags: [])
        } else {
            tapOnPhone(kept)
            XCTAssertEqual(waitForPhonePredicate(ticked, object: kept, timeout: 10), .completed)
            tapOnPhone(kept)
            XCTAssertEqual(waitForPhonePredicate(unticked, object: kept, timeout: 10), .completed)
            tapOnPhone(token)
            // With nothing ticked, Bring into Secrets waits for a tick.
            XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "isEnabled == false"), object: bring, timeout: 10), .completed,
                           app.debugDescription)
            picture("1-secret-bring-none")
            tapOnPhone(token)
            XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "isEnabled == true"), object: bring, timeout: 10), .completed)
            reveal(bring); tapOnPhone(bring)
        }
        let gone = NSPredicate { _, _ in !self.cardHeading(title).exists }
        XCTAssertEqual(waitForPhonePredicate(gone, object: nil, timeout: 20), .completed, app.debugDescription)
        let brought = try await home("secrets-bring-state", method: "GET")
        XCTAssertEqual((brought["bring"] as? [String: Any])?["state"] as? String, "kept", "\(brought)")
        let entries = try XCTUnwrap(brought["entries"] as? [[String: Any]])
        XCTAssertTrue(entries.contains { $0["label"] as? String == "Staging token" && $0["environment"] as? String == "Staging"
            && $0["version"] as? Int == 1 }, "\(entries)")
        // The unticked name keeps the value it had.
        XCTAssertTrue(entries.contains { $0["label"] as? String == "DB_PASSWORD" && $0["version"] as? Int == 1 }, "\(entries)")

        // A .env file is read first: Read it, then the names it found, and Don't bring ends it with nothing kept.
        let read = try await home("secrets-bring-read")
        XCTAssertEqual(read["state"] as? String, "waiting")
        let readTitle = try XCTUnwrap(read["title"] as? String)
        showCard(readTitle)
        waitForShownBodyRevealed()
        XCTAssertFalse(app.switches["secret-bring-s1"].exists, "A read names nothing before Read it\n\(app.debugDescription)")
        let readIt = app.buttons["card-action-\(try XCTUnwrap(read["go"] as? String))"]
        reveal(readIt); tapOnPhone(readIt)
        let found = try XCTUnwrap(read["found"] as? String)
        XCTAssertTrue(cardHeading(found).waitForPresence(timeout: 20), app.debugDescription)
        let name = app.switches["secret-bring-s1"]
        XCTAssertTrue(name.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(name.value as? String, "1", app.debugDescription)
        picture("2-secret-bring-read")
        let dontBring = app.buttons.matching(NSPredicate(format: "label == %@", try XCTUnwrap(read["dontBringLabel"] as? String))).firstMatch
        reveal(dontBring); tapOnPhone(dontBring)
        let readGone = NSPredicate { _, _ in !self.cardHeading(found).exists }
        XCTAssertEqual(waitForPhonePredicate(readGone, object: nil, timeout: 20), .completed, app.debugDescription)

        let state = try await home("secrets-bring-state", method: "GET")
        XCTAssertEqual((state["read"] as? [String: Any])?["state"] as? String, "not-brought", "\(state)")
        XCTAssertFalse(try XCTUnwrap(state["entries"] as? [[String: Any]]).contains { $0["label"] as? String == "API_KEY" }, "\(state)")
        XCTAssertEqual((state["cards"] as? [Any])?.count, 0, "\(state)")
        XCTAssertEqual(state["framesWithValue"] as? Int, 0, "A frame the phone received held an invented value")
    }
}
