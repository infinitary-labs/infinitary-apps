import Foundation
import Testing
@testable import InfinitaryKit

/// INF-1517, the captain's picks: Home loses its Minimized menu, so a card put aside on the Mac is reached from the
/// phone's Tasks, placed by the Mac's own rule (`presentTask` and `presentBoard`, src/shared/taskWaiting.ts).
struct PhoneBoardTests {
    private func task(_ id: String, key: String, title: String, status: String, activity: String? = nil) -> [String: Any] {
        var row: [String: Any] = [
            "id": id, "key": key, "projectId": "proj-harbour", "parentId": NSNull(), "kind": "work", "title": title,
            "status": status, "createdAt": 1_793_000_000_000, "startPolicy": "when-ready", "blockedBy": [],
            "waitingCardId": NSNull(),
        ]
        if let activity { row["activity"] = activity }
        return row
    }

    private func board(_ tasks: [[String: Any]]) throws -> PhoneBoard {
        let json: [String: Any] = ["seq": 41, "tasks": tasks, "projects": [["id": "proj-harbour", "name": "Harbour"]]]
        return try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func card(_ id: String, title: String, task: String?, minimized: Bool, awaiting: String? = nil) throws -> PhoneCard {
        var value: [String: PhoneJSON] = [
            "id": .string(id), "title": .string(title), "author": .string(task == nil ? "firstmate" : "crewmate"),
            "body": .string("<p>\(title).</p>"), "actions": .array([]),
        ]
        if let task { value["taskId"] = .string(task) }
        if minimized { value["minimized"] = .bool(true) }
        if let awaiting { value["awaiting"] = .string(awaiting) }
        return try PhoneCard(.object(value))
    }

    @Test func aCardPutAsideListsItsTaskUnderWaitingOnYou() throws {
        let raw = try board([
            task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "active", activity: "idle"),
            task("t-buoys", key: "INF-13", title: "Count the buoys", status: "open"),
        ])
        let cards = [try card("c-chart", title: "The chart is ready", task: "t-chart", minimized: true)]
        let shown = raw.presenting(cards)
        #expect(raw.groups["t-chart"] == .working)
        #expect(shown.groups["t-chart"] == .waiting)
        #expect(shown.groups["t-buoys"] == .queued)
        #expect(shown.tasklessMinimized(cards).isEmpty)
        #expect(PhoneBoard.minimized(of: try #require(shown.tasks.first), in: cards).map(\.id) == ["c-chart"])
    }

    /// INF-1293's mask: while the author still works, putting its card aside does not give the captain the turn.
    @Test func aWorkingAuthorKeepsItsTaskUnderWorking() throws {
        let raw = try board([task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "active", activity: "running")])
        let cards = [try card("c-chart", title: "The chart is ready", task: "t-chart", minimized: true)]
        let shown = raw.presenting(cards)
        #expect(shown.groups["t-chart"] == .working)
        // Its row still brings the card back, as the Mac's Working row does.
        #expect(PhoneBoard.minimized(of: try #require(shown.tasks.first), in: cards).map(\.id) == ["c-chart"])
    }

    @Test func aCardWithNoTaskGetsItsOwnRowAndAShownCardNone() throws {
        let raw = try board([])
        let cards = [
            try card("c-note", title: "Your phone is reading your Mac", task: nil, minimized: true),
            try card("c-open", title: "Keep the harbour note", task: nil, minimized: false),
        ]
        #expect(raw.presenting(cards).tasklessMinimized(cards).map(\.title) == ["Your phone is reading your Mac"])
    }
}
