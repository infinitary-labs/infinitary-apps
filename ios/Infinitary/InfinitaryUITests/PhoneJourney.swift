import XCTest

/// INF-64 piece 2's requested journey. Real TLS/core, disposable home and simulator; never a provider account.
/// Result: the same phone identity rejoins after launch, reads cards/feed, catches up and leaves/removes.
/// Prerequisites: iOS 18+ simulator, scripts/phone-test-home.ts; no camera, local network or signing material.
@MainActor final class PhoneJourney: XCTestCase {
    private let app = XCUIApplication()
    private var control: String { ProcessInfo.processInfo.environment["PHONE_TEST_HOME"]! }

    private func home(_ command: String, method: String = "POST") async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: control + "/" + command)!)
        request.httpMethod = method
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func picture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }

    private func tab(_ name: String) {
        // iPhone exposes a TabBar; iPad's floating tabs are cells. Their accessible name is shared.
        let tab = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 10)); tab.tap()
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
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText(link)
        app.buttons["read-link"].tap()
        // iOS 26 exposes a dialog's native button and its SwiftUI label as nested buttons.
        let confirm = app.buttons["confirm-join"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10)); confirm.tap()
    }

    private func join() async throws {
        try await submitLink()
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 20), app.debugDescription)
    }

    func testPhoneReadsItsMacAndRecovers() async throws {
        continueAfterFailure = false
        app.launchEnvironment["INFINITARY_ISOLATED_PHONE_TEST"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 10), app.debugDescription)
        picture("join")
        try await submitLink("wrong-link")
        XCTAssertTrue(app.staticTexts["This is not the Mac your link names. Nothing was sent."].waitForExistence(timeout: 15))
        let refused = try await home("state", method: "GET")
        XCTAssertEqual((refused["devices"] as? [Any])?.count, 0)
        picture("wrong-mac")
        try await join()
        // Create the review before taking the feed snapshot used by the Activity assertions.
        _ = try await home("review-finding")
        let first = try await home("state", method: "GET")
        let devices = try XCTUnwrap(first["devices"] as? [[String: Any]])
        let phone = try XCTUnwrap(devices.first)
        XCTAssertEqual(phone["kind"] as? String, "view")
        XCTAssertEqual(phone["system"] as? String, "ios")
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
        XCTAssertFalse(app.buttons["Merge"].exists)
        picture("cards")
        // INF-63 accepted B: the phone reads the host-validated finding label and builder's task name.
        XCTAssertTrue(app.staticTexts["Review finding"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Check the phone connection"].exists)
        XCTAssertFalse(app.buttons["Keep it"].exists)
        picture("review-finding")
        // INF-136 #2: no product traffic for longer than both former pairing deadlines.
        let idle = try await home("idle")
        let idleBefore = try XCTUnwrap(idle["before"] as? [String: Int])
        let idleAfter = try XCTUnwrap(idle["after"] as? [String: Int])
        XCTAssertEqual(idleAfter["connections"], idleBefore["connections"], "An idle phone must keep its existing connection")
        // INF-136 #1/#12: a card revision witnesses processing all preceding stream pushes.
        let stream = try await home("stream")
        XCTAssertTrue(app.staticTexts["Streaming finished"].waitForExistence(timeout: 10))
        let streamed = try await home("state", method: "GET")
        let beforeStream = try XCTUnwrap(stream["before"] as? [String: Int])
        let afterStream = try XCTUnwrap(streamed["readings"] as? [String: Int])
        XCTAssertEqual(afterStream["feed"], beforeStream["feed"], "Streaming does not change Activity")
        XCTAssertEqual(afterStream["cards"], beforeStream["cards"], "The push already carries the card snapshot")
        _ = try await home("stream-reset")
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForExistence(timeout: 10))
        // INF-136 #9: Control Center makes the scene inactive, not backgrounded.
        let beforeInactive = try await home("state", method: "GET")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.01)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.65)))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // A fresh simulator has no connectivity controls; the container itself witnesses the overlay.
        let controlCenter = springboard.otherElements["cc-root-folder-view"]
        XCTAssertTrue(controlCenter.waitForExistence(timeout: 10), springboard.debugDescription)
        // Dismiss the empty simulator's overlay without invoking iPad's Home/window gesture.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        XCTAssertTrue(controlCenter.waitForNonExistence(timeout: 10))
        app.activate()
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 10))
        let afterInactive = try await home("state", method: "GET")
        XCTAssertEqual((afterInactive["readings"] as? [String: Int])?["connections"],
            (beforeInactive["readings"] as? [String: Int])?["connections"], "An inactive scene keeps its connection")
        tab("Activity")
        let feed = try XCTUnwrap(first["feed"] as? [[String: Any]])
        let line = try XCTUnwrap(feed.first?["text"] as? String)
        XCTAssertTrue(app.staticTexts[line].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "activity-text").firstMatch.label, feed.last?["text"] as? String)
        picture("activity")
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 20), app.debugDescription)
        let afterLaunch = try await home("state", method: "GET")
        XCTAssertEqual((afterLaunch["devices"] as? [[String: Any]])?.first?["id"] as? String, phone["id"] as? String)

        _ = try await home("capture-start")
        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].exists)
        picture("out-of-reach")
        let change = try await home("change")
        _ = try await home("online")
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 20), app.debugDescription)
        let title = try XCTUnwrap(change["title"] as? String)
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
        picture("caught-up")
        _ = try await home("capture-stop")
        tab("Activity")
        let caughtUp = try await home("state", method: "GET")
        let caughtUpFeed = try XCTUnwrap(caughtUp["feed"] as? [[String: Any]])
        let newest = try XCTUnwrap(caughtUpFeed.last?["text"] as? String)
        XCTAssertTrue(app.staticTexts[newest].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "activity-text").firstMatch.label, newest)
        picture("activity-caught-up")
        tab("Cards")

        // A background/foreground return keeps the home's epoch and exercises replay, not a reload.
        try await background()
        let whileAway = try await home("change")
        app.activate()
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 20))
        let replayed = try XCTUnwrap(whileAway["title"] as? String)
        XCTAssertTrue(app.staticTexts[replayed].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", replayed)).count, 1)

        app.buttons["leave"].tap(); app.buttons["Leave this Mac"].firstMatch.tap()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 20), app.debugDescription)
        let afterLeave = try await home("state", method: "GET")
        XCTAssertEqual((afterLeave["devices"] as? [Any])?.count, 0)
        try await join()
        // INF-136 #4: a Mac that cannot answer must not keep the phone joined forever.
        _ = try await home("offline")
        XCTAssertTrue(app.staticTexts["Out of reach"].waitForExistence(timeout: 20))
        app.buttons["forget-mac"].tap()
        picture("forget-confirmation")
        app.buttons["confirm-forget"].firstMatch.tap()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 10))
        picture("forgotten")
        let afterForget = try await home("state", method: "GET")
        XCTAssertEqual((afterForget["devices"] as? [Any])?.count, 1, "Forgetting locally does not claim the Mac removed the phone")
        _ = try await home("online")
        try await join() // Fresh-link recovery reuses the identity still listed on this Mac.
        _ = try await home("remove")
        XCTAssertTrue(app.staticTexts["Removed from your Mac"].waitForExistence(timeout: 20), app.debugDescription)
        picture("removed")
        app.buttons["join-again"].tap()
        XCTAssertTrue(app.buttons["paste-link"].exists)
        // INF-136 #3: two genuine 401s separated by an unreachable address still prove removal.
        try await submitLink("link-with-unreachable")
        XCTAssertTrue(app.staticTexts["In reach"].waitForExistence(timeout: 20))
        try await background()
        _ = try await home("link") // Keep the real home listening after its final phone is removed.
        _ = try await home("remove")
        app.activate()
        XCTAssertTrue(app.staticTexts["Removed from your Mac"].waitForExistence(timeout: 20), app.debugDescription)
        picture("removed-after-away")
        let removal = try await home("state", method: "GET")
        XCTAssertEqual((removal["readings"] as? [String: Int])?["stalledConnections"], 1,
            "Removal survives a stalled handshake with no HTTP response between authenticated refusals")
        app.buttons["join-again"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 10))
        // INF-136 re-review #1: a damaged saved record must not block a fresh confirmed link.
        try await join()
        let beforeDamage = try await home("state", method: "GET")
        let retainedIDs = (beforeDamage["devices"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
        XCTAssertEqual(retainedIDs?.count, 1)
        app.terminate()
        _ = try await home("damage-record")
        app.launch()
        XCTAssertTrue(app.buttons["paste-link"].waitForExistence(timeout: 10))
        picture("damaged-record")
        try await join()
        XCTAssertTrue(app.staticTexts["Your phone is reading your Mac"].waitForExistence(timeout: 10))
        let afterDamage = try await home("state", method: "GET")
        XCTAssertEqual((afterDamage["devices"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, retainedIDs)
        picture("rejoined-after-damaged-record")
    }
}
