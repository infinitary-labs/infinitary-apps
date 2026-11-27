import XCTest

/// The join-read part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2125 direction C, the first of the join tests split from testJoinAndRecover: a wrong Mac, joining and reading.
    /// Data: the disposable home's join note and a review finding. Completion: the phone reads both cards and its own
    /// sheets, keeps the strip at the largest type, and keeps its connection when idle, streamed to or made inactive.
    func testJoinAndRead() async throws {
        try await launchFresh()
        try await appearances("join", showing: app.staticTexts["Welcome aboard Infinitary"])
        try await submitLink("wrong-link", typed: true)
        XCTAssertTrue(app.staticTexts["This is not the computer your link names. Nothing was sent."].waitForPresence(timeout: 15))
        let refused = try await home("state", method: "GET")
        XCTAssertEqual((refused["devices"] as? [Any])?.count, 0)
        picture("wrong-mac")
        // The one join typed into the paste field, so a pasted link's whole way in stays checked.
        try await join(typed: true)
        // INF-63 accepted B survives the move from the read-only list to native card chrome.
        // Finish the finding before the feed snapshot used by the foundation's Activity checks.
        _ = try await home("review-finding")
        showCard("Review the phone connection finding")
        XCTAssertTrue(app.staticTexts["Review finding"].waitForPresence(timeout: 10))
        // INF-2714: the first mate's card is its own, so its head carries no task's key or title.
        XCTAssertFalse(app.buttons["card-task-key"].exists)
        XCTAssertFalse(app.staticTexts["Check the phone connection"].exists)
        XCTAssertTrue(app.webViews.staticTexts["The review needs your choice on the Mac."].waitForPresence(timeout: 10))
        // INF-64 piece 4's approved native choices replace the foundation's read-only absence check.
        let keepFinding = app.buttons["card-action-keep"]
        XCTAssertTrue(keepFinding.waitForPresence(timeout: 10))
        // INF-1083: body text exists before its drawn acknowledgement enables the native footer.
        waitUntilEnabled(keepFinding)
        XCTAssertTrue(keepFinding.isEnabled)
        picture("review-finding")
        tapOnPhone(app.buttons["put-aside-card"])
        XCTAssertTrue(cardHeading("Your phone is reading your Mac").waitForPresence(timeout: 10))
        let first = try await home("state", method: "GET")
        let devices = try XCTUnwrap(first["devices"] as? [[String: Any]])
        let phone = try XCTUnwrap(devices.first)
        XCTAssertEqual(phone["kind"] as? String, "view")
        XCTAssertEqual(phone["system"] as? String, "ios")
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
        XCTAssertFalse(app.buttons["Merge"].exists)
        XCTAssertTrue(app.webViews.staticTexts["This card belongs to the disposable test home."].firstMatch.waitForPresence(timeout: 10))
        verifyPhoneComposerBounds(app: app)
        picture("cards")
        try await appearances("cards", showing: app.staticTexts["Your phone is reading your Mac"])
        // INF-1062: the computer's name leaves the bar for its page, and Leave stays behind that page (INF-209).
        XCTAssertFalse(app.staticTexts["home-name"].exists, "The bar no longer carries the computer's name")
        XCTAssertFalse(app.buttons["leave"].exists)
        // INF-355: details must also work as the first hardware chord after relaunch. INF-2820 piece 1: Command-I opens
        // Settings at Your computer.
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        try await pressPhoneKey("i", modifiers: .command, in: app)
        XCTAssertTrue(app.staticTexts["home-name"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.staticTexts["home-name"].label, "Test Mac mini")
        XCTAssertTrue(app.staticTexts["Live"].exists, "Your computer says its reach")
        XCTAssertTrue(app.staticTexts["reached-address"].label.hasPrefix("127.0.0.1:"), "Your computer names the route reached, not the saved preference")
        XCTAssertTrue(app.buttons["leave"].exists)
        XCTAssertTrue(app.buttons["add-computer"].exists)
        // Back from Your computer lands on Settings' list, where it is the first row and names the computer and its reach.
        try await settingsBack()
        let computerRow = app.buttons["phone-settings-computer"]
        XCTAssertTrue(computerRow.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Test Mac mini · Live"].exists, "The row names the computer shown and its reach: \(app.debugDescription)")
        XCTAssertLessThan(computerRow.frame.maxY, app.buttons["phone-settings-general"].frame.minY, "Your computer is the list's first row")
        try await appearances("phone-settings-list", showing: computerRow)
        closeComputerDetails()
        // INF-1062, the captain's pick: Settings at the bar's left is this phone's own sheet, with no Leave in it.
        try await pressPhoneKey(",", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForPresence(timeout: 10), app.debugDescription)
        // Accepted phone Settings plan: the same section list on iPhone and iPad, with keyboard reach to each page.
        // Real data: this part's joined disposable home, the built version and this install's saved Theme.
        // Completion: each destination's content, Back restoring the list, and Done closing the sheet.
        let general = app.buttons["phone-settings-general"]
        let appearance = app.buttons["phone-settings-appearance"]
        let integrations = app.buttons["phone-settings-integrations"]
        let devicesSection = app.buttons["phone-settings-devices"]
        XCTAssertTrue(general.waitForPresence(timeout: 10), app.debugDescription)
        // INF-3454: Integrations joins the list once the computer answers its connections, in the desktop's place.
        XCTAssertTrue(integrations.waitForPresence(timeout: 20), app.debugDescription)
        // INF-3563: the five sections the computer answers join the list together. INF-4241: their order, each in the
        // desktop's place, is the settings-pages part's to read (testSettingsPages); the keys below need them listed.
        let computerSections = ["projects", "intelligence", "runbooks", "usage", "automation"].map { app.buttons["phone-settings-\($0)"] }
        for row in computerSections { XCTAssertTrue(row.waitForPresence(timeout: 20), app.debugDescription) }
        XCTAssertFalse(app.staticTexts["app-version"].exists, "Version content lives on General, not the list")
        XCTAssertFalse(phoneThemeTiles.exists)
        XCTAssertFalse(app.buttons["leave"].exists, "Leave stays on Your computer's page, not the list")
        // The list starts on its first row, Your computer. As PhoneKeys owns, Xcode emits the physical Return for LF,
        // not CR. Unmodified keys have no BackBoard registration; send each physical key once and prove its result.
        waitForSteadyTarget(app.buttons["phone-settings-computer"])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(app.buttons["add-computer"].waitForPresence(timeout: 10), app.debugDescription)
        try await settingsBack()
        waitForSteadyTarget(general)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(app.staticTexts["app-version"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["app-version"].label.hasPrefix("Version "), app.staticTexts["app-version"].label)
        try await settingsBack()
        waitForSteadyTarget(appearance)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        try await phoneTheme()
        try await phoneFoldSplit()
        try await settingsBack()
        XCTAssertTrue(app.staticTexts["Theme: Device"].exists, "The list reads the current saved choice")
        // INF-4241: the list's Google line is the google part's to read (testGoogleSignInAndOut).
        waitForSteadyTarget(integrations)
        // Down passes the five sections the computer answers (the settings-pages part opens them) to Integrations.
        for _ in 0...computerSections.count { app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: []) }
        app.typeKey("\n", modifierFlags: [])
        XCTAssertTrue(app.descendants(matching: .any)["google-section"].waitForPresence(timeout: 10), app.debugDescription)
        try await settingsBack()
        waitForSteadyTarget(devicesSection)
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey("\n", modifierFlags: [])
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "This iPad" : "This phone"
        XCTAssertTrue(app.staticTexts[device].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Conversation stays on your computer."].exists)
        XCTAssertFalse(phoneThemeTiles.exists)
        tapOnPhone(app.buttons["close-phone-settings"])
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForAbsence(timeout: 10))
        let settings = app.buttons["phone-settings"]
        XCTAssertTrue(waitForPhonePress(settings)); XCTAssertEqual(settings.label, "Settings")
        let strip = [app.buttons["tab-home"], app.buttons["tab-tasks"], app.buttons["tab-activity"]]
        XCTAssertLessThan(settings.frame.maxX, strip[0].frame.minX, "Settings sits left of the strip")
        // INF-1328: the segmented control draws its tabs edge to edge, in order and never overlapping.
        XCTAssertLessThanOrEqual(strip[0].frame.maxX, strip[1].frame.minX); XCTAssertLessThanOrEqual(strip[1].frame.maxX, strip[2].frame.minX)
        XCTAssertLessThan(strip[2].frame.maxX, app.buttons["computer-details"].frame.minX, "The computer sits right of the strip")
        // INF-2820 piece 1: until piece 2 puts Filter in its place, the computer button opens Settings at Your computer.
        tapOnPhone(app.buttons["computer-details"])
        XCTAssertTrue(app.staticTexts["home-name"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["phone-settings-back"].exists, "The button opens Your computer inside Settings")
        closeComputerDetails()
        XCTAssertTrue(strip[0].isSelected, "Home is the lit tab")
        // INF-1541 piece 1: the card's heading redraws at the largest type before the strip is read against it.
        let heading = app.staticTexts["Your phone is reading your Mac"]
        let standard = waitForRedraw(heading, from: nil)
        // INF-4713's Approve and build: the card's body follows the device's Text Size too, so at the largest standard
        // size its words draw taller than at the default; before, they kept the Mac's sizes at every Text Size.
        waitForShownBodyRevealed()
        let words = app.webViews.matching(identifier: "card-body").firstMatch.staticTexts["This card belongs to the disposable test home."]
        XCTAssertTrue(words.waitForPresence(timeout: 10), app.debugDescription)
        let standardWords = words.frame.height
        _ = try await home("display-large", budget: displayBudget)
        let largest = waitForRedraw(heading, from: standard)
        let grown = NSPredicate { _, _ in words.exists && words.frame.height > standardWords }
        XCTAssertEqual(waitForPhonePredicate(grown, object: nil, timeout: 10), .completed,
                       "At the largest standard Text Size the card's words stayed \(standardWords) points tall")
        XCTAssertTrue(waitForPhonePress(app.buttons["computer-details"]))
        // INF-1062: growing words once truncated Activity and lost a tap on the computer; the bar's computer stays
        // pressable at the largest standard type. INF-4241: that the strip keeps the bar's own size through a change of
        // type size is PhoneShellTests' testTabStripKeepsItsSizeFromLaunch.
        picture("cards-largest-standard-type")
        computerDetails()
        XCTAssertTrue(waitForPhonePress(app.buttons["leave"]))
        picture("computer-details-largest-standard-type")
        closeComputerDetails()
        _ = try await home("display-light", budget: displayBudget)
        _ = waitForRedraw(heading, from: largest)
        if phoneTurnedLayout(app) == .wide {
            // INF-1541 piece 1: turned, the card's heading moves onto the stage beside the sidebar, and back upright.
            turnPhone(to: .landscapeLeft, in: app, moving: heading)
            XCTAssertEqual(phoneShownLayout(app), .wide, "Turned, the app shows the layout read before the turn")
            let sidebar = phoneSidebar(app)
            XCTAssertTrue(sidebar.waitForPresence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
            XCTAssertLessThanOrEqual(sidebar.frame.maxX, app.scrollViews["card-scroll"].frame.minX)
            try await appearances("ipad-landscape", showing: app.staticTexts["Your phone is reading your Mac"])
            // INF-589 item 16: Tasks and Activity are a segmented pair at the sidebar's top, each scrolling alone.
            // INF-944 item 6: in the tabs' order, Tasks then Activity, opening on Tasks.
            let tasksRail = phoneSidebarRail("Tasks", in: sidebar), activityRail = phoneSidebarRail("Activity", in: sidebar)
            XCTAssertLessThan(tasksRail.frame.midX, activityRail.frame.midX, "Tasks comes before Activity")
            XCTAssertTrue(tasksRail.isSelected)
            let waiting = phoneTasksColumn(sidebar)
            XCTAssertTrue(waiting.waitForPresence(timeout: 10), "The sidebar opens on Tasks")
            XCTAssertTrue(waitForPhonePress(waiting))
            XCTAssertLessThanOrEqual(tasksRail.frame.maxY, waiting.frame.minY, "The pair sits at the sidebar's top")
            picture("ipad-landscape-tasks")
            tapOnPhone(activityRail)
            let activity = sidebar.staticTexts.matching(identifier: "activity-text").firstMatch
            XCTAssertTrue(activity.waitForPresence(timeout: 10), "Activity opens at once")
            XCTAssertFalse(waiting.exists)
            XCTAssertLessThanOrEqual(activityRail.frame.maxY, activity.frame.minY)
            tapOnPhone(tasksRail)
            XCTAssertTrue(waiting.waitForPresence(timeout: 10))
            XCTAssertFalse(activity.exists)
            turnPhone(to: .portrait, in: app, moving: heading)
            XCTAssertTrue(sidebar.waitForAbsence(timeout: 10))
        }
        // INF-136 #2: no product traffic for longer than both former pairing deadlines.
        let idle = try await home("idle")
        let idleBefore = try XCTUnwrap(idle["before"] as? [String: Int])
        let idleAfter = try XCTUnwrap(idle["after"] as? [String: Int])
        XCTAssertEqual(idleAfter["connections"], idleBefore["connections"], "An idle phone must keep its existing connection")
        // INF-136 #1/#12: a card revision witnesses processing all preceding stream pushes.
        let stream = try await home("stream")
        XCTAssertTrue(app.staticTexts["Streaming finished"].waitForPresence(timeout: 10))
        let streamed = try await home("state", method: "GET")
        let beforeStream = try XCTUnwrap(stream["before"] as? [String: Int])
        let afterStream = try XCTUnwrap(streamed["readings"] as? [String: Int])
        XCTAssertEqual(afterStream["feed"], beforeStream["feed"], "Streaming does not change Activity")
        XCTAssertEqual(afterStream["cards"], beforeStream["cards"], "The push already carries the card snapshot")
        _ = try await home("stream-reset")
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForPresence(timeout: 10))
        // INF-136 #9: Control Center makes the scene inactive, not backgrounded.
        let beforeInactive = try await home("state", method: "GET")
        // INF-1646: a starved SpringBoard can stall on the pull's first touch, and the system keeps only its first ~180 ms of touches.
        // A default-speed pull lasts over a second, so its lift is dropped and Control Center never finishes opening; this pull lifts
        // within a tenth of a second and waits whole in that queue, so Control Center opens once SpringBoard resumes.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.01)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.65)),
            withVelocity: XCUIGestureVelocity(rawValue: 20_000), thenHoldForDuration: 0)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // A fresh simulator has no connectivity controls; the container itself witnesses the overlay.
        let controlCenter = springboard.otherElements["cc-root-folder-view"]
        XCTAssertTrue(controlCenter.waitForPresence(timeout: 10), springboard.debugDescription)
        // Dismiss the empty simulator's overlay without invoking iPad's Home/window gesture.
        tapOnPhone(springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)))
        XCTAssertTrue(controlCenter.waitForAbsence(timeout: 10))
        app.activate()
        reach("Live", timeout: 10)
        let afterInactive = try await home("state", method: "GET")
        XCTAssertEqual((afterInactive["readings"] as? [String: Int])?["connections"],
            (beforeInactive["readings"] as? [String: Int])?["connections"], "An inactive scene keeps its connection")
    }

    /// Back uses the system's Command-[ chord, witnessed through the existing key owner before one press.
    private func settingsBack() async throws {
        let back = app.buttons["phone-settings-back"]
        XCTAssertTrue(back.waitForPresence(timeout: 10), app.debugDescription)
        waitForSteadyTarget(back)
        try await pressPhoneKey("[", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["phone-settings-general"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(back.waitForAbsence(timeout: 10), "Back leaves the destination once its navigation transition finishes")
    }

    /// The captain's Approve and build on the phone's own theme, from Settings open on a light simulator: Dark drawn
    /// dark across the whole screen with the simulator still light, still dark after a relaunch, and Device chosen by
    /// keyboard (the left arrow) follows the simulator's light again. Leaves Settings open, drawing light.
    /// Data: the join part's test home and its one card. Resources: this part's own simulator; no account or signing.
    func phoneTheme() async throws {
        let theme = phoneThemeTiles
        XCTAssertTrue(theme.waitForPresence(timeout: 10), app.debugDescription)
        try await appearances("phone-settings-appearance", showing: theme)
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        XCTAssertEqual(app.staticTexts["phone-theme-scope"].label, "Set on this \(device) only. Test Mac mini keeps its own.")
        // INF-4713: under Theme, one line names where the size of Infinitary's words is set, with no control of its own.
        XCTAssertEqual(app.staticTexts["phone-text-size"].label,
                       "Infinitary follows this \(device)'s Text Size. For Infinitary alone, use Text Size in Control Center.")
        // INF-6888's part 3: the built-in color themes follow Device, Dark and Light under their makers' names.
        XCTAssertEqual(theme.buttons.allElementsBoundByIndex.map(\.label),
                       ["Device", "Dark", "Light"] + Self.builtInThemes.map(\.name))
        XCTAssertTrue(theme.buttons["Device"].isSelected, "A new install matches the device")
        tapOnPhone(theme.buttons["Dark"])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: theme.buttons["Dark"], timeout: 10), .completed)
        try drawn("phone-theme-dark", dark: true)
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForPresence(timeout: 10), app.debugDescription)
        try drawn("phone-theme-dark-relaunched", dark: true)
        try await pressPhoneKey(",", modifiers: .command, in: app)
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), "Command-Comma opens the list after relaunch")
        XCTAssertFalse(theme.exists)
        tapOnPhone(appearance)
        XCTAssertTrue(theme.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(theme.buttons["Dark"].isSelected, "The choice survives a relaunch")
        waitForSteadyTarget(theme)
        // BackBoard publishes only chords with a modifier, so an unmodified arrow has no registration to wait for; as
        // INF-1066's browsing keys, it is one actual input with visible-result proof, no wait or retry.
        app.typeKey(XCUIKeyboardKey.leftArrow.rawValue, modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: theme.buttons["Device"], timeout: 10),
                       .completed, "In Settings the left arrow moves the theme from Dark to Device")
        try drawn("phone-theme-device", dark: false)
        try await phoneColorThemes()
        try await phoneOwnTheme()
    }

    /// INF-7024: an own theme saved at the computer reaches Settings, open on the phone, under Yours after the built-in
    /// themes; picked, it draws the whole screen on its base and Settings' quiet words in the computer's worked-out
    /// colors; removed at the computer, it leaves Yours and the pick goes back to its base, Dark. Device is chosen again.
    /// Data: the join part's test home and INF-6888's old green terminal. Leaves Settings open, drawing light.
    private func phoneOwnTheme() async throws {
        let theme = phoneThemeTiles, scope = app.staticTexts["phone-theme-scope"], yours = app.staticTexts["phone-theme-yours"]
        XCTAssertFalse(yours.exists, "No own theme shows no Yours")
        _ = try await home("own-theme-save")
        let terminal = theme.buttons["phone-theme-own-old-terminal"]
        XCTAssertTrue(terminal.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(yours.label, "Yours")
        // The tile added later can come first in the accessibility tree, so where it sits is read from its frame.
        let labels = theme.buttons.allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(labels.filter { $0 != "Old terminal" }, ["Device", "Dark", "Light"] + Self.builtInThemes.map(\.name))
        XCTAssertEqual(labels.filter { $0 == "Old terminal" }.count, 1, "The own theme is one tile, under its own name")
        XCTAssertLessThan(theme.buttons["Tokyo Night"].frame.maxY, yours.frame.minY, "Yours follows the built-in themes")
        XCTAssertLessThanOrEqual(yours.frame.maxY, terminal.frame.minY)
        // On an iPhone the built-in themes can fill the sheet, so Yours is brought up into view for its picture.
        for _ in 0..<3 where !terminal.isHittable { theme.swipeUp(velocity: .slow) }
        XCTAssertTrue(terminal.isHittable, app.debugDescription)
        picture("phone-theme-yours")
        let shown = waitForRedraw(scope, from: nil)
        tapOnPhone(terminal)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: terminal, timeout: 10), .completed)
        _ = waitForRedraw(scope, from: shown)
        // The computer's workOutTheme gives the old terminal's quiet words (--fg-2) #209a39 from its text #3ddc5a.
        waitForInks("Old terminal", [(0x209a39, scope, 300, "Settings' quiet words")])
        try drawn("phone-theme-old-terminal", dark: true)
        _ = try await home("own-theme-remove")
        XCTAssertTrue(terminal.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertFalse(yours.exists, "The last own theme removed takes Yours away")
        XCTAssertTrue(theme.buttons["Dark"].isSelected, "A removed pick goes back to its base")
        try drawn("phone-theme-own-removed", dark: true)
        tapOnPhone(theme.buttons["Device"])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: theme.buttons["Device"], timeout: 10), .completed)
        try drawn("phone-theme-device-after-own", dark: false)
    }

    /// INF-6888's part 3, the computer's built-in themes in the computer's order: each one's base, and its background
    /// (--bg-0, `PhoneTheme.background`) and quiet words (--fg-2, `PhoneTheme.secondary`) as the computer's
    /// workOutTheme in src/shared/colorThemes.ts works them out for the captain's chosen themes.
    private static let builtInThemes: [(name: String, dark: Bool, background: UInt32, quiet: UInt32)] = [
        ("Rosé Pine", true, 0x191724, 0x9796ae), ("Rosé Pine Moon", true, 0x232136, 0xa5a4bc),
        ("Rosé Pine Dawn", false, 0xfaf4ed, 0x716b95), ("Catppuccin Latte", false, 0xeff1f5, 0x696c88),
        ("Catppuccin Frappé", true, 0x303446, 0xb5bfe3), ("Catppuccin Macchiato", true, 0x24273a, 0xa3accc),
        ("Catppuccin Mocha", true, 0x1e1e2e, 0x97a1bc), ("One Dark", true, 0x282c34, 0xa7b4c9),
        ("One Light", false, 0xeaeaeb, 0x64697f), ("Dracula", true, 0x282a36, 0xb2b399),
        ("Night Owl", true, 0x011627, 0x8896ab), ("Night Owl Light", false, 0xf0f0f0, 0x6d6b83),
        ("Tokyo Night", true, 0x1a1b26, 0x919ac3),
    ]

    /// The order the themes are picked in: every one once, with a switch between two themes on one base (Rosé Pine to
    /// Rosé Pine Moon, Dracula to Tokyo Night) and from a dark theme to a light one (Tokyo Night to Catppuccin Latte).
    private static let themeVisits = ["Rosé Pine", "Rosé Pine Moon", "Rosé Pine Dawn", "Catppuccin Frappé", "Catppuccin Macchiato",
        "Catppuccin Mocha", "One Dark", "One Light", "Night Owl", "Night Owl Light", "Dracula", "Tokyo Night", "Catppuccin Latte"]

    /// INF-6888's part 3: each built-in theme, tapped in turn on a light simulator, draws the whole screen on its own
    /// base and Settings' quiet words in its own colors; with Settings closed, the home behind it draws on the theme's
    /// background and its card's body in the theme's quiet words, without a relaunch. Dracula is then picked again and
    /// survives a relaunch; Device is chosen again. Leaves Settings open, drawing light.
    private func phoneColorThemes() async throws {
        let theme = phoneThemeTiles, scope = app.staticTexts["phone-theme-scope"]
        var shown = waitForRedraw(scope, from: nil)
        let visits = Self.themeVisits + ["Dracula"]
        for (visit, name) in visits.enumerated() {
            let look = try XCTUnwrap(Self.builtInThemes.first { $0.name == name })
            let again = visits[..<visit].contains(name) ? "-again" : ""
            let slug = "phone-theme-" + name.lowercased().replacingOccurrences(of: " ", with: "-") + again
            tapOnPhone(theme.buttons[name])
            XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: theme.buttons[name], timeout: 10),
                           .completed, "\(name) is chosen")
            shown = waitForRedraw(scope, from: shown)
            waitForInks(name, [(look.quiet, scope, 300, "Settings' quiet words")])
            try drawn(slug, dark: look.dark)
            let close = app.buttons["close-phone-settings"]
            tapOnPhone(close)
            XCTAssertTrue(close.waitForAbsence(timeout: 10), app.debugDescription)
            try homeDrawn(in: look, slug + "-home")
            if visit == visits.count - 1 { break }
            try reopenAppearance()
            shown = waitForRedraw(scope, from: nil)
        }
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        let dracula = try XCTUnwrap(Self.builtInThemes.first { $0.name == "Dracula" })
        try homeDrawn(in: dracula, "phone-theme-dracula-relaunched")
        try reopenAppearance()
        XCTAssertTrue(theme.buttons["Dracula"].isSelected, "A built-in theme survives a relaunch")
        tapOnPhone(theme.buttons["Device"])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: theme.buttons["Device"], timeout: 10), .completed)
        try drawn("phone-theme-device-again", dark: false)
    }

    /// The home with its card, drawn in `look`: the page on its background and the card's body in its quiet words.
    private func homeDrawn(in look: (name: String, dark: Bool, background: UInt32, quiet: UInt32), _ name: String) throws {
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForPresence(timeout: 10), app.debugDescription)
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        XCTAssertTrue(body.waitForPresence(timeout: 10), app.debugDescription)
        waitForInks(look.name, [(look.background, nil, 100_000, "the home's background"), (look.quiet, body, 300, "the card body's quiet words")])
        try drawn(name, dark: look.dark)
    }

    private func reopenAppearance() throws {
        tapOnPhone(app.buttons["phone-settings"])
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(appearance)
        XCTAssertTrue(phoneThemeTiles.waitForPresence(timeout: 10), app.debugDescription)
    }

    /// INF-6888's part 3: waits until one screenshot draws each ink, an sRGB color, on at least `least` pixels inside its
    /// element's frame, or the whole screen for nil. A view left on the previous theme's colors draws none of them: the
    /// built-in themes share no background or quiet words.
    private func waitForInks(_ theme: String, _ inks: [(color: UInt32, element: XCUIElement?, least: Int, what: String)]) {
        var counts = [Int](repeating: 0, count: inks.count)
        _ = waitForPhonePredicate(NSPredicate { _, _ in
            guard let image = XCUIScreen.main.screenshot().image.cgImage, let raster = SRGBRaster(image) else { return false }
            let scale = CGFloat(image.width) / self.app.frame.width
            counts = inks.map { raster.count($0.color, in: $0.element.map { $0.frame.applying(CGAffineTransform(scaleX: scale, y: scale)) }) }
            return zip(counts, inks).allSatisfy { $0 >= $1.least }
        }, object: nil, timeout: 10)
        for (count, ink) in zip(counts, inks) {
            XCTAssertGreaterThanOrEqual(count, ink.least, "\(ink.what) draw \(theme)'s \(String(ink.color, radix: 16))")
        }
    }

    /// The captain's Split at the fold switch by keys, on a simulator told at launch that it has seen a fold, as an open
    /// iPhone Duo would: Theme holds focus as Appearance opens, the down arrow passes Language to the switch, Space and
    /// Return each flip it, and the choice it was left at survives a relaunch. Leaves Appearance open with the switch off.
    /// Data: the join part's test home. Resources: this part's own simulator; no account or signing.
    func phoneFoldSplit() async throws {
        app.launchEnvironment["INFINITARY_FOLD_SEEN"] = "1"
        app.terminate(); try await launchPhoneApp(app)
        app.launchEnvironment.removeValue(forKey: "INFINITARY_FOLD_SEEN")
        reach("Live", timeout: 20)
        try await openAppearanceByKeys()
        let split = app.switches["phone-fold-split"]
        XCTAssertTrue(split.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(split.value as? String, "1", "Split at the fold starts on")
        waitForSteadyTarget(phoneThemeTiles)
        // As phoneTheme's arrow, each unmodified key is one actual input with visible-result proof, no wait or retry.
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        app.typeKey(" ", modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == '0'"), object: split, timeout: 10), .completed,
                       "Down past Language reaches the switch and Space turns it off: \(app.debugDescription)")
        // As PhoneKeys owns, Xcode emits the physical Return for LF, not CR.
        app.typeKey("\n", modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == '1'"), object: split, timeout: 10), .completed,
                       "Return turns the switch back on")
        app.typeKey(" ", modifierFlags: [])
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == '0'"), object: split, timeout: 10), .completed,
                       "Space turns it off again")
        app.terminate(); try await launchPhoneApp(app)
        reach("Live", timeout: 20)
        try await openAppearanceByKeys()
        XCTAssertTrue(split.waitForPresence(timeout: 10), "The switch stays once a fold was seen: \(app.debugDescription)")
        XCTAssertEqual(split.value as? String, "0", "The choice survives a relaunch")
    }

    private func openAppearanceByKeys() async throws {
        try await pressPhoneKey(",", modifiers: .command, in: app)
        let appearance = app.buttons["phone-settings-appearance"]
        XCTAssertTrue(appearance.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(appearance)
        XCTAssertTrue(phoneThemeTiles.waitForPresence(timeout: 10), app.debugDescription)
    }
}

/// A screenshot's pixels in sRGB, the space the themes' colors are written in.
private struct SRGBRaster {
    let width: Int, height: Int, bytes: [UInt8]

    init?(_ image: CGImage) {
        let (width, height) = (image.width, image.height)
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        (self.width, self.height, self.bytes) = (width, height, bytes)
    }

    /// Pixels inside `frame` (in pixels, the whole picture for nil) within one step per channel of `color`, the rounding a
    /// simulator's screenshot leaves on an sRGB color. The whole picture is read at every third pixel each way and scaled.
    func count(_ color: UInt32, in frame: CGRect?) -> Int {
        let all = CGRect(x: 0, y: 0, width: width, height: height)
        let area = (frame ?? all).integral.intersection(all)
        guard !area.isNull, !area.isEmpty else { return 0 }
        let step = frame == nil ? 3 : 1
        let (r, g, b) = (Int(color >> 16 & 0xff), Int(color >> 8 & 0xff), Int(color & 0xff))
        var matching = 0
        bytes.withUnsafeBufferPointer { pixels in
            for y in stride(from: Int(area.minY), to: Int(area.maxY), by: step) {
                for x in stride(from: Int(area.minX), to: Int(area.maxX), by: step) {
                    let at = (y * width + x) * 4
                    if abs(Int(pixels[at]) - r) <= 1, abs(Int(pixels[at + 1]) - g) <= 1, abs(Int(pixels[at + 2]) - b) <= 1 { matching += 1 }
                }
            }
        }
        return matching * step * step
    }
}
