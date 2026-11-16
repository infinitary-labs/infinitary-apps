import XCTest

/// The languages part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// The approved plan for the phone's languages (INF-3675, piece 4): the phone speaks a catalog language iOS picks
    /// for it, right to left in Arabic, and Settings → Appearance's Language row names it and opens iOS Settings.
    /// INF-4241 keeps Arabic (right to left) and Japanese (another script) of the nine catalog languages: that every
    /// catalog language ships its string files, word for word with the catalog and listed in Info.plist, is
    /// `generate-messages.ts --check`'s and tests/generate-messages.test.ts's ("write every catalog language's string files").
    /// Data: the disposable home's join note, the phone's own catalog words and iOS's own language names.
    /// Completion: each language's views pictured, the row naming that language, Arabic's back arrow at the right,
    /// every word on Appearance marked under Apple's surrounding pseudo-language and inside the screen when doubled,
    /// and the row's keys (down from Theme, then Return) bringing iOS Settings forward.
    func testLanguages() async throws {
        try await launchFresh()
        try await join()
        for tag in ["ar", "ja"] {
            try await relaunch(["-AppleLanguages", "(\(tag))", "-AppleLocale", tag.replacingOccurrences(of: "-", with: "_")])
            XCTAssertTrue(app.staticTexts["card-title"].waitForPresence(timeout: 20), app.debugDescription)
            picture("language-\(tag)-cards")
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

    /// Settings → Appearance from the main view, answering its Language row.
    private func openAppearance(fromList: Bool = false) throws -> XCUIElement {
        if !fromList { reachSettings() }
        tapOnPhone(app.buttons["phone-settings-appearance"])
        let language = app.buttons["phone-language"]
        XCTAssertTrue(language.waitForPresence(timeout: 10), app.debugDescription)
        return language
    }
}
