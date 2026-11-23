import XCTest

/// The languages part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// The approved plan for the phone's languages (INF-3675, piece 4): the phone speaks a catalog language iOS picks
    /// for it, right to left in Arabic, and Settings → Appearance's Language row names it and opens iOS Settings.
    /// INF-4241 keeps Arabic (right to left) and Japanese (another script) of the nine catalog languages: that every
    /// catalog language ships its string files, word for word with the catalog and listed in Info.plist, is
    /// `generate-messages.ts --check`'s and tests/generate-messages.test.ts's ("write every catalog language's string files").
    /// INF-5005, the captain's answer to its review ("Translate the move card"): a move card the home saved in English
    /// reads its title, body and both buttons in the phone's language, live and after it was answered.
    /// Data: the disposable home's join note and a move card its real projects wrote, the phone's own catalog words and
    /// iOS's own language names.
    /// Completion: each language's views pictured, the move card's title, opening sentence and buttons in that
    /// language's words as the home words them, live and, answered, opened again, the row naming that language, Arabic's back arrow at the right,
    /// every word on Appearance marked under Apple's surrounding pseudo-language and inside the screen when doubled,
    /// and the row's keys (down from Theme, then Return) bringing iOS Settings forward.
    func testLanguages() async throws {
        try await launchFresh()
        try await join()
        let moveCard = try await home("move-card")
        let english = try XCTUnwrap((moveCard["en"] as? [String: Any])?["title"] as? String)
        for tag in ["ar", "ja"] {
            try await relaunch(["-AppleLanguages", "(\(tag))", "-AppleLocale", tag.replacingOccurrences(of: "-", with: "_")])
            XCTAssertTrue(app.staticTexts["card-title"].waitForPresence(timeout: 20), app.debugDescription)
            picture("language-\(tag)-cards")
            let move = try XCTUnwrap(moveCard[tag] as? [String: Any])
            let title = try XCTUnwrap(move["title"] as? String)
            let actions = try XCTUnwrap(move["actions"] as? [String: String])
            XCTAssertNotEqual(title, english, "The home words the move card's title in \(tag)")
            // The phone's own formatting may set each name the title fills in apart as its own direction (U+2068 and
            // U+2069 around it, as an Arabic sentence holds a Latin name), so the title reads as either form.
            let names = try XCTUnwrap(move["names"] as? [String])
            let isolated = names.reduce(title) { $0.replacingOccurrences(of: $1, with: "\u{2068}\($1)\u{2069}") }
            let titled = NSPredicate(format: "label IN %@", [title, isolated])
            let heading = app.staticTexts.matching(identifier: "card-title").matching(titled).firstMatch
            if !heading.exists {
                waitForShownBodyRevealed()
                let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
                XCTAssertTrue(pager.waitForPresence(timeout: 10), app.debugDescription); tapOnPhone(pager)
                let item = app.buttons.matching(titled).firstMatch
                XCTAssertTrue(item.waitForPresence(timeout: 10), app.debugDescription); tapOnPhone(item)
            }
            XCTAssertTrue(heading.waitForPresence(timeout: 20), app.debugDescription)
            XCTAssertEqual(actions.count, 2, "The move card offers Apply move and Not now")
            for (id, words) in actions {
                XCTAssertEqual(app.buttons["card-action-\(id)"].label, words, "The move card's \(id) button in \(tag)")
            }
            let asks = try XCTUnwrap(move["asks"] as? String)
            let opening = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", asks)).firstMatch
            XCTAssertTrue(opening.waitForPresence(timeout: 10), "The move card's body in \(tag): \(app.debugDescription)")
            picture("language-\(tag)-move-card")
            // Answered with Not now and opened again from the home, the past card keeps its title and buttons in
            // the phone's language, its buttons no longer pressable.
            if tag == "ja" {
                let notNow = try XCTUnwrap(actions.keys.first { $0.hasPrefix("not-now") })
                tapOnPhone(app.buttons["card-action-\(notNow)"])
                XCTAssertTrue(heading.waitForAbsence(timeout: 10), app.debugDescription)
                _ = try await home("move-card-past")
                XCTAssertTrue(heading.waitForPresence(timeout: 10), app.debugDescription)
                for (id, words) in actions {
                    let button = app.buttons["card-action-\(id)"]
                    XCTAssertEqual(button.label, words, "The past move card's \(id) button in \(tag)")
                    XCTAssertFalse(button.isEnabled, "A past card's \(id) button is not pressable")
                }
                // The line naming the choice reads the chosen button as the button does, never the saved English.
                let chose = try XCTUnwrap(actions[notNow])
                let ending = NSPredicate(format: "label CONTAINS %@ AND label != %@", chose, chose)
                XCTAssertTrue(app.staticTexts.matching(ending).firstMatch.waitForPresence(timeout: 10), app.debugDescription)
                XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Not now")).firstMatch.exists,
                               "The past move card's ending in \(tag): \(app.debugDescription)")
                // Its body reads in the phone's language once revealed, and the picture waits for it.
                let reopened = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", asks)).firstMatch
                XCTAssertTrue(reopened.waitForPresence(timeout: 10), "The past move card's body in \(tag): \(app.debugDescription)")
                picture("language-\(tag)-move-card-past")
                tapOnPhone(app.buttons["put-aside-card"])
            }
            tab("tasks"); picture("language-\(tag)-tasks")
            tab("activity"); picture("language-\(tag)-activity")
            let language = try openAppearance()
            let name = Locale(identifier: tag).localizedString(forIdentifier: tag) ?? tag
            XCTAssertTrue(language.label.localizedCaseInsensitiveContains(name), "The Language row names \(name): \(language.label)")
            if tag == "ar" {
                let back = app.buttons["phone-settings-back"], window = app.windows.firstMatch.frame
                XCTAssertGreaterThan(back.frame.midX, window.midX, "Right to left, Back sits at the right")
            }
            // Arabic's Appearance light and dark: the release note's hero picture pair is cut from these two.
            if tag == "ar" { try await appearances("language-ar-appearance", showing: language) } else { picture("language-\(tag)-appearance") }
        }

        // Apple's pseudo-languages: every word the phone's own Swift writes comes from its string files, so each is
        // marked; doubled, every line still sits inside the screen.
        try await relaunch(["-AppleLanguages", "(en)", "-NSSurroundLocalizedStrings", "YES", "-NSDoubleLocalizedStrings", "YES"])
        reachSettings()
        for row in ["general", "appearance", "devices"] {
            XCTAssertTrue(app.buttons["phone-settings-\(row)"].label.contains("[#"), "\(row) is a catalog word")
        }
        _ = try openAppearance(fromList: true)
        let window = app.windows.firstMatch.frame
        let words = ["phone-theme-scope", "phone-language-scope"].map { app.staticTexts[$0] }
            + ["Theme", "Language"].map { app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", $0)).firstMatch }
        for text in words {
            XCTAssertTrue(text.waitForPresence(timeout: 10), app.debugDescription)
            XCTAssertTrue(text.label.hasPrefix("[#"), "Words on Appearance come from the catalog: \(text.label)")
            XCTAssertGreaterThanOrEqual(text.frame.minX, window.minX - 1, text.label)
            XCTAssertLessThanOrEqual(text.frame.maxX, window.maxX + 1, text.label)
        }
        picture("language-pseudo-appearance")

        // The row by keys, on the Appearance page the pseudo-language opened (INF-4241 dropped a relaunch in English
        // for it): Theme holds focus as Appearance opens, the down arrow moves to Language and Return opens it.
        // As PhoneKeys owns, Xcode emits the physical Return for LF, not CR.
        waitForSteadyTarget(app.segmentedControls["phone-theme"])
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 20), "Return on Language opens iOS Settings")
        app.activate()
    }

    private func relaunch(_ arguments: [String]) async throws {
        app.terminate()
        // Each language setting is a key and its value; the earlier launch's go before this one's.
        let keys: Set = ["-AppleLanguages", "-AppleLocale", "-NSSurroundLocalizedStrings", "-NSDoubleLocalizedStrings"]
        var kept: [String] = [], index = 0
        while index < app.launchArguments.count {
            if keys.contains(app.launchArguments[index]) { index += 2; continue }
            kept.append(app.launchArguments[index]); index += 1
        }
        app.launchArguments = kept
        app.launchArguments += arguments
        try await launchPhoneApp(app)
        XCTAssertTrue(app.buttons["computer-details"].waitForPresence(timeout: 20), app.debugDescription)
    }

    private func reachSettings() {
        tapOnPhone(app.buttons["phone-settings"], repeatDiscarded: false)
        XCTAssertTrue(app.buttons["phone-settings-appearance"].waitForPresence(timeout: 10), app.debugDescription)
    }

    private func openAppearance(fromList: Bool = false) throws -> XCUIElement {
        if !fromList { reachSettings() }
        tapOnPhone(app.buttons["phone-settings-appearance"])
        let language = app.buttons["phone-language"]
        XCTAssertTrue(language.waitForPresence(timeout: 10), app.debugDescription)
        return language
    }
}
