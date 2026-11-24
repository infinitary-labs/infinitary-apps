import XCTest

/// The google part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3454's phone part, the captain's choices where=settings ("A Google row in the phone's Settings, showing who
    /// is signed in, with Sign in and Sign out") and how=catch ("Catch it in the app, with pasting the address as the
    /// fallback, like the computers"). Data: the test home signs in to a stand-in Google, whose page the test approves as
    /// the person's browser would. The simulator shares the test home's loopback address, where the sign-in itself
    /// listens, so the phone cannot catch the return there and asks for the address: this is the pasted way, end to
    /// end; the caught way is PhoneSignInReturnTests on the real listener. Completion: the home keeps the sign-in, the
    /// row names its account, and Sign out removes it there. INF-6342, the captain's choice setup-on-phone ("Bring the
    /// client file setup to the phone itself"): the test home names no client of its own, as a released build, so Set up
    /// comes first; a file Google does not give is refused and nothing is kept, and the pasted client file is kept on the
    /// computer, which then asks Google as that client.
    func testGoogleSignInAndOut() async throws {
        try await launchFresh()
        try await join()
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        // The captain's reply on the merge card: Google sits under Integrations, as in the computer's Settings.
        let integrations = app.buttons["phone-settings-integrations"]
        XCTAssertTrue(integrations.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Google: Not signed in"].exists)
        tapOnPhone(integrations, repeatDiscarded: false)
        let setUp = app.buttons["google-set-up"]
        XCTAssertTrue(setUp.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(setUp.label, "Set up")
        waitForSteadyTarget(setUp)
        picture("google-signed-out")

        // The setup comes first: a file that is not Google's is refused, and the computer keeps nothing.
        tapOnPhone(setUp, repeatDiscarded: false)
        let file = app.secureTextFields["google-setup-file"]
        XCTAssertTrue(file.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Set up your own Google connection"].exists)
        XCTAssertTrue(app.buttons["google-setup-page"].exists)
        let keep = app.buttons["google-setup-keep"]
        XCTAssertFalse(keep.isEnabled, "Nothing to keep yet")
        picture("google-setup")
        focusForPhoneTyping(file, in: app)
        file.typeText("client_id=1")
        tapOnPhone(keep, repeatDiscarded: false)
        let problem = app.staticTexts["google-setup-problem"]
        XCTAssertTrue(problem.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(problem.label.hasPrefix("That isn't a Google client file."), problem.label)
        let unkept = try await home("google-state", method: "GET")
        XCTAssertEqual(unkept["kept"] as? Bool, false)
        picture("google-setup-refused")

        // The client file Google gives is kept on the computer, and the sign-in goes on to Google's notice.
        let own = try XCTUnwrap(unkept["own"] as? [String: Any])
        let clientFile = try XCTUnwrap(own["file"] as? String)
        focusForPhoneTyping(file, in: app)
        file.typeText(clientFile)
        tapOnPhone(keep, repeatDiscarded: false)

        // The notice comes next; nothing is asked of the computer until it is accepted.
        let accept = app.buttons["google-accept"]
        XCTAssertTrue(accept.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Before you connect Google"].exists)
        let unasked = try await home("google-state", method: "GET")
        XCTAssertEqual(unasked["pages"] as? Int, 0)
        XCTAssertEqual(unasked["kept"] as? Bool, true)
        picture("google-notice")
        waitForSteadyTarget(accept)
        tapOnPhone(accept, repeatDiscarded: false)

        // The computer's sign-in opened its page for this phone, which cannot listen on its port here.
        let paste = app.textFields["google-paste"]
        XCTAssertTrue(paste.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["google-waiting"].exists)
        let asked = try await home("google-state", method: "GET")
        XCTAssertEqual(asked["pages"] as? Int, 1)
        // Google's page names the person's own client, from the file this phone handed the computer.
        XCTAssertEqual(asked["client"] as? String, try XCTUnwrap(own["id"] as? String))
        picture("google-waiting")
        let approved = try await home("google-approve")
        let address = try XCTUnwrap(approved["address"] as? String)
        let other = try XCTUnwrap(approved["other"] as? String)

        // An address from another sign-in is refused, and the sign-in still waits.
        focusForPhoneTyping(paste, in: app)
        paste.typeText(other)
        tapOnPhone(app.buttons["google-paste-send"], repeatDiscarded: false)
        XCTAssertTrue(app.staticTexts["google-paste-refused"].waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(paste.exists, "The sign-in still waits for its own return")
        picture("google-paste-refused")

        // The browser's own address signs in there; the row names who it is.
        focusForPhoneTyping(paste, in: app)
        paste.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: other.count) + address)
        tapOnPhone(app.buttons["google-paste-send"], repeatDiscarded: false)
        let account = app.staticTexts["google-account"]
        XCTAssertTrue(account.waitForPresence(timeout: 30), app.debugDescription)
        let kept = try await home("google-state", method: "GET")
        let who = try XCTUnwrap(kept["account"] as? String)
        XCTAssertTrue(account.label.contains(who), account.label)
        picture("google-signed-in")

        let signOut = app.buttons["google-sign-out"]
        waitForSteadyTarget(signOut)
        tapOnPhone(signOut, repeatDiscarded: false)
        let confirm = app.buttons["google-sign-out-confirm"].firstMatch
        XCTAssertTrue(confirm.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(confirm, repeatDiscarded: false)
        // The client stays kept on the computer, so the row offers the sign-in itself again.
        let signIn = app.buttons["google-sign-in"]
        XCTAssertTrue(signIn.waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertEqual(signIn.label, "Sign in")
        let signedOut = try await home("google-state", method: "GET")
        XCTAssertTrue(signedOut["account"] is NSNull)
    }
}
