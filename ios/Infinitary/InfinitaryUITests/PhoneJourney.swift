import XCTest

/// INF-64 piece 2's requested journey. Real TLS/core, disposable home and simulator; never a provider account.
/// Result: the same phone identity rejoins after launch, reads cards/feed, catches up and leaves/removes.
/// Prerequisites: iOS 18+ simulator, scripts/phone-test-home.ts; no camera, local network or signing material.
@MainActor final class PhoneJourney: XCTestCase {
    private let app = XCUIApplication()
    private var control: String { ProcessInfo.processInfo.environment["PHONE_TEST_HOME"]! }

    private func home(_ command: String, method: String = "POST", body: String? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: control + "/" + command)!)
        request.httpMethod = method
        request.httpBody = body.map { Data($0.utf8) }
        let (data, response) = try await phoneTestSession.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func picture(_ name: String) {
        // Capture the display, not an app-window crop computed before an iPad rotation.
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }

    private func appearances(_ name: String) async throws {
        picture(name)
        _ = try await home("display-dark")
        app.activate() // XCTest waits for the native appearance transition to become idle.
        picture(name + "-dark")
        _ = try await home("display-light")
        app.activate()
    }

    private func computerDetails() {
        let details = app.buttons["computer-details"]
        XCTAssertTrue(details.waitForPresence(timeout: 10))
        XCTAssertEqual(details.label, "Your computer")
        details.tap()
        XCTAssertTrue(app.buttons["close-computer-details"].waitForPresence(timeout: 10))
    }

    private func tab(_ name: String) {
        // INF-1062: the tabs are words in the top bar's strip, the same on iPhone and an upright iPad; the pressed one lights.
        let tab = app.buttons["tab-" + name.lowercased()]
        XCTAssertTrue(tab.waitForPresence(timeout: 10), app.debugDescription); tab.tap()
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "selected == true"), object: tab, timeout: 10), .completed, "\(name) is the lit tab after its press")
    }

    /// INF-1062: in reach the bar says nothing; the computer button's value carries the reach for VoiceOver,
    /// and a line under the bar says it only while the computer is not in reach.
    private func reach(_ words: String, timeout: TimeInterval = 20) {
        let button = app.buttons["computer-details"]
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == %@", words), object: button, timeout: timeout), .completed, app.debugDescription)
        if words == "In reach" { XCTAssertFalse(app.otherElements["reach-line"].exists, "In reach, no line under the bar repeats it") }
    }

    private func background() async throws {
        XCUIDevice.shared.press(.home)
        _ = try await home("disconnected")
    }

    private func submitLink(_ command: String = "link") async throws {
        let invitation = try await home(command)
        let link = try XCTUnwrap(invitation["link"] as? String)
        app.buttons["paste-link"].tap()
        let field = app.textFields["join-link"]
        XCTAssertTrue(field.waitForPresence(timeout: 10))
        field.tap()
        // A fresh iOS keyboard presents its own typing guide before accepting other taps.
        if app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."].exists {
            app.buttons["Continue"].tap()
        }
        field.typeText(link)
        app.buttons["read-link"].tap()
        // iOS 26 exposes a dialog's native button and its SwiftUI label as nested buttons.
        let confirm = app.buttons["confirm-join"].firstMatch
        XCTAssertTrue(confirm.waitForPresence(timeout: 10))
        // INF-589 item 4: the cancel choice stays in view beside Join, where a popover would hide it.
        XCTAssertTrue(app.alerts.buttons["Cancel"].firstMatch.isHittable, app.debugDescription)
        confirm.tap()
    }

    private func join() async throws {
        try await submitLink()
        reach("In reach", timeout: 20)
    }

    // INF-662 piece 2 (the captain's "Both at once, journey in parts"): the journey's four parts are
    // four tests, each run from its own fresh home and simulator (scripts/phone-test-plan.ts), side by side.
    // Every check the single journey made stays, in the part it belongs to; each part first reaches the
    // state the single journey reached before that part.
    private func launchFresh() async throws {
        continueAfterFailure = false
        app.launchEnvironment["INFINITARY_ISOLATED_PHONE_TEST"] = "1"
        XCUIDevice.shared.orientation = .portrait
        try await launchPhoneApp(app)
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 10), app.debugDescription)
    }

    private func launchJoined() async throws {
        try await launchFresh()
        try await join()
        XCTAssertTrue(cardHeading("Your phone is reading your Mac").waitForPresence(timeout: 10), app.debugDescription)
    }

    /// Part 1, join and recover: a wrong Mac, joining, reading, relaunch, out of reach, catch-up, Leave, Forget and Removed.
    func testJoinAndRecover() async throws {
        try await launchFresh()
        try await appearances("join")
        try await submitLink("wrong-link")
        XCTAssertTrue(app.staticTexts["This is not the computer your link names. Nothing was sent."].waitForPresence(timeout: 15))
        let refused = try await home("state", method: "GET")
        XCTAssertEqual((refused["devices"] as? [Any])?.count, 0)
        picture("wrong-mac")
        try await join()
        // INF-63 accepted B survives the move from the read-only list to native card chrome.
        // Finish the finding before the feed snapshot used by the foundation's Activity checks.
        _ = try await home("review-finding")
        showCard("Review the phone connection finding")
        XCTAssertTrue(app.staticTexts["Review finding"].waitForPresence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Check the phone connection"].exists)
        XCTAssertTrue(app.webViews.staticTexts["The review needs your choice on the Mac."].waitForPresence(timeout: 10))
        // INF-64 piece 4's approved native choices replace the foundation's read-only absence check.
        let keepFinding = app.buttons["card-action-keep"]
        XCTAssertTrue(keepFinding.waitForPresence(timeout: 10))
        // INF-1083: body text exists before its drawn acknowledgement enables the native footer.
        waitUntilEnabled(keepFinding)
        XCTAssertTrue(keepFinding.isEnabled)
        picture("review-finding")
        app.buttons["close-card"].tap()
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
        try await appearances("cards")
        // INF-1062: the computer's name leaves the bar for its sheet, and Leave stays behind that sheet (INF-209).
        XCTAssertFalse(app.staticTexts["home-name"].exists, "The bar no longer carries the computer's name")
        XCTAssertFalse(app.buttons["leave"].exists)
        // INF-355: details must also work as the first hardware chord after relaunch.
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        try await pressPhoneKey("i", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["close-computer-details"].waitForPresence(timeout: 10))
        XCTAssertEqual(app.staticTexts["home-name"].label, "Test Mac mini")
        XCTAssertTrue(app.staticTexts["In reach"].exists, "The computer's sheet says its reach")
        XCTAssertTrue(app.staticTexts["reached-address"].label.hasPrefix("127.0.0.1:"), "The sheet names the route reached, not the saved preference")
        XCTAssertTrue(app.buttons["leave"].exists)
        try await appearances("computer-details")
        app.buttons["close-computer-details"].tap()
        // INF-1062, the captain's pick: Settings at the bar's left is this phone's own sheet, with no Leave in it.
        try await pressPhoneKey(",", modifiers: .command, in: app)
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["app-version"].label.hasPrefix("Version "), app.staticTexts["app-version"].label)
        XCTAssertFalse(app.buttons["leave"].exists)
        try await appearances("phone-settings")
        app.buttons["close-phone-settings"].tap()
        XCTAssertTrue(app.buttons["close-phone-settings"].waitForAbsence(timeout: 10))
        let settings = app.buttons["phone-settings"]
        XCTAssertTrue(settings.isHittable); XCTAssertEqual(settings.label, "Settings")
        let strip = [app.buttons["tab-home"], app.buttons["tab-tasks"], app.buttons["tab-activity"]]
        XCTAssertLessThan(settings.frame.maxX, strip[0].frame.minX, "Settings sits left of the strip")
        XCTAssertLessThan(strip[0].frame.maxX, strip[1].frame.minX); XCTAssertLessThan(strip[1].frame.maxX, strip[2].frame.minX)
        XCTAssertLessThan(strip[2].frame.maxX, app.buttons["computer-details"].frame.minX, "The computer sits right of the strip")
        XCTAssertTrue(strip[0].isSelected, "Home is the lit tab")
        let stripFrames = strip.map { $0.frame.integral }
        _ = try await home("display-large")
        XCTAssertTrue(app.buttons["computer-details"].isHittable)
        // INF-1062: the strip keeps the bar's own size at the largest standard type, so no word truncates and the
        // bar's buttons stay where they were; growing words once truncated Activity and lost a tap on the computer.
        XCTAssertEqual(strip.map { $0.frame.integral }, stripFrames, "The strip's words keep the bar's own size at the largest type")
        picture("cards-largest-standard-type")
        computerDetails()
        XCTAssertTrue(app.buttons["leave"].isHittable)
        picture("computer-details-largest-standard-type")
        app.buttons["close-computer-details"].tap()
        _ = try await home("display-light")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            app.activate()
            let sidebar = phoneSidebar(app)
            XCTAssertTrue(sidebar.waitForPresence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
            XCTAssertLessThanOrEqual(sidebar.frame.maxX, app.scrollViews["card-scroll"].frame.minX)
            try await appearances("ipad-landscape")
            // INF-589 item 16: Tasks and Activity are a segmented pair at the sidebar's top, each scrolling alone.
            // INF-944 item 6: in the tabs' order, Tasks then Activity, opening on Tasks.
            let tasksRail = phoneSidebarRail("Tasks", in: sidebar), activityRail = phoneSidebarRail("Activity", in: sidebar)
            XCTAssertLessThan(tasksRail.frame.midX, activityRail.frame.midX, "Tasks comes before Activity")
            XCTAssertTrue(tasksRail.isSelected)
            let waiting = sidebar.buttons["group-waiting"]
            XCTAssertTrue(waiting.waitForPresence(timeout: 10), "The sidebar opens on Tasks")
            XCTAssertTrue(waiting.isHittable)
            XCTAssertLessThanOrEqual(tasksRail.frame.maxY, waiting.frame.minY, "The pair sits at the sidebar's top")
            picture("ipad-landscape-tasks")
            activityRail.tap()
            let activity = sidebar.staticTexts.matching(identifier: "activity-text").firstMatch
            XCTAssertTrue(activity.waitForPresence(timeout: 10), "Activity opens at once")
            XCTAssertFalse(waiting.exists)
            XCTAssertLessThanOrEqual(activityRail.frame.maxY, activity.frame.minY)
            tasksRail.tap()
            XCTAssertTrue(waiting.waitForPresence(timeout: 10))
            XCTAssertFalse(activity.exists)
            XCUIDevice.shared.orientation = .portrait
            app.activate()
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
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.01)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.65)))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // A fresh simulator has no connectivity controls; the container itself witnesses the overlay.
        let controlCenter = springboard.otherElements["cc-root-folder-view"]
        XCTAssertTrue(controlCenter.waitForPresence(timeout: 10), springboard.debugDescription)
        // Dismiss the empty simulator's overlay without invoking iPad's Home/window gesture.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        XCTAssertTrue(controlCenter.waitForAbsence(timeout: 10))
        app.activate()
        reach("In reach", timeout: 10)
        let afterInactive = try await home("state", method: "GET")
        XCTAssertEqual((afterInactive["readings"] as? [String: Int])?["connections"],
            (beforeInactive["readings"] as? [String: Int])?["connections"], "An inactive scene keeps its connection")
        tab("Activity")
        let feed = try XCTUnwrap(first["feed"] as? [[String: Any]])
        let line = try XCTUnwrap(feed.first?["text"] as? String)
        XCTAssertTrue(app.staticTexts[line].waitForPresence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "activity-text").firstMatch.label, feed.last?["text"] as? String)
        try await appearances("activity")
        tab("Home")
        _ = try await home("empty-cards")
        // INF-1060: as on the Mac, the empty stage is the character alone, with no line under it.
        XCTAssertTrue(app.otherElements["phone-character"].waitForPresence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == 'No cards to read yet.'")).count, 0)
        // INF-589 item 11: with no card to page, the chevrons and count hide; the cards just closed stay under Past cards.
        for id in ["previous-card", "next-card"] {
            XCTAssertFalse(app.buttons[id].exists, "\(id) shows on an empty stage")
        }
        let pastOnly = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        XCTAssertTrue(pastOnly.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(pastOnly.label, "Past cards")
        _ = try await home("capture-character-start")
        try await appearances("empty-stage")
        _ = try await home("capture-stop")
        _ = try await home("stream-reset")
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForPresence(timeout: 10))

        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        let afterLaunch = try await home("state", method: "GET")
        XCTAssertEqual((afterLaunch["devices"] as? [[String: Any]])?.first?["id"] as? String, phone["id"] as? String)

        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForPresence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
        // INF-589 item 11: out of reach is said once; under the composer, one line says only that changes are off.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'out of reach' AND NOT (label ==[c] 'Out of reach')")).count, 0,
            app.debugDescription)
        XCTAssertEqual(app.staticTexts["connection-refusal"].label, "Changes are off until Test Mac mini is back.")
        try await appearances("out-of-reach")
        computerDetails()
        XCTAssertTrue(app.buttons["forget-mac"].exists)
        picture("computer-details-out-of-reach")
        app.buttons["close-computer-details"].tap()
        // Record the recovery itself, not the separate appearance and details checks above.
        _ = try await home("capture-start")
        let change = try await home("change")
        _ = try await home("online")
        reach("In reach", timeout: 20)
        let title = try XCTUnwrap(change["title"] as? String)
        showCard(title)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10))
        picture("caught-up")
        _ = try await home("capture-stop")
        tab("Activity")
        let caughtUp = try await home("state", method: "GET")
        let caughtUpFeed = try XCTUnwrap(caughtUp["feed"] as? [[String: Any]])
        let newest = try XCTUnwrap(caughtUpFeed.last?["text"] as? String)
        XCTAssertTrue(app.staticTexts[newest].waitForPresence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "activity-text").firstMatch.label, newest)
        let taskKey = try XCTUnwrap(caughtUpFeed.last?["taskKey"] as? String)
        XCTAssertTrue(app.staticTexts[taskKey].exists, "Activity shows the actual computer-authored task key")
        picture("activity-caught-up")
        // INF-1062, the captain: Activity runs to the foot with nothing over it, so after scrolling to its end
        // the last row is whole in the window and pressable; the message box belongs to Home.
        XCTAssertFalse(app.textFields["message-box"].exists, "Activity has no message box over it")
        XCTAssertFalse(app.otherElements["phone-composer"].exists)
        let long = try await home("long-activity")
        let newestLine = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", try XCTUnwrap(long["newest"] as? String))).firstMatch
        XCTAssertTrue(newestLine.waitForPresence(timeout: 10), app.debugDescription)
        let oldest = app.staticTexts.matching(NSPredicate(format: "label == %@", try XCTUnwrap(caughtUpFeed.first?["text"] as? String))).firstMatch
        let list = app.scrollViews["activity-list"]
        for _ in 0..<12 where !(oldest.exists && oldest.isHittable) { list.swipeUp() }
        XCTAssertTrue(oldest.isHittable, "The oldest line, the last row, can be reached and pressed: \(app.debugDescription)")
        XCTAssertLessThanOrEqual(oldest.frame.maxY, app.frame.maxY, "The last row is whole in the window")
        picture("activity-end")
        tab("Home")

        // A background/foreground return keeps the home's epoch and exercises replay, not a reload.
        try await background()
        let whileAway = try await home("change")
        app.activate()
        reach("In reach", timeout: 20)
        let replayed = try XCTUnwrap(whileAway["title"] as? String)
        showCard(replayed)
        XCTAssertTrue(app.staticTexts[replayed].waitForPresence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", replayed)).count, 1)

        computerDetails()
        app.buttons["leave"].tap()
        // INF-589 item 4: Keep it stays in view beside Leave.
        XCTAssertTrue(app.alerts.buttons["Keep it"].firstMatch.waitForPresence(timeout: 10))
        XCTAssertTrue(app.alerts.buttons["Keep it"].firstMatch.isHittable, app.debugDescription)
        app.buttons["confirm-leave"].firstMatch.tap()
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 20), app.debugDescription)
        let afterLeave = try await home("state", method: "GET")
        XCTAssertEqual((afterLeave["devices"] as? [Any])?.count, 0)
        try await join()
        // INF-136 #4: a Mac that cannot answer must not keep the phone joined forever.
        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForPresence(timeout: 20))
        computerDetails()
        app.buttons["forget-mac"].tap()
        XCTAssertTrue(app.alerts.buttons["Keep it"].firstMatch.waitForPresence(timeout: 10))
        XCTAssertTrue(app.alerts.buttons["Keep it"].firstMatch.isHittable, app.debugDescription)
        picture("forget-confirmation")
        app.buttons["confirm-forget"].firstMatch.tap()
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 10))
        app.terminate(); try await launchPhoneApp(app)
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 10))
        picture("forgotten")
        let afterForget = try await home("state", method: "GET")
        XCTAssertEqual((afterForget["devices"] as? [Any])?.count, 1, "Forgetting locally does not claim the Mac removed the phone")
        _ = try await home("online")
        try await join() // Fresh-link recovery reuses the identity still listed on this Mac.
        _ = try await home("remove")
        XCTAssertTrue(app.staticTexts["Removed from your computer"].waitForPresence(timeout: 20), app.debugDescription)
        try await appearances("removed")
        app.buttons["join-again"].tap()
        XCTAssertTrue(app.buttons["paste-link"].exists)
        // INF-136 #3: two genuine 401s separated by an unreachable address still prove removal.
        try await submitLink("link-with-unreachable")
        reach("In reach", timeout: 20)
        try await background()
        _ = try await home("link") // Keep the real home listening after its final phone is removed.
        let removed = try await home("remove")
        app.activate()
        XCTAssertTrue(app.staticTexts["Removed from your computer"].waitForPresence(timeout: 20), app.debugDescription)
        picture("removed-after-away")
        let removal = try await home("state", method: "GET")
        let before = try XCTUnwrap(removed["before"] as? [String: Int])
        let after = try XCTUnwrap(removal["readings"] as? [String: Int])
        func since(_ reading: String) throws -> Int { try XCTUnwrap(after[reading]) - XCTUnwrap(before[reading]) }
        let readings = "before removal \(before), after \(after)"
        XCTAssertEqual(try since("refusals"), 2, "Two authenticated refusals, and no more, prove removal: \(readings)")
        // INF-1168: the phone tries the home, then the stalled address, each round. A starved simulator can also
        // outlast the phone's own handshake deadline at the home, which sends no request and adds a round, so the
        // address order, not the clock, fixes the count: one stall after every attempt at the home but the last.
        XCTAssertEqual(try since("stalledConnections"), try since("homeAttempts") - 1,
            "Removal survives a stalled handshake with no HTTP response between authenticated refusals: \(readings)")
        app.buttons["join-again"].tap()
        app.terminate(); try await launchPhoneApp(app)
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 10))
        // INF-136 re-review #1: a damaged saved record must not block a fresh confirmed link.
        try await join()
        let beforeDamage = try await home("state", method: "GET")
        let retainedIDs = (beforeDamage["devices"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
        XCTAssertEqual(retainedIDs?.count, 1)
        app.terminate()
        _ = try await home("damage-record")
        try await launchPhoneApp(app)
        XCTAssertTrue(app.buttons["paste-link"].waitForPresence(timeout: 10))
        picture("damaged-record")
        try await join()
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForPresence(timeout: 10))
        let afterDamage = try await home("state", method: "GET")
        XCTAssertEqual((afterDamage["devices"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, retainedIDs)
        picture("rejoined-after-damaged-record")
    }

    /// Part 2, cards: forms, paging, answers, pictures, recordings, threads, out-of-reach refusal and large type.
    /// The address part, join by its address (INF-1183, the captain's plan "join a home from the iOS app by SSH
    /// address"): the Mac's own sshd beside the test home signs the phone in, asks its fingerprint once,
    /// refuses its key and a wrong password in plain words, lets in the key the phone shows, and the
    /// phone joins with the link the home's door answers, never shown.
    func testJoinByAddress() async throws {
        try await launchFresh()
        let ssh = try await home("ssh-start")
        let address = try XCTUnwrap(ssh["address"] as? String)
        let port = try XCTUnwrap(ssh["port"] as? Int)
        // The port first, then the address, whose Return continues as Continue does.
        func typeAddress() {
            app.buttons["join-by-address"].tap()
            let field = app.textFields["ssh-address"]
            XCTAssertTrue(field.waitForPresence(timeout: 10), app.debugDescription)
            app.textFields["ssh-port"].tap()
            app.textFields["ssh-port"].typeText(String(port))
            field.tap()
            if app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."].exists {
                app.buttons["Continue"].tap()
            }
            field.typeText(address + "\n")
        }
        XCTAssertTrue(app.buttons["join-by-address"].waitForPresence(timeout: 10))
        picture("join-with-address")
        typeAddress()
        // The first sign-in asks about the computer's key, and Not this one sends nothing.
        let fingerprint = app.staticTexts["ssh-fingerprint"]
        XCTAssertTrue(fingerprint.waitForPresence(timeout: 30), app.debugDescription)
        XCTAssertTrue(fingerprint.label.hasPrefix("SHA256:"), fingerprint.label)
        try await appearances("address-fingerprint")
        app.buttons["ssh-not-this-one"].tap()
        XCTAssertTrue(app.buttons["join-by-address"].waitForPresence(timeout: 10))
        let declined = try await home("state", method: "GET")
        XCTAssertEqual((declined["devices"] as? [Any])?.count, 0)
        // Asked again, since no yes was kept; then trusted.
        typeAddress()
        XCTAssertTrue(fingerprint.waitForPresence(timeout: 30), app.debugDescription)
        app.buttons["ssh-trust"].tap()
        // The computer does not know this phone's key and takes a password.
        let password = app.secureTextFields["ssh-password"]
        XCTAssertTrue(password.waitForPresence(timeout: 30), app.debugDescription)
        let key = app.staticTexts["ssh-public-key"]
        XCTAssertTrue(key.exists)
        try await appearances("address-password")
        password.tap()
        password.typeText("not the password")
        app.buttons["ssh-send-password"].tap()
        let problem = app.staticTexts["ssh-problem"]
        XCTAssertTrue(problem.waitForPresence(timeout: 30), app.debugDescription)
        XCTAssertEqual(problem.label, "127.0.0.1 did not take that password. Nothing was kept.")
        picture("address-wrong-password")
        // The person adds the key the phone shows to their account there, then tries again.
        XCTAssertTrue(key.waitForPresence(timeout: 10))
        _ = try await home("ssh-authorize", body: key.label)
        app.buttons["ssh-try-again"].tap()
        reach("In reach", timeout: 30)
        let joined = try await home("state", method: "GET")
        let devices = try XCTUnwrap(joined["devices"] as? [[String: Any]])
        XCTAssertEqual(devices.count, 1)
        XCTAssertEqual(devices.first?["kind"] as? String, "view")
        XCTAssertEqual(devices.first?["system"] as? String, "ios")
        XCTAssertTrue(cardHeading("Your phone is reading your Mac").waitForPresence(timeout: 10), app.debugDescription)
        picture("address-joined")
    }

    func testCards() async throws {
        try await launchJoined()
        try await verifyCards()
    }

    /// Part 3, talk and tasks: the composer, a photo, task search, start, interrupt, continue and steer.
    func testTalkAndTasks() async throws {
        try await launchJoined()
        // The single journey reached this part with the cards part's hero card on the stage, after a relaunch.
        _ = try await home("empty-cards")
        let hero = try await home("hero-card")
        XCTAssertTrue(cardHeading(try XCTUnwrap(hero["title"] as? String)).waitForPresence(timeout: 10), app.debugDescription)
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        try await talkAndTasks()
    }

    /// Part 4, the character and past choices: a real held turn, saved-sign-in and saved-answer choices, past-card context.
    func testCharacterAndPastChoices() async throws {
        try await launchJoined()
        try await verifyConversationCharacter()
        try await verifyNativeCrewScene()
        try await verifyReviewedCardChoices()
        try await verifyPastMessageContext()
    }

    /// INF-82: a real Mac conversation, not focus, task traffic or a fabricated listening state, drives the character.
    /// The existing mock holds a genuine first-mate turn; its completion signal returns the empty stage to idle.
    private func verifyConversationCharacter() async throws {
        let fixture = try await home("character-fixture")
        let character = app.otherElements["phone-character"]
        XCTAssertTrue(character.waitForPresence(timeout: 10))
        XCTAssertEqual(character.value as? String, "idle")
        // Start before the real typing and Send journey, not immediately before releasing the held turn.
        // The simulator's first recorded frame otherwise arrives after the working state has finished.
        _ = try await home("capture-conversation-start")
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(try XCTUnwrap(fixture["text"] as? String))
        XCTAssertEqual(character.value as? String, "idle", "Typing is not evidence of dictation or listening")
        app.buttons["send-message"].tap()
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == 'working'"), object: character, timeout: 20), .completed)
        picture("character-working")
        _ = try await home("capture-stop")
        try await verifySceneContact()
        let finished = try await home("character-finished")
        XCTAssertEqual(finished["busy"] as? Bool, false)
        XCTAssertEqual(finished["held"] as? Int, 0)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == 'idle'"), object: character, timeout: 20), .completed)
        picture("character-finished")
        _ = try await home("capture-stop")
        try await background()
        _ = try await home("scene-current-home")
        app.activate()
        reach("In reach", timeout: 20)
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'idle'"), object: character)
        await fulfillment(of: [restored], timeout: 20)
    }

    /// INF-1066: an already-running real turn survives a relaunch via its initial snapshot;
    /// an older home sends no unsupported reads and reports unknown until a real activity event.
    private func verifySceneContact() async throws {
        app.terminate()
        try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        let character = app.otherElements["phone-character"]
        let initialBusy = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'working'"), object: character)
        await fulfillment(of: [initialBusy], timeout: 20)
        picture("native-scene-initial-busy")

        try await background()
        _ = try await home("scene-older-home")
        app.activate()
        reach("In reach", timeout: 20)
        XCTAssertEqual(character.value as? String, "Activity unknown")
        let legacy = try await home("scene-observations")
        XCTAssertEqual(legacy["reads"] as? Int, 0, "An older home receives neither new read")
        picture("native-scene-older-home-unknown")
        // The caller finishes this same real held turn and verifies its live idle event before restoring the current home.
    }

    /// INF-1066: actual task records and a paired absent helper supply the desktop-sized scene.
    /// The journey pans by touch, reads richer previews and opens the existing record; both simulator sizes run it.
    /// Its home, model stand-in and recording are disposable. No real sign-in, signing or device is used.
    private func verifyNativeCrewScene() async throws {
        let fixture = try await home("scene-fixture")
        let scene = app.scrollViews["crew-scene"]
        XCTAssertTrue(scene.waitForExistence(timeout: 10))
        let firstID = try XCTUnwrap((fixture["ordinary"] as? [String])?.first)
        let remoteID = try XCTUnwrap(fixture["remote"] as? String)
        let local = app.buttons["crew-task-" + firstID], remote = app.buttons["crew-task-" + remoteID]
        XCTAssertTrue(local.waitForExistence(timeout: 10))
        let character = app.otherElements["phone-character"]
        let centered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            abs(character.frame.midX - scene.frame.midX) < 1 && abs(character.frame.midY - scene.frame.midY) < 1
        }, object: nil)
        await fulfillment(of: [centered], timeout: 10)
        picture("native-scene-crew-home")
        try await verifyCrewKeyboard(scene, character: character)
        _ = try await home("capture-scene-start")
        revealCrew(local, in: scene)
        local.tap()
        XCTAssertTrue(app.otherElements["crew-preview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Check harbour marker 1"].exists)
        picture("native-scene-task-preview")
        app.buttons["close-crew-preview"].tap()
        // A different computer remains a formation beside home, never a pager or a smaller version of every glyph.
        revealCrew(remote, in: scene)
        XCTAssertEqual(remote.value as? String, "Activity unknown")
        picture("native-scene-remote-formation")
        _ = try await home("capture-stop")
        remote.tap()
        XCTAssertTrue(app.staticTexts["Read the offshore chart"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Scene Mac"].exists)
        picture("native-scene-remote-preview")
        app.buttons["open-crew-task"].tap()
        XCTAssertTrue(app.staticTexts["task-record-title"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["task-record-title"].label, "Read the offshore chart")
        picture("native-scene-existing-task-record")
        app.buttons["close-record"].tap()
        let computerID = try XCTUnwrap(fixture["computer"] as? String), programID = try XCTUnwrap(fixture["program"] as? String)
        let mark = app.buttons["crew-task-" + computerID + ":" + programID]
        revealCrew(mark, in: scene)
        // INF-1066: the whole 44-point square answers touch, so a tap near its corner, outside the drawn circle, opens it.
        XCTAssertGreaterThanOrEqual(mark.frame.width + 0.001, 44); XCTAssertGreaterThanOrEqual(mark.frame.height + 0.001, 44)
        mark.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap()
        XCTAssertTrue(app.staticTexts["crew-program-counts"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["crew-program-counts"].label, try XCTUnwrap(fixture["programWords"] as? String))
        picture("native-scene-program-preview")
        app.buttons["close-crew-preview"].tap()
        _ = try await home("scene-stage-finished")
        let noParts = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Program, 0 running parts'"), object: mark)
        await fulfillment(of: [noParts], timeout: 10)
        picture("native-scene-between-program-stages")
        _ = try await home("scene-cleanup")
        XCTAssertTrue(remote.waitForNonExistence(timeout: 10), "A departed task must leave the scene and its touch targets")
    }

    /// INF-1066 and the project's keyboard rule: browse the same live scene without touching it.
    /// The two simulator sizes own their home and keyboard; success is visible displacement and a real preview.
    private func verifyCrewKeyboard(_ scene: XCUIElement, character: XCUIElement) async throws {
        _ = try await home("capture-scene-keyboard-start")
        // INF-1066: the captain chose visible-result proof for these unmodified keys.
        // Command-Shift-C still needs BackBoard's exact-chord/current-process witness.
        func pressBrowsingKey(_ key: String) throws {
            guard waitForPhonePredicate(NSPredicate(format: "value == 'Browsing crew'"), object: scene, timeout: 10) == .completed else {
                XCTFail("The browsing key was not sent: the scene is not browsing")
                throw NSError(domain: "PhoneKeyboard", code: 4, userInfo: [NSLocalizedDescriptionKey: "Crew browsing is not active"])
            }
            // One actual input, no registration wait, native-focus assumption or retry.
            app.typeKey(key == XCUIKeyboardKey.tab.rawValue ? "\t" : key, modifierFlags: [])
        }
        try await pressPhoneKey("c", modifiers: [.command, .shift], in: app)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == 'Browsing crew'"), object: scene, timeout: 10), .completed,
                       "Browse crew enters the app's browsing mode")
        let originalX = character.frame.midX
        try pressBrowsingKey(XCUIKeyboardKey.rightArrow.rawValue)
        let panResult = waitForPhonePredicate(NSPredicate { _, _ in character.frame.midX < originalX - 1 }, object: nil, timeout: 10)
        XCTAssertEqual(panResult, .completed, "Right pans the actual scene")
        picture("native-scene-keyboard-pan")
        try pressBrowsingKey(XCUIKeyboardKey.leftArrow.rawValue)
        let returnResult = waitForPhonePredicate(NSPredicate { _, _ in abs(character.frame.midX - originalX) < 1 }, object: nil, timeout: 10)
        XCTAssertEqual(returnResult, .completed, "Left returns to the same world point")
        try pressBrowsingKey(XCUIKeyboardKey.tab.rawValue)
        let selectedCrew = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'crew-task-' AND value BEGINSWITH 'Selected, '")).firstMatch
        XCTAssertTrue(selectedCrew.waitForPresence(timeout: 10), "Tab reaches a real crewmate")
        XCTAssertTrue(selectedCrew.isHittable, "The selected crewmate is visible in the panned scene")
        let selectedWords = selectedCrew.label.components(separatedBy: ", ")
        let selectedKey = try XCTUnwrap(selectedWords.first)
        let selectedTitle = selectedWords.dropFirst().joined(separator: ", ")
        picture("native-scene-keyboard-crew-selection")
        try pressBrowsingKey(" ")
        let preview = app.otherElements["crew-preview"]
        XCTAssertTrue(preview.waitForPresence(timeout: 10), "Space opens that crewmate's preview")
        XCTAssertTrue(preview.staticTexts[selectedKey].exists)
        XCTAssertTrue(preview.staticTexts[selectedTitle].exists, "The preview belongs to the crewmate selected by Tab")
        picture("native-scene-keyboard-preview")
        _ = try await home("capture-stop")
        app.buttons["close-crew-preview"].tap()
    }

    /// INF-1066: each touch drag moves the scene by the target's current distance from the viewport's center,
    /// read from both frames before the gesture, then holds so no momentum carries it past the target.
    private func revealCrew(_ element: XCUIElement, in scene: XCUIElement) {
        for _ in 0..<8 {
            if element.isHittable { return }
            let viewport = scene.frame, target = element.frame
            // A finger drags content the opposite way the viewport travels; stay inside the viewport's inner area.
            let reach = CGVector(dx: viewport.width * 0.4, dy: viewport.height * 0.4)
            let dx = max(-reach.dx, min(reach.dx, viewport.midX - target.midX))
            let dy = max(-reach.dy, min(reach.dy, viewport.midY - target.midY))
            let start = scene.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = start.withOffset(CGVector(dx: dx, dy: dy))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(element.isHittable, "Continuous panning must reach every visible crewmate")
    }

    /// INF-64 piece 4: a phone answers at the real home, not a local stand-in; opaque scripts cannot gain native effects.
    /// The cards part owns its simulator/home, no shared account or signed build.
    private func cardHeading(_ title: String) -> XCUIElement {
        // INF-64 piece 4: departure means leaving the stage, not erasing INF-82's foreground notice.
        app.staticTexts.matching(identifier: "card-title").matching(NSPredicate(format: "label == %@", title)).firstMatch
    }

    private func showCard(_ title: String) {
        if app.staticTexts["card-title"].label == title { return }
        // SwiftUI Menu is a popup on current iOS; use its own stable identity rather than a legacy button type.
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        XCTAssertTrue(pager.waitForPresence(timeout: 10), app.debugDescription); pager.tap()
        let item = app.buttons[title].firstMatch
        XCTAssertTrue(item.waitForPresence(timeout: 10), app.debugDescription); item.tap()
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10))
    }

    private func reveal(_ element: XCUIElement) {
        let scroll = app.scrollViews["card-scroll"]
        for _ in 0..<8 {
            if element.isHittable { return }
            // Use the card's actual viewport: a whole-screen swipe hits the keyboard while replying.
            if element.exists && element.frame.maxY < scroll.frame.minY { scroll.swipeDown() }
            else { scroll.swipeUp() }
        }
        XCTAssertTrue(element.isHittable, app.debugDescription)
    }

    private func waitUntilEnabled(_ element: XCUIElement) {
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "enabled == true"), object: element, timeout: 10), .completed, app.debugDescription)
    }

    private func verifyCards() async throws {
        let fixture = try await home("cards-fixture")
        let choice = try XCTUnwrap(fixture["choice"] as? String)
        let chart = try XCTUnwrap(fixture["conversation"] as? String)
        let note = try XCTUnwrap(fixture["note"] as? String)
        showCard(choice)
        let boundary = "effect refused · network refused · parent refused · native refused"
        XCTAssertTrue(app.webViews.staticTexts[boundary].waitForPresence(timeout: 20), app.debugDescription)
        // INF-209's native card chrome promises 44-point touch targets, not padding outside a tiny button.
        for id in ["close-card", "previous-card", "next-card", "card-pager"] {
            let control = app.descendants(matching: .any).matching(identifier: id).firstMatch
            // Accessibility geometry can represent 44 as 43.999999999999986.
            XCTAssertGreaterThanOrEqual(control.frame.width + 0.001, 44, id)
            XCTAssertGreaterThanOrEqual(control.frame.height + 0.001, 44, id)
        }
        picture("card-form-before-answer")
        _ = try await home("appearance-dark")
        XCTAssertTrue(app.webViews.staticTexts["Night chart"].waitForPresence(timeout: 10))
        picture("card-form-dark")
        _ = try await home("appearance-light")
        XCTAssertTrue(app.webViews.staticTexts["Day chart"].waitForPresence(timeout: 10))
        let before = try await home("card-state", method: "GET")
        XCTAssertEqual(before["leaks"] as? Int, 0)
        let beforeCalls = try XCTUnwrap(before["calls"] as? [[String: Any]])
        XCTAssertTrue(beforeCalls.contains { $0["channel"] as? String == "inf:cards:seen" })
        let leaveFrame = app.webViews.buttons["Try to leave the card"]
        reveal(leaveFrame); leaveFrame.tap()
        // A loaded child cannot navigate away or contact the loopback endpoint; the form journey still works below.
        XCTAssertTrue(app.webViews.staticTexts[boundary].waitForPresence(timeout: 10))
        let afterNavigation = try await home("card-state", method: "GET")
        XCTAssertEqual(afterNavigation["leaks"] as? Int, 0)
        XCTAssertFalse(beforeCalls.contains { $0["channel"] as? String == "inf:cards:act" })
        let stall = app.webViews.buttons["Stall the card"]
        reveal(stall); stall.tap()
        XCTAssertTrue(app.buttons["retry-card"].waitForPresence(timeout: 20), app.debugDescription)
        picture("card-recovery")
        app.buttons["retry-card"].tap()
        XCTAssertTrue(app.webViews.staticTexts[boundary].waitForPresence(timeout: 20), app.debugDescription)

        let choose = app.buttons["card-action-choose"]
        // INF-1070: the retried card takes taps only once it reports drawn, which enables its footer; its text exists sooner.
        waitUntilEnabled(choose)
        let stalledAnswer = app.webViews.buttons["Stall the next answer"]
        reveal(stalledAnswer); stalledAnswer.tap()
        reveal(choose); choose.tap()
        XCTAssertTrue(app.staticTexts["This card did not answer. Your choice was not sent."].waitForPresence(timeout: 10))
        XCTAssertTrue(app.buttons["retry-card"].waitForPresence(timeout: 15))
        XCTAssertTrue(app.buttons["close-card"].isEnabled, "A stalled form cannot keep native chrome busy")
        app.buttons["retry-card"].tap()
        XCTAssertTrue(app.webViews.staticTexts[boundary].waitForPresence(timeout: 20))
        waitUntilEnabled(choose)
        reveal(choose); choose.tap()
        XCTAssertTrue(app.staticTexts["Answer each required question first."].waitForPresence(timeout: 10))
        let refused = try await home("card-state", method: "GET")
        XCTAssertNil(refused["choice"] as? [String: Any])
        showCard(chart); showCard(choice)
        // INF-209: sideways paging belongs to the native card head, outside authored gestures.
        app.staticTexts["card-title"].swipeLeft()
        XCTAssertTrue(cardHeading(chart).waitForPresence(timeout: 10))
        app.staticTexts["card-title"].swipeRight()
        XCTAssertTrue(cardHeading(choice).waitForPresence(timeout: 10))
        let north = app.webViews.staticTexts["North Basin"].firstMatch
        reveal(north); north.tap()
        let marker = app.webViews.buttons["Move the marker"]
        reveal(marker)
        _ = try await home("capture-card-start")
        marker.tap()
        XCTAssertTrue(app.webViews.staticTexts["Marker inside the harbour"].exists)
        // The native draft owner must have observed the required pick before paging can remount the document.
        waitForAnsweredPhoneForm(in: app)
        picture("card-form-picked")
        _ = try await home("capture-stop")
        _ = try await home("capture-page-start")
        app.buttons["next-card"].tap()
        XCTAssertTrue(cardHeading(chart).waitForPresence(timeout: 10))
        app.buttons["previous-card"].tap()
        XCTAssertTrue(cardHeading(choice).waitForPresence(timeout: 10))
        _ = try await home("capture-stop")
        // Paging remounts the document; the named answers and staged value still leave together.
        // INF-1086: the remounted card's footer stays disabled until its document reports drawn.
        let settings = app.buttons["card-action-settings"]
        waitUntilEnabled(settings)
        reveal(settings); settings.tap()
        XCTAssertTrue(app.staticTexts["Do this on Test Mac mini."].waitForPresence(timeout: 10))
        let unsent = try await home("card-state", method: "GET")
        XCTAssertFalse((unsent["calls"] as? [[String: Any]] ?? []).contains { $0["channel"] as? String == "inf:cards:act" })
        // INF-1122: a drawn footer is not proof the remounted form restored its required answer.
        // Wait on the native form reading, then the actual action gate, never on a quiet interval.
        waitForAnsweredPhoneForm(in: app)
        waitUntilEnabled(choose)
        reveal(choose); choose.tap()
        let dismissed = cardHeading(choice).waitForAbsence(timeout: 10)
        if !dismissed {
            do {
                let state = try await home("card-state", method: "GET")
                print("Card dismissal failure state: \(state)")
                let attachment = XCTAttachment(string: String(describing: state))
                attachment.name = "card-dismissal-state"; attachment.lifetime = .keepAlways; add(attachment)
            } catch { print("Card dismissal state could not be read: \(error)") }
        }
        XCTAssertTrue(dismissed, app.debugDescription)
        let answered = try await home("card-state", method: "GET")
        let past = try XCTUnwrap(answered["choice"] as? [String: Any])
        let answers = try XCTUnwrap(past["answers"] as? [[String: Any]])
        XCTAssertEqual(answers.first { $0["name"] as? String == "harbour" }?["values"] as? [String], ["north"])
        let chartValue = try XCTUnwrap((answers.first { $0["name"] as? String == "chart" }?["values"] as? [String])?.first)
        let chartData = try XCTUnwrap(chartValue.data(using: .utf8))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: chartData) as? [String: Int])?["zoom"], 2)
        XCTAssertEqual((past["ending"] as? [String: Any])?["actionId"] as? String, "choose")
        _ = try await home("show-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        XCTAssertFalse(app.buttons["card-action-choose"].isEnabled)
        XCTAssertFalse(app.textFields["card-reply"].exists)
        picture("past-card")
        app.buttons["close-card"].tap()
        _ = try await home("show-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        app.buttons["close-card"].tap()
        // INF-589 item 7: the answered card is listed under Past cards in the pager's own menu.
        showCard(choice)
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch.label, "Past card")
        app.buttons["close-card"].tap()

        showCard(chart)
        // INF-1062: with no bar under it, scrolling a long card leaves the message box where it is, in the column's width.
        if UIDevice.current.userInterfaceIdiom == .phone {
            let composer = app.otherElements["phone-composer"].firstMatch
            let before = composer.frame
            app.scrollViews["card-scroll"].swipeUp()
            XCTAssertEqual(composer.frame.minY, before.minY, accuracy: 1, "Scrolling a card does not move the message box")
            XCTAssertEqual(composer.frame.width, before.width, accuracy: 1, "Scrolling a card does not narrow the message box")
            verifyPhoneComposerBounds(app: app)
            try await appearances("card-scrolled")
        }
        let pictureElement = app.webViews.images["Blue harbour survey"].firstMatch
        XCTAssertTrue(pictureElement.waitForPresence(timeout: 10))
        reveal(pictureElement); pictureElement.tap()
        XCTAssertTrue(app.webViews["card-picture"].waitForPresence(timeout: 10))
        picture("picture-viewer")
        _ = try await home("capture-picture-start")
        app.webViews["card-picture"].pinch(withScale: 1.6, velocity: 1)
        picture("picture-zoomed")
        _ = try await home("capture-stop")
        app.buttons["Done"].tap()
        // The home measures the recording and owns its duration label.
        let play = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Play the demo,")).firstMatch
        reveal(play)
        _ = try await home("capture-media-start")
        play.tap()
        let player = app.descendants(matching: .any).matching(identifier: "card-recording").firstMatch
        XCTAssertTrue(player.waitForPresence(timeout: 10))
        // The body's Play already starts playback; AVKit may hide its controls before a short clip ends.
        // Completion comes from the real player's end notification, not a transient controls snapshot.
        XCTAssertTrue(app.staticTexts["recording-finished"].waitForPresence(timeout: 15), app.debugDescription)
        app.buttons["Play again"].tap()
        XCTAssertTrue(app.staticTexts["recording-finished"].waitForPresence(timeout: 15))
        let mediaState = XCTAttachment(string: app.debugDescription)
        mediaState.name = "recording-controls"; mediaState.lifetime = .keepAlways; add(mediaState)
        picture("recording-playing")
        _ = try await home("capture-stop")
        app.buttons["Done"].tap()
        let reply = app.textFields["card-reply"]
        reveal(reply)
        _ = try await home("capture-reply-start")
        reply.tap(); reply.typeText("Keep the northern entrance clear.")
        let send = app.buttons["send-reply"]
        reveal(send); send.tap()
        XCTAssertTrue(app.staticTexts["Keep the northern entrance clear."].waitForPresence(timeout: 10), app.debugDescription)
        let replied = try await home("card-state", method: "GET")
        let thread = try XCTUnwrap(replied["thread"] as? [String: Any])
        XCTAssertTrue((thread["messages"] as? [[String: Any]] ?? []).contains {
            $0["who"] as? String == "captain" && $0["text"] as? String == "Keep the northern entrance clear."
        })
        _ = try await home("thread-answer")
        XCTAssertTrue(app.staticTexts["I kept your harbour reply with this chart."].waitForPresence(timeout: 10))
        picture("card-thread")
        _ = try await home("capture-stop")
        let browser = app.buttons["card-action-browser"]
        reveal(browser); browser.tap()
        XCTAssertTrue(app.staticTexts["Do this on Test Mac mini."].waitForPresence(timeout: 10))

        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForPresence(timeout: 20))
        XCTAssertFalse(app.buttons["close-card"].isEnabled)
        XCTAssertFalse(app.buttons["card-action-body"].isEnabled)
        let atDisconnect = try await home("card-state", method: "GET")
        let bodyButton = app.webViews.buttons["Choose from the body"]
        reveal(bodyButton); bodyButton.tap()
        picture("card-out-of-reach")
        _ = try await home("online")
        reach("In reach", timeout: 20)
        let afterReconnect = try await home("card-state", method: "GET")
        let writes: ([String: Any]) -> Int = { state in (state["calls"] as? [[String: Any]] ?? []).filter { $0["channel"] as? String == "inf:cards:act" }.count }
        XCTAssertEqual(writes(afterReconnect), writes(atDisconnect), "An offline body action is never replayed")
        _ = try await home("hold-card-action")
        reveal(bodyButton); bodyButton.tap()
        _ = try await home("card-action-held")
        XCTAssertFalse(app.buttons["card-action-body"].isEnabled, "A body choice owns the same pending gate as the footer")
        XCTAssertFalse(app.buttons["close-card"].isEnabled)
        bodyButton.tap()
        XCTAssertTrue(app.staticTexts["This card already has a choice in progress."].waitForPresence(timeout: 10))
        _ = try await home("release-card-action")
        XCTAssertTrue(cardHeading(chart).waitForAbsence(timeout: 10))
        let bodyChoice = try await home("card-state", method: "GET")
        XCTAssertEqual(writes(bodyChoice), writes(afterReconnect) + 1, "The competing body input sends no second change")
        let bodyPast = try XCTUnwrap(bodyChoice["conversation"] as? [String: Any])
        XCTAssertEqual((bodyPast["ending"] as? [String: Any])?["actionId"] as? String, "body")
        _ = try await home("show-body-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        XCTAssertEqual((bodyPast["ending"] as? [String: Any])?["by"] as? String, "frame")
        let pastWords = try XCTUnwrap(bodyChoice["conversationEnding"] as? String)
        XCTAssertTrue(app.staticTexts["past-ending"].label.hasPrefix(pastWords), "A script's choice is not credited to the captain")
        picture("past-body-choice")
        app.buttons["close-card"].tap()
        showCard(note)
        app.buttons["close-card"].tap()
        XCTAssertTrue(cardHeading(note).waitForAbsence(timeout: 10))
        let closed = try await home("card-state", method: "GET")
        XCTAssertNotNil(closed["note"] as? [String: Any])
        XCTAssertEqual(closed["leaks"] as? Int, 0)
        // INF-1060, the captain: "after cards are dismissed, it doesn't extend back". With the last card closed,
        // the message box keeps its place and the column's width at the foot of Home.
        verifyPhoneComposerBounds(app: app)
        picture("cards-answered-and-closed")
        // INF-1059, the captain's "why images couldn't render inline?": a picture card already in the stack when the
        // phone comes back is drawn from the first cards read while the board read is still out, so its picture is asked
        // before the computer is in reach. The phone asks for it once it is in reach, rather than keeping a broken box.
        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForPresence(timeout: 20))
        let late = try await home("late-picture-card")
        let lateTitle = try XCTUnwrap(late["title"] as? String)
        _ = try await home("online")
        XCTAssertTrue(cardHeading(lateTitle).waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts[try XCTUnwrap(late["words"] as? String)].waitForPresence(timeout: 10))
        _ = try await home("board-read-held")
        _ = try await home("release-board-read")
        reach("In reach", timeout: 20)
        _ = try await home("late-picture-asked")
        picture("card-picture-after-reaching")
        app.buttons["close-card"].tap()
        XCTAssertTrue(cardHeading(lateTitle).waitForAbsence(timeout: 10))
        // The same after view in both themes supplies the release note's native hero pair.
        let hero = try await home("hero-card")
        showCard(try XCTUnwrap(hero["title"] as? String))
        XCTAssertTrue(app.webViews.staticTexts["Chart for daylight sailing"].waitForPresence(timeout: 10))
        verifyPhoneComposerBounds(app: app)
        picture("cards-hero-light")
        _ = try await home("appearance-dark")
        XCTAssertTrue(app.webViews.staticTexts["Chart for night sailing"].waitForPresence(timeout: 10))
        verifyPhoneComposerBounds(app: app)
        picture("cards-hero-dark")
        _ = try await home("appearance-light")
        // INF-944 item 5 with INF-945's pick: the Mac's row, pinned at the card's foot with no scrolling,
        // the default last at the right and every choice keeping a 44-point touch area.
        let keepChoice = app.buttons["card-action-keep"], waitChoice = app.buttons["card-action-wait"]
        XCTAssertTrue(keepChoice.isHittable, "The choices sit in view without scrolling")
        XCTAssertTrue(waitChoice.isHittable)
        // The answered count starts the first line, so the row wraps where its choices do not fit beside it.
        if abs(keepChoice.frame.midY - waitChoice.frame.midY) < 1 {
            XCTAssertLessThan(waitChoice.frame.maxX, keepChoice.frame.minX, "The default is drawn last")
        } else {
            XCTAssertGreaterThan(keepChoice.frame.minY, waitChoice.frame.minY, "The default is drawn last")
            XCTAssertEqual(keepChoice.frame.maxX, waitChoice.frame.maxX, accuracy: 1, "Each line sits at the trailing edge")
        }
        // XCUI reports the 44-point area in fractions of a pixel, such as 43.99999999999994.
        XCTAssertGreaterThanOrEqual(keepChoice.frame.height.rounded(), 44)
        XCTAssertLessThan(keepChoice.frame.width, app.scrollViews["card-scroll"].frame.width / 2, "A choice keeps its own width")
        // INF-944 item 3: a card minimized on the computer leaves the phone's stack and waits under Minimized.
        let heroTitle = try XCTUnwrap(hero["title"] as? String)
        _ = try await home("minimize-hero")
        XCTAssertTrue(cardHeading(heroTitle).waitForAbsence(timeout: 10), app.debugDescription)
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        XCTAssertTrue(pager.waitForPresence(timeout: 10), app.debugDescription)
        // INF-1060: the empty stage's lone menu keeps one name, with no Minimized label under the character.
        XCTAssertEqual(pager.label, "Past cards")
        pager.tap()
        // The answered choice card shares the title under Past cards; the one to open is listed under Minimized.
        let restore = app.buttons.matching(identifier: "minimized-card").matching(NSPredicate(format: "label == %@", heroTitle)).firstMatch
        XCTAssertTrue(restore.waitForPresence(timeout: 10), app.debugDescription)
        picture("cards-minimized-menu")
        restore.tap()
        XCTAssertTrue(cardHeading(heroTitle).waitForPresence(timeout: 10), "Opening a minimized card brings it back")
        let restored = try await home("hero-state", method: "GET")
        let restoredCard = try XCTUnwrap(restored["card"] as? [String: Any])
        XCTAssertNil(restoredCard["minimized"], "The phone brings it back on the computer too")
        // INF-209: the native frame remains usable at the largest standard Dynamic Type size.
        app.terminate()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
        try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        showCard(try XCTUnwrap(hero["title"] as? String))
        let largeChoice = app.buttons["card-action-keep"]
        reveal(largeChoice)
        XCTAssertEqual(largeChoice.label, "Use this entrance")
        picture("card-large-type")
    }

    /// INF-499: a saved-sign-in choice reaches the computer; a failed body submits its saved draft honestly.
    private func verifyReviewedCardChoices() async throws {
        let fixture = try await home("review-cards")
        let saved = try XCTUnwrap(fixture["saved"] as? String)
        let fallback = try XCTUnwrap(fixture["fallback"] as? String)
        showCard(saved)
        let useSaved = app.buttons["card-action-saved"]
        reveal(useSaved)
        // INF-621: the failed iPad picture caught the footer before its body drew.
        // A hittable button can still be disabled; wait for the real action gate.
        waitUntilEnabled(useSaved)
        picture("saved-sign-in-choice"); useSaved.tap()
        XCTAssertTrue(cardHeading(saved).waitForAbsence(timeout: 10))
        let accepted = try await home("card-state", method: "GET")
        let savedPast = try XCTUnwrap(accepted["saved"] as? [String: Any])
        XCTAssertEqual((savedPast["ending"] as? [String: Any])?["actionId"] as? String, "saved")
        showCard(fallback)
        // A parsed body control can exist before its document's scripts initialize.
        // The native footer's gate is the actual drawn acknowledgement for this page.
        waitUntilEnabled(app.buttons["card-action-keep"])
        let change = app.webViews.buttons["Keep the evening tide"]
        reveal(change); change.tap()
        XCTAssertTrue(app.webViews.buttons["Evening tide saved"].waitForPresence(timeout: 10))
        // A completed page away/back witnesses receipt and restoration of the changed native draft.
        _ = try await home("show-saved-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10)); app.buttons["close-card"].tap()
        showCard(fallback)
        let restored = app.webViews.textFields["Harbour note"]
        XCTAssertTrue(restored.waitForPresence(timeout: 10))
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == %@", "Evening tide"), object: restored, timeout: 10), .completed)
        // The saved fill arrives before script initialization on a remount, just as on the first mount.
        waitUntilEnabled(app.buttons["card-action-keep"])
        let stall = app.webViews.buttons["Stop the chart"]
        reveal(stall); stall.tap()
        XCTAssertTrue(app.buttons["retry-card"].waitForPresence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Choices use the last saved answers. Retry to read the card again."].exists)
        _ = try await home("capture-review-start")
        picture("saved-answer-recovery")
        let keep = app.buttons["card-action-keep"]
        reveal(keep); keep.tap()
        XCTAssertTrue(cardHeading(fallback).waitForAbsence(timeout: 10))
        let result = try await home("card-state", method: "GET")
        let past = try XCTUnwrap(result["fallback"] as? [String: Any])
        let answers = try XCTUnwrap(past["answers"] as? [[String: Any]])
        XCTAssertEqual(answers.first?["values"] as? [String], ["Evening tide"])
        let calls = try XCTUnwrap(result["calls"] as? [[String: Any]])
        let action = try XCTUnwrap(calls.last { $0["channel"] as? String == "inf:cards:act" })
        let args = try XCTUnwrap(action["args"] as? [Any])
        XCTAssertEqual((args[4] as? [String: Any])?["reading"] as? String, "fallback")
        XCTAssertEqual((args[4] as? [String: Any])?["questionsGap"] as? String, "no-fresh-reading")
        _ = try await home("show-fallback-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        picture("saved-answer-choice")
        _ = try await home("capture-stop")
        app.buttons["close-card"].tap()
    }

    /// INF-499 #3: reading a past card gives the message its history hint, never a current-card hint.
    private func verifyPastMessageContext() async throws {
        let fixture = try await home("context-fixture")
        showCard(try XCTUnwrap(fixture["title"] as? String))
        app.buttons["close-card"].tap()
        _ = try await home("show-context-past")
        XCTAssertTrue(app.staticTexts["Past"].waitForPresence(timeout: 10))
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(try XCTUnwrap(fixture["text"] as? String))
        app.buttons["send-message"].tap()
        let sent = try await home("context-sent")
        let writes = try XCTUnwrap(sent["writes"] as? [[String: Any]])
        let payload = try XCTUnwrap((writes.last?["args"] as? [[String: Any]])?.first)
        XCTAssertEqual(payload["pastCardId"] as? String, fixture["id"] as? String)
        XCTAssertNil(payload["visibleCardId"])
        XCTAssertNil(payload["taskId"])
        picture("message-about-past-card")
        app.buttons["close-card"].tap()
    }

    /// INF-64 piece 5: native input and controls reach the real Mac as captain actions.
    /// Data: a project-owned photo, a typed harbour ask, and an on-request task with a held mock-provider turn.
    /// Completion: the Mac keeps the ask/photo, runs that task, records interruption/continuation and hears the steer.
    /// Resources: this journey's existing fresh simulator/home only; no phone signing, microphone or real account.
    private func talkAndTasks() async throws {
        let fixture = try await home("talk-fixture")
        let words = try XCTUnwrap(fixture["text"] as? String)
        addPhoneJourneyPhoto(app: app)
        let input = app.textFields["message-box"]
        focusForPhoneTyping(input, in: app); input.typeText(words)
        picture("message-and-photo")
        let beforeDraft = try await home("talk-state", method: "GET")
        try await verifyComposerDraft(words)
        let afterDraft = try await home("talk-state", method: "GET")
        XCTAssertEqual((afterDraft["writes"] as? [Any])?.count, (beforeDraft["writes"] as? [Any])?.count,
            "Command-Return behind the details sheet sends no hidden composer request")
        // The completed keyboard/details interactions follow rotation's intermediate redraw.
        picture("draft-portrait-ready")
        app.buttons["send-message"].tap()
        let sent = try await home("talk-sent")
        let writes = try XCTUnwrap(sent["writes"] as? [[String: Any]])
        let message = try XCTUnwrap(writes.first { $0["channel"] as? String == "inf:converse" })
        XCTAssertEqual((message["actor"] as? [String: Any])?["kind"] as? String, "captain")
        let payload = try XCTUnwrap((message["args"] as? [[String: Any]])?.first)
        XCTAssertEqual(payload["text"] as? String, words)
        XCTAssertEqual(payload["visibleCardId"] as? String, fixture["visibleCardId"] as? String)
        XCTAssertNotNil(payload["visibleCardId"])
        XCTAssertNil(payload["pastCardId"])
        let images = try XCTUnwrap(payload["images"] as? [[String: Any]])
        XCTAssertEqual(images.count, 1); XCTAssertGreaterThan(try XCTUnwrap(images.first?["bytes"] as? Int), 0)
        XCTAssertEqual((sent["lastTurn"] as? [String: Any])?["you"] as? String, words)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 0)
        verifyPhoneComposerBounds(app: app)
        picture("last-turn")
        _ = try await home("appearance-dark")
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
        picture("talk-hero-dark")
        _ = try await home("appearance-light")
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
        picture("talk-hero-light")

        tab("Tasks")
        XCTAssertTrue(app.buttons["group-backlog"].waitForPresence(timeout: 10))
        picture("tasks")
        app.buttons["group-backlog"].tap()
        XCTAssertTrue(app.buttons["task-phone-work"].waitForPresence(timeout: 10))
        picture("tasks-backlog")
        // INF-589 item 9: search waits above the list until it is pulled down, and Find a task opens it by key, as on the Mac.
        let search = app.textFields["task-search"]
        XCTAssertFalse(search.exists)
        app.scrollViews["tasks-list"].swipeDown()
        XCTAssertTrue(search.waitForPresence(timeout: 10))
        app.buttons["close-task-search"].tap()
        XCTAssertTrue(search.waitForAbsence(timeout: 10))
        try await pressPhoneKey("f", modifiers: [.command, .shift], in: app)
        XCTAssertTrue(search.waitForPresence(timeout: 10))
        search.typeText("harbour")
        XCTAssertTrue(app.buttons["task-phone-work"].waitForPresence(timeout: 10))
        picture("task-search")
        app.buttons["task-phone-work"].tap()
        XCTAssertTrue(app.buttons["start-task"].waitForPresence(timeout: 10))
        picture("task-before-start")
        _ = try await home("capture-talk-start")
        app.buttons["start-task"].tap()
        let started = try await home("talk-started")
        XCTAssertNotNil(started["startedAt"] as? Double)
        XCTAssertTrue(started["executionDeviceId"] is NSNull, "The phone starts work on its Mac, never on the phone")
        XCTAssertTrue(app.buttons["Crewmate"].waitForPresence(timeout: 10)); app.buttons["Crewmate"].tap()
        XCTAssertTrue(app.buttons["interrupt-task"].waitForPresence(timeout: 10))
        picture("crewmate-working")
        _ = try await home("capture-stop")
        app.buttons["interrupt-task"].tap()
        let interrupted = try await home("talk-interrupted")
        let events = try XCTUnwrap(interrupted["events"] as? [[String: Any]])
        XCTAssertTrue(events.contains { $0["kind"] as? String == "interrupted" && $0["actor"] as? String == "captain" })
        XCTAssertEqual(interrupted["activity"] as? String, "idle", "Interrupt stops the turn and keeps it steerable")
        _ = try await home("talk-resumable")
        XCTAssertTrue(app.buttons["continue-task"].waitForPresence(timeout: 10))
        picture("task-interrupted")
        app.buttons["continue-task"].tap()
        XCTAssertTrue(app.buttons["interrupt-task"].waitForPresence(timeout: 20))
        let steer = try XCTUnwrap(fixture["steer"] as? String)
        let steerField = app.textFields["steer-box"]
        steerField.tap(); steerField.typeText(steer)
        app.buttons["steer-task"].tap()
        let steered = try await home("talk-steered")
        let task = try XCTUnwrap(steered["task"] as? [String: Any])
        XCTAssertEqual(task["outcome"] as? String, fixture["report"] as? String)
        let allWrites = try XCTUnwrap(steered["writes"] as? [[String: Any]])
        for write in allWrites { XCTAssertEqual((write["actor"] as? [String: Any])?["kind"] as? String, "captain") }
        XCTAssertTrue(allWrites.contains { $0["channel"] as? String == "inf:task:run" && ($0["args"] as? [String])?.last == "continue-task" })
        picture("crewmate-steered")
        app.buttons["close-record"].tap()
        // INF-589 item 6: the notice is a quiet pill under the title on any tab, and a tap opens its card.
        let notice = app.buttons["phone-notice"]
        XCTAssertTrue(notice.waitForPresence(timeout: 10))
        // INF-1062: the notice sits under the top bar on any tab, never over its strip.
        let bar = app.navigationBars.firstMatch
        XCTAssertGreaterThanOrEqual(notice.frame.minY, bar.frame.maxY, "The notice sits under the bar, not over it")
        XCTAssertTrue(app.buttons["tab-tasks"].isSelected, "The notice shows on Tasks, where the record was")
        picture("foreground-notice")
        XCUIDevice.shared.orientation = .landscapeLeft
        app.activate()
        if UIDevice.current.userInterfaceIdiom == .pad {
            // INF-589 item 16: in landscape the notice sits over the stage, beside the sidebar rather than across it.
            let sidebar = phoneSidebar(app)
            XCTAssertTrue(sidebar.waitForPresence(timeout: 10))
            XCTAssertTrue(notice.waitForPresence(timeout: 10))
            XCTAssertGreaterThanOrEqual(notice.frame.minX, sidebar.frame.maxX, "The notice belongs to the stage")
            picture("notice-landscape")
        } else {
            // INF-589 item 17: on its side the card gets the height; the one-row bar keeps its strip and the notice waits.
            XCTAssertTrue(notice.waitForAbsence(timeout: 10))
            XCTAssertTrue(app.buttons["tab-home"].isHittable, "The strip stays in the bar on its side")
            picture("on-its-side")
        }
        XCUIDevice.shared.orientation = .portrait
        app.activate()
        XCTAssertTrue(notice.waitForPresence(timeout: 10), "Upright, the unread notice returns")
        let noticed = notice.label
        notice.tap()
        XCTAssertTrue(notice.waitForAbsence(timeout: 10))
        let heading = app.staticTexts["card-title"]
        XCTAssertTrue(heading.waitForPresence(timeout: 10))
        XCTAssertTrue(noticed.hasSuffix(": " + heading.label), "The notice \(noticed) opens its own card, not \(heading.label)")
        // The card opens on Home, where the last turn and the message box are.
        XCTAssertTrue(app.buttons["tab-home"].isSelected)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
        focusForPhoneTyping(input, in: app); input.typeText("Keep this unsent draft")
        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForPresence(timeout: 20))
        XCTAssertFalse(app.buttons["send-message"].isEnabled)
        verifyPhoneComposerBounds(app: app)
        picture("offline-draft")
        _ = try await home("online")
        reach("In reach", timeout: 20)
        let after = try await home("talk-state", method: "GET")
        XCTAssertEqual((after["writes"] as? [Any])?.count, allWrites.count, "Reconnecting never sends the retained draft")
        XCTAssertEqual(input.value as? String, "Keep this unsent draft")
        _ = try await home("lose-reply")
        app.buttons["send-message"].tap()
        let unconfirmed = app.staticTexts["message-problem"]
        XCTAssertTrue(unconfirmed.waitForPresence(timeout: 20))
        XCTAssertTrue(unconfirmed.label.contains("Could not confirm"), unconfirmed.label)
        verifyPhoneComposerBounds(app: app)
        picture("unconfirmed-send")
        XCTAssertGreaterThanOrEqual(unconfirmed.frame.minY, app.frame.minY)
        XCTAssertLessThanOrEqual(unconfirmed.frame.maxY, app.frame.maxY, "The entire unconfirmed-send warning stays on screen")
        XCTAssertTrue(unconfirmed.isHittable, "Nothing sits over the warning at the foot")
        _ = try await home("online")
        reach("In reach", timeout: 20)
        let once = try await home("talk-state", method: "GET")
        XCTAssertEqual((once["writes"] as? [Any])?.count, allWrites.count + 1, "A lost reply never repeats the mutation")
        XCTAssertEqual(input.value as? String, "Keep this unsent draft")
        _ = try await home("read-only")
        reach("In reach", timeout: 20)
        XCTAssertFalse(app.buttons["send-message"].isEnabled, "A version-mismatched view can read but cannot act")
        verifyPhoneComposerBounds(app: app)
        picture("read-only-draft")

        // INF-355: exercise first-after-relaunch paging and Send after the original journey.
        // Earlier relaunches here would erase that journey's in-session past-card prerequisite.
        // Keep all original button-based Send, photo, card and refusal checks unchanged.
        app.terminate()
        _ = try await home("offline")
        _ = try await home("online")
        let keyCards = try await home("cards-fixture")
        let choice = try XCTUnwrap(keyCards["choice"] as? String)
        let chart = try XCTUnwrap(keyCards["conversation"] as? String)
        try await launchPhoneApp(app)
        XCTAssertTrue(app.scrollViews["card-scroll"].waitForPresence(timeout: 20))
        showCard(choice)
        XCTAssertTrue(app.buttons["next-card"].isEnabled)
        computerDetails()
        try await pressPhoneKey("]", modifiers: [.command, .shift], in: app)
        app.buttons["close-computer-details"].tap()
        XCTAssertTrue(cardHeading(choice).waitForPresence(timeout: 10), "A sheet keeps its pager shortcut from the stage behind it")
        try await pressPhoneKey("]", modifiers: [.command, .shift], in: app)
        XCTAssertTrue(cardHeading(chart).waitForPresence(timeout: 10))
        app.terminate(); try await launchPhoneApp(app)
        XCTAssertTrue(app.scrollViews["card-scroll"].waitForPresence(timeout: 20))
        showCard(chart)
        XCTAssertTrue(app.buttons["previous-card"].isEnabled)
        try await pressPhoneKey("[", modifiers: [.command, .shift], in: app)
        XCTAssertTrue(cardHeading(choice).waitForPresence(timeout: 10))

        // INF-82: Command-Return sends the complete multiline ask once, not merely hides a keyboard.
        app.terminate(); try await launchPhoneApp(app)
        reach("In reach", timeout: 20)
        XCTAssertTrue(input.waitForPresence(timeout: 10))
        // A multiline field exposes its empty value differently from placeholderValue.
        // Read that state before typing, then require Send to restore it.
        let emptyDraft = try XCTUnwrap(input.value as? String)
        let keyboardWords = words + "\nUse the photo from my earlier message."
        focusForPhoneTyping(input, in: app); input.typeText(keyboardWords)
        XCTAssertEqual(input.value as? String, keyboardWords)
        XCTAssertTrue(app.buttons["send-message"].isEnabled)
        try await pressPhoneKey(XCUIKeyboardKey.return.rawValue, modifiers: .command, in: app)
        XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "value == %@", emptyDraft), object: input, timeout: 20), .completed)
        let keySent = try await home("talk-state", method: "GET")
        let keyWrites = try XCTUnwrap(keySent["writes"] as? [[String: Any]])
        XCTAssertEqual(keyWrites.count, try XCTUnwrap(once["writes"] as? [Any]).count + 1)
        let keyMessage = try XCTUnwrap(keyWrites.last)
        XCTAssertEqual(keyMessage["channel"] as? String, "inf:converse")
        XCTAssertEqual((keyMessage["actor"] as? [String: Any])?["kind"] as? String, "captain")
        let keyPayload = try XCTUnwrap((keyMessage["args"] as? [[String: Any]])?.first)
        XCTAssertEqual(keyPayload["text"] as? String, keyboardWords)
        XCTAssertEqual((keyPayload["images"] as? [Any])?.count, 0)
        picture("sent-by-keyboard")
    }

    /// INF-209 and INF-82 integration: one composer retains the actual typed/photo draft across tabs and rotation.
    /// This extends the existing real-home journey, using its owned simulator, selected photo and captain ask.
    private func verifyComposerDraft(_ words: String) async throws {
        try await verifyPhoneComposerDrafts(app: app, words: words, tab: tab, picture: picture) { start in
            _ = try await self.home(start ? "capture-composer-start" : "capture-stop")
        }
    }


}
