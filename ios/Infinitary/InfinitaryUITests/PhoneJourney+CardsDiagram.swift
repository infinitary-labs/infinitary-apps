import XCTest

/// The cards-diagram part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-3881, the captain: "the diagram part needs the ability to full screen like picture views. don't let scroll
    /// zoom it because that breaks the card scroll flow ... also take care of the same on phone", built as the approved
    /// plan's piece 3. Data: a first mate card holding the Advanced architecture map part filled with this project's own
    /// map files, with words under it so the card is taller than the screen.
    /// Completion: one finger dragged up from the map in the card scrolls the card and opens nothing; a tap on the map
    /// opens the Card diagram cover with the live map, where a pinch enlarges a box, a drag moves it, Fit fits it again,
    /// a tap chooses the box, a tap on the chosen box goes into it, and turning the phone keeps the box on the screen;
    /// Done closes the cover and the card's map stands where the cover left it.
    func testCardDiagramCover() async throws {
        try await launchJoined()
        let fixture = try await home("map-card")
        let title = try XCTUnwrap(fixture["title"] as? String)
        let part = try XCTUnwrap(fixture["part"] as? String)
        XCTAssertTrue(cardHeading(title).waitForPresence(timeout: 10), app.debugDescription)
        waitForShownBodyRevealed()
        let body = app.webViews.matching(identifier: "card-body").firstMatch
        let box = body.staticTexts[part].firstMatch
        XCTAssertTrue(box.waitForPresence(timeout: 20), app.debugDescription)
        reveal(box)
        waitForSteadyTarget(box)
        picture("0-map-in-card")

        // One finger on the map in the card moves the card, never the map, and opens no cover.
        let before = box.frame
        let start = box.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)), withVelocity: .slow, thenHoldForDuration: 0.3)
        waitForSteadyTarget(box)
        XCTAssertLessThan(box.frame.minY, before.minY - 80, "A drag on the map scrolls the card: \(before) to \(box.frame)")
        XCTAssertEqual(box.frame.width, before.width, accuracy: 1, "A drag on the map in the card leaves the map's size alone")
        XCTAssertFalse(app.navigationBars["Card diagram"].exists, "A drag on the map opens nothing")

        // A tap opens the live map in its cover.
        reveal(box)
        tapOnPhone(box)
        XCTAssertTrue(app.navigationBars["Card diagram"].waitForPresence(timeout: 10), app.debugDescription)
        let cover = app.webViews.matching(identifier: "card-diagram").firstMatch
        XCTAssertTrue(cover.waitForPresence(timeout: 10), app.debugDescription)
        let inner = cover.staticTexts[part].firstMatch
        XCTAssertTrue(inner.waitForPresence(timeout: 20), app.debugDescription)
        waitForSteadyTarget(inner)
        let fitted = inner.frame
        XCTAssertTrue(cover.frame.contains(fitted), "The cover opens fitted: \(fitted) in \(cover.frame)")
        picture("1-cover-fitted")
        let fittedDrawing = drawing(of: cover)

        // A pinch enlarges the map, a drag moves it, and Fit fits it again.
        cover.pinch(withScale: 2, velocity: 1)
        XCTAssertTrue(framed(inner) { $0.width > fitted.width * 1.3 }, "A pinch enlarges the map: \(inner.frame)")
        picture("2-cover-pinched")
        let middle = cover.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // The screen reader's frames of the map's words stop following the map once it moves (the simulator's WebKit
        // keeps them where they last stood), so the drag and Fit are read from the drawing itself.
        let pinched = drawing(of: cover)
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 100, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in self.drawing(of: cover) != pinched }, object: nil,
                                            timeout: 10) == .completed, "A drag moves the map")
        picture("2-cover-dragged")
        let fit = cover.buttons["Fit"].firstMatch
        XCTAssertTrue(fit.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(fit)
        XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in self.drawing(of: cover) == fittedDrawing }, object: nil,
                                            timeout: 10) == .completed, "Fit draws the map as it opened")

        // A tap chooses a box, which the status line names; a tap on the chosen box goes into it. The map stands as it
        // opened, so the box is where it was drawn then.
        let spot = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: fitted.midX, dy: fitted.midY))
        tapOnPhone(spot)
        let chosen = cover.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "\(part):")).firstMatch
        XCTAssertTrue(chosen.waitForPresence(timeout: 10), "A tap chooses \(part)\n\(app.debugDescription)")
        waitForStill(cover)
        picture("3-cover-chosen")
        tapOnPhone(spot)
        let trail = cover.buttons.matching(NSPredicate(format: "label == %@", part)).firstMatch
        XCTAssertTrue(trail.waitForPresence(timeout: 10), "A tap on the chosen box goes into \(part)\n\(app.debugDescription)")
        XCTAssertTrue(chosen.waitForAbsence(timeout: 10), "Inside a box nothing is chosen yet")
        waitForStill(cover)
        picture("4-cover-inside")

        // Turning the phone refits the map inside the cover.
        if UIDevice.current.userInterfaceIdiom == .phone {
            let anyBox = cover.staticTexts.element(boundBy: 0)
            turnPhone(to: .landscapeLeft, in: app, moving: anyBox)
            XCTAssertTrue(framed(anyBox) { cover.frame.contains($0) }, "Turning refits the map: \(anyBox.frame) in \(cover.frame)")
            // The same view in both themes supplies the release note's hero pair.
            waitForStill(cover)
            picture("5-cover-on-its-side-light")
            let light = drawing(of: cover)
            _ = try await home("appearance-dark", budget: displayBudget)
            XCTAssertTrue(waitForPhonePredicate(NSPredicate { _, _ in self.drawing(of: cover) != light }, object: nil,
                                                timeout: 10) == .completed, "The cover follows the phone into dark")
            waitForStill(cover)
            picture("5-cover-on-its-side-dark")
            _ = try await home("appearance-light", budget: displayBudget)
            turnPhone(to: .portrait, in: app, moving: anyBox)
        }

        // Done closes the cover, and the card's own map stands where the cover left it.
        tapOnPhone(app.navigationBars["Card diagram"].buttons["Done"])
        XCTAssertTrue(cover.waitForAbsence(timeout: 10), app.debugDescription)
        let handed = body.buttons.matching(NSPredicate(format: "label == %@", part)).firstMatch
        XCTAssertTrue(handed.waitForPresence(timeout: 10), "The card's map goes into \(part) too\n\(app.debugDescription)")
        reveal(handed)
        picture("6-card-after-cover")
    }

    /// The map as the cover draws it, above its own bar, whose words and buttons a press can change.
    private func drawing(of cover: XCUIElement) -> Data? {
        let shot = cover.screenshot().image
        guard let whole = shot.cgImage else { return nil }
        let scale = CGFloat(whole.height) / shot.size.height
        let map = CGRect(x: 0, y: 0, width: CGFloat(whole.width), height: (shot.size.height - 180) * scale)
        return whole.cropping(to: map).map { UIImage(cgImage: $0).pngData() } ?? nil
    }

    /// Waits until the map stops moving: two drawings in a row are the same.
    private func waitForStill(_ cover: XCUIElement) {
        var last: Data?
        _ = waitForPhonePredicate(NSPredicate { _, _ in
            let now = self.drawing(of: cover)
            defer { last = now }
            return now != nil && now == last
        }, object: nil, timeout: 10)
    }

    /// Waits until the element's frame, read afresh each tick, passes `test`.
    private func framed(_ element: XCUIElement, timeout: TimeInterval = 10, _ test: @escaping (CGRect) -> Bool) -> Bool {
        waitForPhonePredicate(NSPredicate { _, _ in element.exists && test(element.frame) }, object: nil, timeout: timeout) == .completed
    }
}
