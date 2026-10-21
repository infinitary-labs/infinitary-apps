import XCTest

/// INF-209 / INF-230: one real composer keeps the talk journey's unsent text/photo across tabs and rotation.
/// Called by the composed journey after typing its real ask, before sending it to the disposable computer.
@MainActor func verifyPhoneComposerDrafts(
    app: XCUIApplication, words: String, tab: (String) -> Void, picture: (String) -> Void,
    recordKeyboard: (Bool) async throws -> Void
) async throws {
    let input = app.textFields["message-box"]
    verifyPhoneComposerBounds(app: app)
    picture("composed-draft-keyboard")
    try await recordKeyboard(true)
    try await dismissPhoneJourneyKeyboard(app: app)
    XCTAssertEqual(input.value as? String, words)
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
    try await recordKeyboard(false)

    // Exercise the removal control as well as Photos and Send, without losing the unsent words.
    app.buttons["photo-chip"].tap()
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 0)
    XCTAssertEqual(input.value as? String, words)
    addPhoneJourneyPhoto(app: app)
    for name in ["Activity", "Tasks", "Cards"] {
        tab(name)
        let surface = name == "Activity" ? app.scrollViews["activity-list"]
            : name == "Tasks" ? app.buttons["group-waiting"] : app.scrollViews["card-scroll"]
        XCTAssertTrue(surface.waitForExistence(timeout: 10), "The requested tab actually opens")
        XCTAssertTrue(surface.isHittable)
        XCTAssertEqual(input.value as? String, words, "Changing tabs keeps the unsent words")
        XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1, "Changing tabs keeps the picked photo")
        XCTAssertEqual(app.textFields.matching(identifier: "message-box").count, 1)
        verifyPhoneComposerBounds(app: app)
    }
    picture("draft-after-tabs")
    XCUIDevice.shared.orientation = .landscapeLeft
    app.activate()
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    if UIDevice.current.userInterfaceIdiom == .pad {
        let sidebar = app.scrollViews["phone-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        let cardsTab = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cards")).firstMatch
        XCTAssertFalse(cardsTab.isHittable, "Landscape columns have no second tab row above them")
        XCTAssertLessThanOrEqual(sidebar.frame.maxX, input.frame.minX,
            "The landscape composer belongs to the stage beside the sidebar")
        phoneActivityDisclosure(in: sidebar).tap()
        // The search waits above the list until it is pulled down (INF-589 item 9), so the first group stands for Tasks.
        let tasks = sidebar.buttons["group-waiting"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "Collapsing Activity reveals Tasks in the landscape sidebar")
        XCTAssertTrue(tasks.isHittable)
    }
    XCTAssertEqual(input.value as? String, words, "Rotating keeps the unsent words")
    XCTAssertTrue(input.isHittable, "The composer remains visible at the stage's foot")
    XCTAssertGreaterThan(input.frame.minY, app.frame.midY)
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
    XCTAssertEqual(app.textFields.matching(identifier: "message-box").count, 1)
    verifyPhoneComposerBounds(app: app)
    // INF-82: draft retention alone missed a card reduced to a thin attribution strip.
    // Read the complete native heading, then scroll actual body text and an action into view.
    if UIDevice.current.userInterfaceIdiom == .phone {
        let card = app.scrollViews["card-scroll"]
        let title = app.staticTexts["card-title"]
        XCTAssertTrue(phoneCardReadingBounds(card, app: app).contains(phoneAccessibilityBounds(title.frame)),
            "Landscape leaves room to read the full card heading, not just its attribution")
        XCTAssertTrue(title.isHittable)
        picture("draft-landscape")
        let body = app.webViews.staticTexts.firstMatch
        let action = card.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'card-action-'")).firstMatch
        for element in [body, action] {
            revealPhoneCardReading(element, in: card, app: app)
            XCTAssertTrue(element.isHittable, "The landscape card can be read and used")
            XCTAssertTrue(phoneCardReadingBounds(card, app: app).contains(phoneAccessibilityBounds(element.frame)),
                "Landscape shows the complete reading \(element.frame) inside \(phoneCardReadingBounds(card, app: app)), not a clipped sliver")
            picture(element.elementType == .button ? "draft-landscape-card-action" : "draft-landscape-card-body")
        }
        revealPhoneCardReading(title, in: card, app: app)
        XCTAssertTrue(phoneCardReadingBounds(card, app: app).contains(phoneAccessibilityBounds(title.frame)))
        XCTAssertEqual(input.value as? String, words, "Reading the card leaves the draft alone")
        XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
    } else { picture("draft-landscape") }
    if UIDevice.current.userInterfaceIdiom == .pad {
        let sidebar = app.scrollViews["phone-sidebar"]
        phoneActivityDisclosure(in: sidebar).tap()
        XCTAssertTrue(sidebar.staticTexts.matching(identifier: "activity-text").firstMatch.waitForExistence(timeout: 10))
    }
    XCUIDevice.shared.orientation = .portrait
    app.activate()
    XCTAssertTrue(app.scrollViews["phone-sidebar"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    XCTAssertEqual(input.value as? String, words)
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
    verifyPhoneComposerBounds(app: app)
    picture("draft-returned-to-portrait")
    input.tap()
    try await dismissPhoneJourneyKeyboard(app: app, usingKey: true)
    XCTAssertEqual(input.value as? String, words, "The keyboard command does not type into the draft")
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
    // The full journey has relaunched before this point: sibling app commands must still work too.
    try await pressPhoneKey("i", modifiers: .command, in: app)
    let closeDetails = app.buttons["close-computer-details"]
    XCTAssertTrue(closeDetails.waitForExistence(timeout: 10))
    // INF-499 #8: one real press must not send the retained text/photo behind a native sheet.
    try await pressPhoneKey(XCUIKeyboardKey.return.rawValue, modifiers: .command, in: app)
    picture("sheet-after-command-return")
    closeDetails.tap()
    XCTAssertTrue(closeDetails.waitForNonExistence(timeout: 10))
    picture("draft-after-sheet-command-return")
    XCTAssertEqual(input.value as? String, words)
    XCTAssertEqual(app.buttons.matching(identifier: "photo-chip").count, 1)
}

/// The native scroll view extends behind translucent navigation chrome; that covered area is not readable.
@MainActor private func phoneCardReadingBounds(_ card: XCUIElement, app: XCUIApplication) -> CGRect {
    let frame = phoneAccessibilityBounds(card.frame.intersection(app.frame))
    let top = max(frame.minY, phoneAccessibilityBounds(app.navigationBars.firstMatch.frame).maxY)
    return CGRect(x: frame.minX, y: top, width: frame.width, height: max(0, frame.maxY - top))
}

/// A short viewport needs a measured drag, not an inertial whole-view swipe that skips a paragraph.
/// Keep the same complete-containment assertion, and scroll toward the actual element in either direction.
@MainActor private func revealPhoneCardReading(_ element: XCUIElement, in card: XCUIElement, app: XCUIApplication) {
    for _ in 0..<8 {
        let visible = phoneCardReadingBounds(card, app: app)
        let frame = phoneAccessibilityBounds(element.frame)
        // XCTest cannot resolve a hit point for an entirely offscreen native label.
        // Geometry decides whether to scroll first; hittability is still required once it is visible.
        if visible.contains(frame) && element.isHittable { return }
        let distance = min(visible.height * 0.6, abs(frame.midY - visible.midY))
        let direction: CGFloat = frame.midY > visible.midY ? 1 : -1
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: visible.midX, dy: visible.midY + direction * distance / 2))
        let end = origin.withOffset(CGVector(dx: visible.midX, dy: visible.midY - direction * distance / 2))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }
}

/// The single native picker reader for the composed-draft and send journey.
@MainActor func addPhoneJourneyPhoto(app: XCUIApplication) {
    let photos = app.buttons["add-photos"]
    XCTAssertTrue(photos.isHittable); photos.tap()
    let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo' OR label BEGINSWITH 'Screenshot'")).firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription)
    // iOS 26 exposes the real asset frame, but not a hittable AX point; never guess a screen coordinate.
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons.matching(NSPredicate(format: "label == 'Done' OR label == 'Add'")).firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 10)); XCTAssertTrue(add.isEnabled); add.tap()
    XCTAssertTrue(app.buttons["photo-chip"].waitForExistence(timeout: 10), app.debugDescription)
}

/// INF-230: the actual footer contains every visible row and does not overlap native bottom tabs or the keyboard.
@MainActor func verifyPhoneComposerBounds(app: XCUIApplication) {
    let footer = app.otherElements["phone-composer"].firstMatch
    XCTAssertTrue(footer.waitForExistence(timeout: 10))
    let controls = [app.textFields["message-box"], app.buttons["add-photos"], app.buttons["send-message"],
                    app.buttons["photo-chip"], app.staticTexts["last-turn-you"], app.staticTexts["last-turn-reply"],
                    app.staticTexts["connection-refusal"], app.staticTexts["message-problem"]]
    for control in controls where control.exists {
        XCTAssertTrue(phoneAccessibilityBounds(footer.frame).contains(phoneAccessibilityBounds(control.frame)),
            "The footer clips \(control.identifier): \(control.frame) outside \(footer.frame)")
        if control.elementType == .button && control.isEnabled {
            XCTAssertTrue(control.isHittable, "The footer control \(control.identifier) can be pressed")
        }
    }
    XCTAssertTrue(app.frame.contains(footer.frame), "The footer fits inside the window")
    // INF-230 review: the card's pager belongs between its scrollable body and the composer,
    // including the iPad's top-tab and landscape layouts, not underneath the overlay.
    let card = app.scrollViews["card-scroll"]
    if card.exists {
        let pager = app.descendants(matching: .any).matching(identifier: "card-pager").firstMatch
        XCTAssertTrue(pager.waitForExistence(timeout: 10))
        XCTAssertTrue(pager.isHittable, "The card pager is not covered by the composer")
        for id in ["previous-card", "card-pager", "next-card"] {
            let control = app.descendants(matching: .any).matching(identifier: id).firstMatch
            if !control.exists { continue }
            let frame = phoneAccessibilityBounds(control.frame)
            XCTAssertTrue(phoneAccessibilityBounds(app.frame).contains(frame), "The entire \(id) stays on screen")
            XCTAssertLessThanOrEqual(frame.maxY, phoneAccessibilityBounds(footer.frame).minY,
                "\(id) \(control.frame) belongs above the composer \(footer.frame)")
            XCTAssertLessThanOrEqual(phoneAccessibilityBounds(card.frame).maxY, frame.minY,
                "The card scroll area stays above \(id), rather than extending behind it")
            if control.isEnabled { XCTAssertTrue(control.isHittable, "\(id) remains usable above the composer") }
        }
    }
    let keyboard = app.keyboards.firstMatch
    if keyboard.exists {
        XCTAssertLessThanOrEqual(footer.frame.maxY, keyboard.frame.minY, "The composer stays above the keyboard")
    }
    let bar = app.tabBars.firstMatch
    if bar.exists && bar.isHittable && bar.frame.midY > app.frame.midY {
        XCTAssertLessThanOrEqual(footer.frame.maxY, bar.frame.minY, "The composer stays above the native tabs")
    }
}

/// AX containers use Float coordinates while their children can expose Double coordinates.
/// Compare at the container's precision, rather than mistaking floating-point noise for a clipped pixel.
@MainActor private func phoneAccessibilityBounds(_ frame: CGRect) -> CGRect {
    let x = CGFloat(Float(frame.minX)), y = CGFloat(Float(frame.minY))
    return CGRect(x: x, y: y, width: CGFloat(Float(frame.maxX)) - x, height: CGFloat(Float(frame.maxY)) - y)
}

/// Done and the native Hide keyboard command leave the actual component-owned draft untouched.
@MainActor private func dismissPhoneJourneyKeyboard(app: XCUIApplication, usingKey: Bool = false) async throws {
    let done = app.navigationBars.buttons["dismiss-phone-keyboard"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    XCTAssertTrue(done.isHittable)
    if usingKey { try await pressPhoneKey("k", modifiers: [.command, .shift], in: app) } else { done.tap() }
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
}

/// INF-209: read the native disclosure inside its sidebar, never the identically named tab.
@MainActor func phoneActivityDisclosure(in sidebar: XCUIElement) -> XCUIElement {
    sidebar.buttons["Activity"]
}
