import XCTest

/// Issue #46: a scrolled Tasks list must still draw rows when a Start or a family update moves work between groups.
/// The board sizes and actions reproduce the reported failure; the real home owns tasks and sends their updates.
extension PhoneJourney {
    func testTaskListStartAtBottom() async throws {
        try await taskListUpdate("N0", working: 3, backlog: 60, done: 3, target: "b-59", openBacklog: true)
    }

    func testTaskListStartInMiddle() async throws {
        try await taskListUpdate("M0", working: 3, backlog: 60, done: 3, target: "b-30", openBacklog: true, scrollToEnd: false)
    }

    func testTaskListFamilyFinishes() async throws {
        // The only running part finishes; its 31-task family leaves Working for folded Backlog.
        try await taskListUpdate("F1", working: 20, backlog: 1, done: 3, family: 30, running: true,
                                 target: "c-29", operation: "done", openAfterShrink: true)
    }

    func testTaskListFamilyStarts() async throws {
        // Starting one part moves the same size family out of the open Backlog.
        try await taskListUpdate("F3", working: 3, backlog: 30, done: 3, family: 30,
                                 target: "b-29", openBacklog: true, operation: "start")
    }

    func testTaskListFamilyFinishesToFit() async throws {
        try await taskListUpdate("F1S", working: 2, backlog: 1, family: 20, running: true,
                                 target: "c-19", operation: "done")
        XCTAssertTrue(app.buttons["task-task-list-F1S-w-0"].isHittable && app.buttons["group-landed"].isHittable,
                      "The remaining Working rows and last group must fit together after the shrink")
    }

    func testTaskListFamilyFinishesInMiddle() async throws {
        // Same shrink as F1, but leave more family rows below the viewport instead of pinning it to the end.
        try await taskListUpdate("F1M", working: 20, backlog: 1, done: 3, family: 30, running: true,
                                 target: "c-14", operation: "done", scrollToEnd: false)
    }

    func testTaskListOpensDoneAtBottom() async throws {
        try await launchJoined()
        _ = try await home("empty-cards")
        tab("Tasks", repeatDiscarded: false)
        _ = try await home("task-list-seed", body: "{\"prefix\":\"D0\",\"working\":3,\"backlog\":60,\"done\":30}")
        let backlog = app.buttons["group-backlog"]
        XCTAssertTrue(backlog.waitForPresence(timeout: 20))
        tapOnPhone(backlog)
        let list = app.scrollViews["tasks-list"]
        let done = app.buttons["group-landed"]
        for _ in 0..<45 {
            if done.exists && done.isHittable { break }
            list.swipeUp(velocity: .slow)
        }
        for _ in 0..<3 { list.swipeUp(velocity: .fast) }
        XCTAssertTrue(done.exists && done.isHittable, "Done must be visible at the bottom before opening it")
        picture("task-list-D0-before")
        _ = try await home("capture-start")
        tapOnPhone(done)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "task-task-list-D0-d-"))
        XCTAssertTrue(rows.firstMatch.waitForPresence(timeout: 20), "Opening Done must load its rows")
        picture("task-list-D0-after")
        XCTAssertTrue(done.exists && done.isHittable, "Opening Done must keep its header in view, not follow its oldest rows")
        _ = try await home("capture-stop")
    }

    func testTaskListShortListKeepsPosition() async throws {
        try await launchJoined()
        _ = try await home("empty-cards")
        tab("Tasks", repeatDiscarded: false)
        _ = try await home("task-list-seed", body: "{\"prefix\":\"S0\",\"working\":2,\"backlog\":2}")
        let backlog = app.buttons["group-backlog"]
        XCTAssertTrue(backlog.waitForPresence(timeout: 20))
        tapOnPhone(backlog)
        let last = app.buttons["task-task-list-S0-b-1"]
        let working = app.buttons["task-task-list-S0-w-0"]
        XCTAssertTrue(last.waitForPresence(timeout: 10))
        XCTAssertTrue(working.isHittable && last.isHittable, "The open short list must fit on screen")
        waitForSteadyTarget(working)
        let restingY = working.frame.minY
        picture("task-list-S0-before")
        _ = try await home("capture-start")
        tapOnPhone(backlog)
        XCTAssertTrue(last.waitForAbsence(timeout: 10))
        waitForSteadyTarget(working)
        picture("task-list-S0-after")
        XCTAssertEqual(working.frame.minY, restingY, accuracy: 1, "Shrinking a fitting list must leave its Working row in place")
        _ = try await home("capture-stop")
    }

    private func taskListUpdate(_ name: String, working: Int, backlog: Int, done: Int = 0, family: Int = 0,
                                running: Bool = false, target: String, openBacklog: Bool = false,
                                operation: String? = nil, scrollToEnd: Bool = true, openAfterShrink: Bool = false) async throws {
        try await launchJoined()
        _ = try await home("empty-cards")
        tab("Tasks", repeatDiscarded: false)
        var blanks: [String] = []
        let list = app.scrollViews["tasks-list"]
        _ = try await home("task-list-seed", body: "{\"prefix\":\"\(name)x\",\"backlog\":1}")
        let header = app.buttons["group-backlog"]
        XCTAssertTrue(header.waitForPresence(timeout: 20))
        let probe = app.buttons["task-task-list-\(name)x-b-0"]
        let expanded = probe.waitForPresence(timeout: 3)
        if expanded != openBacklog { tapOnPhone(header) }
        if openBacklog { XCTAssertTrue(probe.waitForPresence(timeout: 10)) }
        else { XCTAssertTrue(probe.waitForAbsence(timeout: 10)) }
        _ = try await home("task-list-seed", body: "{\"prefix\":\"\(name)\",\"working\":\(working),\"backlog\":\(backlog),\"done\":\(done),\"startable\":true,\"family\":\(family),\"familyRunning\":\(running)}")
        let row = app.buttons["task-task-list-\(name)-\(target)"]
        let viewport = list.frame
        for _ in 0..<45 {
            if row.exists, row.frame.maxY <= viewport.maxY, row.frame.minY >= viewport.minY + 110 { break }
            if row.exists, row.frame.minY < viewport.minY + 110 { list.swipeDown(velocity: .slow) }
            else { list.swipeUp(velocity: .slow) }
        }
        XCTAssertTrue(row.exists && row.isHittable, "\(name): the target row must be on screen before its update")
        if scrollToEnd { for _ in 0..<3 { list.swipeUp(velocity: .fast) } }
        if !scrollToEnd, operation != nil {
            XCTAssertFalse(app.buttons["group-landed"].isHittable, "The shrink case must start away from the list's end")
        }
        taskListRead("\(name)-before", blanks: &blanks)
        _ = try await home("capture-start")
        if let operation {
            _ = try await home("task-list-op", body: "{\"ids\":[\"task-list-\(name)-c-0\"],\"op\":\"\(operation)\"}")
        } else {
            waitForSteadyTarget(row)
            let from = row.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
            let to = row.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: 150), thenHoldForDuration: 0.3)
            let start = app.buttons["row-start-task-list-\(name)-\(target)"]
            XCTAssertTrue(start.waitForPresence(timeout: 10))
            tapOnPhone(start)
        }
        // Observe the reported persistent blank after the update, not a transient animation frame.
        try await Task.sleep(for: .seconds(4))
        taskListRead("\(name)-after", blanks: &blanks)
        if openAfterShrink {
            XCTAssertTrue(header.exists && header.isHittable, "The corrected viewport must show folded Backlog")
            picture("task-list-\(name)-before-opening")
            tapOnPhone(header)
            XCTAssertTrue(probe.waitForPresence(timeout: 20), "Opening Backlog must show its first row")
            picture("task-list-\(name)-after-opening")
            XCTAssertTrue(header.exists && header.isHittable, "Opening Backlog after a correction must keep its header in view")
        }
        _ = try await home("capture-stop")
        XCTAssertTrue(blanks.isEmpty, "The list showed no task row after an update: \(blanks)")
    }

    private func taskListRead(_ name: String, blanks: inout [String]) {
        picture("task-list-\(name)")
        var viewport = CGRect.null
        var rows: [CGRect] = []
        func walk(_ element: XCUIElementSnapshot) {
            if element.identifier == "tasks-list", viewport.isNull { viewport = element.frame }
            if element.identifier.hasPrefix("task-task-list-") { rows.append(element.frame) }
            for child in element.children { walk(child) }
        }
        if let root = try? app.snapshot() { walk(root) }
        // Exclude the top bar covering the first 110 points, as in the issue's reproduction.
        let visible = CGRect(x: viewport.minX, y: viewport.minY + 110, width: viewport.width, height: max(0, viewport.height - 110))
        let count = rows.filter { $0.intersection(visible).height >= 8 && !$0.intersection(visible).isNull }.count
        print("Task list \(name): realized=\(rows.count) visible=\(count)")
        if count == 0 { blanks.append(name) }
    }
}
