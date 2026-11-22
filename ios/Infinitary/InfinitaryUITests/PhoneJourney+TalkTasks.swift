import XCTest

/// The talk-tasks part (scripts/phone-test-plan.ts): its test and the steps only it takes.
extension PhoneJourney {
    /// INF-2125 direction C, the second talk test: Tasks after a relaunch pair, search, start, interrupt, continue, steer
    /// and the notice that opens its card.
    func testTasksAndSteer() async throws {
        let fixture = try await launchWithLastTurn()
        try await tasksAndSteer(fixture)
    }

    /// INF-2935: the record's status pill, which reads the Mac's word for the task.
    private func recordReads(_ word: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "task-record-status", word)).firstMatch
    }

    /// One entry of a row's long press menu, by the name it starts with; its line under the name, what it does or why it
    /// cannot run, may follow in the same label.
    private func moveEntry(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// INF-6073: a task row's left swipe, as a slow drag that keeps touching for two seconds or more. Every touch first
    /// waits on SpringBoard, which decides whether it is a system gesture before the app's own gestures may act, and
    /// XCTest takes its virtual touch screen away about a tenth of a second after the lift. A plain swipe lasts a fifth
    /// of a second, so on a busy simulator SpringBoard can still be deciding when that screen goes; backboardd then
    /// cancels the touch for the app and the row's swipe never acts (phone run 44991488174, where SpringBoard took the
    /// touch 0.35 s late). This drag is still moving long after SpringBoard decides, and it rests before the lift, so
    /// the row opens by its distance, as a finger that slows at the end opens it.
    private func dragRowOpen(_ row: XCUIElement) {
        let from = row.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        let to = row.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: 150), thenHoldForDuration: 0.3)
    }

    /// INF-2928 piece 3, the captain's "Every move the Mac allows on that row": a swipe on a Backlog row shows the Mac's
    /// row Start, dim with the Mac's reason when it cannot start; a long press shows the row's moves under its summary,
    /// a move that cannot run stays dim, and Drop task asks in the record's words before the Mac drops it. One press on
    /// a Start that can run sends the Mac's start, and a refusal says why. The long press offers that same Start, as the
    /// Mac's row shows it at rest, and it too starts at once with no ask. Answers the finished task the fixture seeds.
    private func rowMoves() async throws -> String {
        let seeded = try await home("row-moves-fixture")
        let id = try XCTUnwrap(seeded["id"] as? String)
        let row = app.buttons["task-\(id)"]
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        waitForSteadyTarget(row)
        dragRowOpen(row)
        let waiting = app.buttons["row-start-\(id)"]
        XCTAssertTrue(waiting.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(waiting.isEnabled, "A Start that cannot run stays dim")
        let reason = app.staticTexts["row-start-reason"]
        XCTAssertTrue(reason.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(reason.label, seeded["startReason"] as? String, "The row says the Mac's reason it cannot start")
        picture("task-row-start-reason")
        tapOnPhone(row)
        XCTAssertTrue(waiting.waitForAbsence(timeout: 10), "A tap on the row closes its Start instead of opening it")
        XCTAssertFalse(app.buttons["close-record"].exists, "The tap opened no record")
        // The long press: the Mac's menu for a Backlog row that waits on another task.
        pressRow(row)
        let drop = moveEntry("Drop task")
        XCTAssertTrue(drop.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(moveEntry("Open record").exists, app.debugDescription)
        XCTAssertTrue(moveEntry("Queue it").isEnabled, "Queue it runs at once, as on the Mac")
        // The row's own Start, as the Mac's row shows it at rest: dim, with the Mac's reason under its name.
        let held = moveEntry("Start")
        XCTAssertFalse(held.isEnabled, "Start cannot run while the task it waits on is open")
        XCTAssertTrue(held.label.contains(try XCTUnwrap(seeded["startReason"] as? String)), held.label)
        XCTAssertFalse(moveEntry("Start now").exists, "One Start, the row's, in the board's Start now's place")
        picture("task-moves")
        tapOnPhone(drop)
        let ask = app.alerts.firstMatch
        XCTAssertTrue(ask.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(ask.label, seeded["drop"] as? String, "Drop task asks in the record's words")
        picture("task-drop-ask")
        tapOnPhone(ask.buttons["Drop task"])
        let dropped = try await home("row-moves-dropped")
        let writes = try XCTUnwrap(dropped["writes"] as? [[String: Any]])
        XCTAssertTrue(writes.contains { write in
            let args = write["args"] as? [Any] ?? []
            return write["channel"] as? String == "inf:task:run" && args.first as? String == id
                && args.dropFirst().first as? String == "drop-task" && args.count == 3
        }, "Drop task sends the Mac's drop with what it asked about: \(writes)")
        // A Start that can run: one press sends the Mac's start, with no ask, and its refusal says why.
        let work = app.buttons["task-phone-work"]
        XCTAssertTrue(work.waitForPresence(timeout: 10))
        waitForSteadyTarget(work)
        dragRowOpen(work)
        let start = app.buttons["row-start-phone-work"]
        XCTAssertTrue(start.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(start.isEnabled)
        picture("task-row-start")
        let refusal = "This task changed on your computer. Look at it again."
        _ = try await home("refuse-next-change", body: #"{"channel":"inf:task:run","words":"\#(refusal)"}"#)
        tapOnPhone(start)
        let notice = app.buttons["change-notice"]
        XCTAssertTrue(notice.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertEqual(notice.label, refusal)
        XCTAssertTrue(start.waitForAbsence(timeout: 10), "Start closes the row once pressed")
        let state = try await home("talk-state", method: "GET")
        let sent = try XCTUnwrap(state["writes"] as? [[String: Any]])
        XCTAssertTrue(sent.contains { ($0["args"] as? [String]) == ["phone-work", "start-task"] }, "The row's Start is the Mac's start: \(sent)")
        tapOnPhone(notice)
        XCTAssertTrue(notice.waitForAbsence(timeout: 10))
        // The long press offers that Start too, and one press sends the same start with no ask.
        pressRow(work)
        let pressed = moveEntry("Start")
        XCTAssertTrue(pressed.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(pressed.isEnabled, "The long press's Start runs where the row's does")
        picture("task-moves-start")
        _ = try await home("refuse-next-change", body: #"{"channel":"inf:task:run","words":"\#(refusal)"}"#)
        tapOnPhone(pressed)
        XCTAssertTrue(notice.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.alerts.firstMatch.exists, "The long press's Start asks nothing, as the Mac's row does not")
        let again = try await home("talk-state", method: "GET")
        let starts = try XCTUnwrap(again["writes"] as? [[String: Any]]).filter { ($0["args"] as? [String]) == ["phone-work", "start-task"] }
        XCTAssertEqual(starts.count, 2, "The long press's Start is the Mac's start")
        tapOnPhone(notice)
        XCTAssertTrue(notice.waitForAbsence(timeout: 10))
        return try XCTUnwrap(seeded["done"] as? String)
    }

    /// INF-6075: a task row's long press, held three seconds. UIKit opens the row's menu only when its long-press timer
    /// runs on the app's main thread; a lift that reaches the app before then reads as a tap on the row, which opens its
    /// record instead. XCTest lifts at a fixed time whatever the app is doing, so on a busy runner a main thread that stops
    /// from just after touch-down until past a 1.2 s lift turns the press into that tap (phone run 44991488174, where it
    /// stopped 0.17 s after touch-down for 1.35 s). Held three seconds, the touch is still down when the stopped thread
    /// resumes, so the timer runs first and the menu opens, as it does for a finger that keeps holding.
    private func pressRow(_ row: XCUIElement) {
        waitForSteadyTarget(row)
        row.press(forDuration: 3)
    }

    /// The captain's "long press on a task row in the ios app should at least give all the actions i can take when hovering
    /// the same task row in desktop app tasks panel": a Done row, which the Mac's board offers no menu for, keeps Open
    /// record and pins from its long press as the Mac's row does at rest, and a pinned Done row unpins the same way.
    private func pinDoneRow(_ id: String) {
        let done = app.buttons["group-landed"]
        XCTAssertTrue(done.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(done)
        let row = app.buttons["task-\(id)"]
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        pressRow(row)
        let pin = moveEntry("Pin")
        XCTAssertTrue(pin.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(moveEntry("Open record").exists, "A Done row keeps Open record")
        picture("task-moves-done")
        tapOnPhone(pin)
        let pinned = app.descendants(matching: .any).matching(identifier: "group-pinned").firstMatch
        XCTAssertTrue(pinned.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertLessThan(pinned.frame.minY, row.frame.minY, "The Done row lists under Pinned")
        pressRow(row)
        let unpin = moveEntry("Unpin")
        XCTAssertTrue(unpin.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(moveEntry("Open record").exists, "A pinned Done row keeps Open record")
        picture("task-moves-pinned-done")
        tapOnPhone(unpin)
        XCTAssertTrue(pinned.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(row.waitForPresence(timeout: 10), "Unpinned, it lists under Done again")
    }

    /// INF-3127, the captain's "when a task is pinned, it always show in a "pinned" section in the tasks panel at the
    /// top, no matter what state it's in": Pin from a row's long press lists it once, under Pinned above every group,
    /// and Unpin lists it under its state again.
    private func pinRow(_ id: String) {
        let row = app.buttons["task-\(id)"]
        let pinned = app.descendants(matching: .any).matching(identifier: "group-pinned").firstMatch
        XCTAssertFalse(pinned.exists, "Nothing is pinned yet")
        pressRow(row)
        let pin = moveEntry("Pin")
        XCTAssertTrue(pin.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(pin)
        XCTAssertTrue(pinned.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertTrue(row.waitForPresence(timeout: 10), app.debugDescription)
        XCTAssertLessThan(pinned.frame.minY, app.buttons["group-backlog"].frame.minY, "Pinned sits above every group")
        XCTAssertLessThan(pinned.frame.minY, row.frame.minY, "The row lists under Pinned")
        picture("tasks-pinned")
        pressRow(row)
        let unpin = moveEntry("Unpin")
        XCTAssertTrue(unpin.waitForPresence(timeout: 10), app.debugDescription)
        tapOnPhone(unpin)
        XCTAssertTrue(pinned.waitForAbsence(timeout: 10), app.debugDescription)
        XCTAssertTrue(row.waitForPresence(timeout: 10), "Unpinned, it lists under its state again")
    }

    private func tasksAndSteer(_ fixture: [String: Any]) async throws {
        // INF-1735's one dark and light relaunch pair, with the hero pictures; INF-4241 removed its twenty-pair soak.
        try await relaunchPairs(1, pictured: true)
        XCTAssertTrue(app.buttons["group-backlog"].waitForPresence(timeout: 10))
        picture("tasks")
        // INF-2928 piece 1: as on the Mac, a group with no tasks does not show.
        for empty in ["waiting", "working", "queued", "landed"] {
            XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "group-\(empty)").firstMatch.exists, "\(empty) has no tasks")
        }
        tapOnPhone(app.buttons["group-backlog"])
        XCTAssertTrue(app.buttons["task-phone-work"].waitForPresence(timeout: 10))
        picture("tasks-backlog")
        let finished = try await rowMoves()
        pinRow("phone-work")
        pinDoneRow(finished)
        // INF-589 item 9: search waits above the list until it is pulled down, and Find a task opens it by key, as on the Mac.
        let search = app.textFields["task-search"]
        XCTAssertFalse(search.exists)
        app.scrollViews["tasks-list"].swipeDown()
        XCTAssertTrue(search.waitForPresence(timeout: 10))
        tapOnPhone(app.buttons["close-task-search"])
        XCTAssertTrue(search.waitForAbsence(timeout: 10))
        try await pressPhoneKey("f", modifiers: [.command, .shift], in: app)
        XCTAssertTrue(search.waitForPresence(timeout: 10))
        search.typeText("harbour")
        XCTAssertTrue(app.buttons["task-phone-work"].waitForPresence(timeout: 10))
        // A search keeps the groups and opens them, as the Mac's does.
        XCTAssertTrue(app.buttons["group-backlog"].exists, app.debugDescription)
        picture("task-search")
        tapOnPhone(app.buttons["task-phone-work"])
        XCTAssertTrue(app.buttons["start-task"].waitForPresence(timeout: 10))
        picture("task-before-start")
        _ = try await home("capture-talk-start")
        // INF-2553, the captain's "everything at once, the task record included": a start the computer still holds
        // already reads Starting on the record.
        _ = try await home("hold-card-action", body: #"{"channel":"inf:task:run"}"#)
        tapOnPhone(app.buttons["start-task"])
        _ = try await home("card-action-held")
        XCTAssertTrue(recordReads("Starting").waitForPresence(timeout: 10), "A start shows at the tap, before the computer answers")
        picture("task-start-at-tap")
        _ = try await home("release-card-action")
        let started = try await home("talk-started")
        XCTAssertNotNil(started["startedAt"] as? Double)
        XCTAssertTrue(started["executionDeviceId"] is NSNull, "The phone starts work on its Mac, never on the phone")
        // INF-4463: talk-started answers once the Mac holds the crewmate's first card, before the record's next read
        // brings that card to the phone, and that read puts the Cards tab ahead of Activity and Crewmate. A press made
        // in between found Crewmate where the strip was about to draw Activity, the strip moved under it, and the record
        // stayed on Info. So the press waits for the strip to show the card the Mac answered with: all four of the
        // record's tabs are then in place, and a later card only changes the count beside Cards.
        let cards = try XCTUnwrap(started["cards"] as? [[String: Any]])
        XCTAssertFalse(cards.isEmpty, "talk-started answers once the crewmate's card is on the Mac's record")
        XCTAssertTrue(app.buttons["record-tab-cards"].waitForPresence(timeout: 10), app.debugDescription)
        // INF-2935: the Mac's tabs; the Crewmate tab's status line carries Stop, the Mac's word for Interrupt.
        let crewmateTab = app.buttons["record-tab-crewmate"]
        XCTAssertTrue(crewmateTab.waitForPresence(timeout: 10)); tapOnPhone(crewmateTab)
        let stop = app.buttons["crew-stop"]
        XCTAssertTrue(stop.waitForPresence(timeout: 10))
        XCTAssertEqual(stop.label, "Stop")
        picture("crewmate-working")
        _ = try await home("capture-stop")
        // INF-2553's Stopping at the tap is PhoneIntentsTests' anInterruptReadsStoppingUntilTheTurnEnds; INF-4241 keeps the
        // held Start and steer here, the same at-the-tap rule on the record, and lets the Stop through.
        tapOnPhone(stop)
        let interrupted = try await home("talk-interrupted")
        let events = try XCTUnwrap(interrupted["events"] as? [[String: Any]])
        XCTAssertTrue(events.contains { $0["kind"] as? String == "interrupted" && $0["actor"] as? String == "captain" })
        XCTAssertEqual(interrupted["activity"] as? String, "idle", "Interrupt stops the turn and keeps it steerable")
        _ = try await home("talk-resumable")
        // The record bar, with Continue, ends Info; the Crewmate tab ends with its status line and the message box.
        tapOnPhone(app.buttons["record-tab-info"])
        XCTAssertTrue(recordReads("Interrupted").waitForPresence(timeout: 10))
        XCTAssertTrue(app.buttons["continue-task"].waitForPresence(timeout: 10))
        picture("task-interrupted")
        tapOnPhone(app.buttons["continue-task"])
        tapOnPhone(crewmateTab)
        XCTAssertTrue(stop.waitForPresence(timeout: 20))
        let steer = try XCTUnwrap(fixture["steer"] as? String)
        let steerField = app.textFields["steer-box"]
        focusForPhoneTyping(steerField, in: app); steerField.typeText(steer)
        // INF-2553: a steer the computer still holds already shows in the transcript, marked sending, and the box clears.
        _ = try await home("hold-card-action", body: #"{"channel":"inf:task:steer"}"#)
        tapOnPhone(app.buttons["steer-task"])
        _ = try await home("card-action-held")
        XCTAssertTrue(app.staticTexts["crew-sending"].waitForPresence(timeout: 10), "A steer shows at the tap, before the computer answers")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", steer)).firstMatch.exists, "The sending line carries the steer's words")
        XCTAssertNotEqual(steerField.value as? String, steer, "The steer box clears at the tap")
        picture("task-steer-at-tap")
        _ = try await home("release-card-action")
        let steered = try await home("talk-steered")
        let task = try XCTUnwrap(steered["task"] as? [String: Any])
        XCTAssertEqual(task["outcome"] as? String, fixture["report"] as? String)
        let allWrites = try XCTUnwrap(steered["writes"] as? [[String: Any]])
        for write in allWrites { XCTAssertEqual((write["actor"] as? [String: Any])?["kind"] as? String, "captain") }
        XCTAssertTrue(allWrites.contains { $0["channel"] as? String == "inf:task:run" && ($0["args"] as? [String])?.last == "continue-task" })
        picture("crewmate-steered")
        tapOnPhone(app.buttons["close-record"])
        // INF-589 item 6: the notice is a quiet pill under the title on any tab, and a tap opens its card.
        let notice = app.buttons["phone-notice"]
        XCTAssertTrue(notice.waitForPresence(timeout: 10))
        // INF-1062: the notice sits under the top bar on any tab, never over its strip.
        let bar = app.navigationBars.firstMatch
        XCTAssertGreaterThanOrEqual(notice.frame.minY, bar.frame.maxY, "The notice sits under the bar, not over it")
        XCTAssertTrue(app.buttons["tab-tasks"].isSelected, "The notice shows on Tasks, where the record was")
        picture("foreground-notice")
        // INF-1541 piece 1: turned, an iPhone's strip moves into the bar; an iPad brings Home's stage beside the sidebar,
        // where INF-1524 counts the new card beside the pager, so its count is what the turn carries into view.
        // INF-4241: the layout the turn shows decides, never the kind of device.
        let turned = phoneTurnedLayout(app)
        turnPhone(to: .landscapeLeft, in: app, moving: turned == .wide ? app.buttons["card-new"] : app.buttons["tab-home"])
        XCTAssertEqual(phoneShownLayout(app), turned, "Turned, the app shows the layout read before the turn")
        if turned == .wide {
            // INF-589 item 16: in landscape the stage is Home, beside the sidebar rather than across it.
            // INF-1524, the captain's pick: Home counts the new card beside the pager instead of a pill over the stage.
            let sidebar = phoneSidebar(app)
            XCTAssertTrue(sidebar.waitForPresence(timeout: 10))
            let fresh = app.buttons["card-new"]
            XCTAssertTrue(fresh.waitForPresence(timeout: 10), app.debugDescription)
            XCTAssertNotNil(fresh.label.wholeMatch(of: /[1-9][0-9]* new/), fresh.label)
            XCTAssertFalse(notice.exists, "Home counts the new card instead of a pill")
            XCTAssertGreaterThanOrEqual(fresh.frame.minX, sidebar.frame.maxX, "The count belongs to the stage")
            picture("notice-landscape")
        } else {
            // INF-589 item 17: on its side the card gets the height; the one-row bar keeps its strip and the notice waits.
            XCTAssertTrue(notice.waitForAbsence(timeout: 10))
            XCTAssertTrue(waitForPhonePress(app.buttons["tab-home"]), "The strip stays in the bar on its side")
            picture("on-its-side")
        }
        // Upright, the strip comes back under the bar: from the bar on an iPhone, and from nowhere on an iPad.
        turnPhone(to: .portrait, in: app, moving: app.buttons["tab-home"])
        XCTAssertTrue(notice.waitForPresence(timeout: 10), "Upright, the unread notice returns")
        let noticed = notice.label
        tapOnPhone(notice)
        XCTAssertTrue(notice.waitForAbsence(timeout: 10))
        let heading = app.staticTexts["card-title"]
        XCTAssertTrue(heading.waitForPresence(timeout: 10))
        XCTAssertTrue(noticed.hasSuffix(": " + heading.label), "The notice \(noticed) opens its own card, not \(heading.label)")
        // The card opens on Home, where the last turn and the message box are.
        XCTAssertTrue(app.buttons["tab-home"].isSelected)
        XCTAssertTrue(app.staticTexts["last-turn-you"].waitForPresence(timeout: 10))
    }
}
