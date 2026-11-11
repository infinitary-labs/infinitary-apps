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

    // INF-3588, the captain's report on INF-3586: a task's row should show its latest available card, and open the task
    // only when no card is up. The row follows the Mac's `openTask` order (src/renderer/src/plugins/point/openTask.ts).
    private func row(_ id: String, kind: String = "work", status: String, waiting: String? = nil, step: String? = nil) throws -> PhoneTask {
        var row = task(id, key: "INF-21", title: "Explain the harbour launch window", status: status, activity: "idle")
        row["kind"] = kind
        if let waiting { row["waitingCardId"] = waiting }
        if let step { row["requiredAction"] = ["state": step] }
        return try #require(try board([row]).tasks.first)
    }

    private func shown(_ id: String, task: String, at: Double, actions: Bool = false, by author: String = "crewmate",
                       extra: [String: PhoneJSON] = [:]) throws -> PhoneCard {
        var value: [String: PhoneJSON] = [
            "id": .string(id), "title": .string(id), "author": .string(author), "taskId": .string(task),
            "body": .string("<p>The harbour launch window opens at the morning tide.</p>"), "status": .string("ready"),
            "createdAt": .number(at),
            "actions": .array(actions ? [.object(["id": .string("merge"), "label": .string("Merge"), "default": .bool(true)])] : []),
        ]
        if author == "firstmate" { value["meta"] = .string("firstmate"); value["taskId"] = nil }
        value.merge(extra) { _, new in new }
        return try PhoneCard(.object(value))
    }

    @Test func aRowShowsItsNewestCardOnTheStackWhenNoDecisionWaits() throws {
        let task = try row("t-harbour", status: "active")
        let cards = [
            try shown("c-plan", task: "t-harbour", at: 1_793_000_001_000),
            try shown("c-answer", task: "t-harbour", at: 1_793_000_002_000),
            try shown("c-ended", task: "t-harbour", at: 1_793_000_003_000,
                      extra: ["ended": .object(["at": .number(1_793_000_003_500), "line": .string("Merged")])]),
            try shown("c-writing", task: "t-harbour", at: 1_793_000_004_000, extra: ["status": .string("streaming")]),
            try shown("c-answering", task: "t-harbour", at: 1_793_000_005_000, extra: ["awaiting": .string("answer")]),
            try shown("c-other", task: "t-mast", at: 1_793_000_006_000),
        ]
        #expect(PhoneBoard.opening(task, in: cards, canChange: true) == .card("c-answer"))
        // A card the captain replied under stays on the stack while its author answers, and shows as the newest.
        let replied = try shown("c-replied", task: "t-harbour", at: 1_793_000_007_000,
                                extra: ["awaiting": .string("answer"), "sentBackAt": .number(1_793_000_007_500)])
        #expect(PhoneBoard.opening(task, in: cards + [replied], canChange: true) == .card("c-replied"))
        #expect(PhoneBoard.opening(task, in: Array(cards[2...]), canChange: true) == .record)
    }

    @Test func aRowShowsTheDecisionItWaitsOnBeforeANewerCard() throws {
        let task = try row("t-harbour", status: "open", waiting: "c-merge", step: "ready")
        let cards = [
            try shown("c-merge", task: "t-harbour", at: 1_793_000_001_000, actions: true),
            try shown("c-answer", task: "t-harbour", at: 1_793_000_002_000),
        ]
        #expect(PhoneBoard.opening(task, in: cards, canChange: true) == .card("c-merge"))
        #expect(PhoneBoard.opening(task, in: cards, canChange: false) == .card("c-merge"))
    }

    @Test func aRowShowsTheCardsItBringsBackAndOutOfReachOpensTheRecord() throws {
        let task = try row("t-harbour", status: "open", waiting: "c-merge")
        let cards = [
            try shown("c-merge", task: "t-harbour", at: 1_793_000_001_000, actions: true, extra: ["minimized": .bool(true)]),
            try shown("c-answer", task: "t-harbour", at: 1_793_000_002_000, extra: ["minimized": .bool(true)]),
        ]
        let back = Set(PhoneBoard.minimized(of: task, in: cards).map(\.id))
        #expect(back == ["c-merge", "c-answer"])
        #expect(PhoneBoard.opening(task, in: cards, back: back, canChange: true) == .card("c-merge"))
        // Out of reach, the phone brings nothing back, so nothing of the task is on the stack to show.
        #expect(PhoneBoard.opening(task, in: cards, canChange: false) == .record)
    }

    @Test func aStepPutOffShowsItsCardAgainOnlyWhenThePhoneCanChange() throws {
        let task = try row("t-harbour", status: "open", step: "deferred")
        let cards = [try shown("c-answer", task: "t-harbour", at: 1_793_000_002_000)]
        #expect(PhoneBoard.opening(task, in: cards, canChange: true) == .showCard)
        #expect(PhoneBoard.opening(task, in: cards, canChange: false) == .card("c-answer"))
        #expect(PhoneBoard.opening(try row("t-harbour", status: "open", step: "blocked"), in: [], canChange: true) == .record)
    }

    /// INF-2928 piece 1, the captain's pick, until INF-2941: a first mate question's card names no task, so its row opens
    /// the record, where Dismiss is.
    @Test func aFirstMateQuestionOpensItsRecord() throws {
        let task = try row("t-question", kind: "decision", status: "open", waiting: "harbour-review-day")
        let cards = [try shown("harbour-review-day", task: "t-question", at: 1_793_000_001_000, actions: true, by: "firstmate")]
        #expect(PhoneBoard.opening(task, in: cards, canChange: true) == .record)
    }

    // INF-1854: re-reading a whole 1,227-row board on every task change stalled the phone's scene each couple of
    // seconds. A delta folds onto the board held, as the Mac's applyTaskBoardDelta does; only a gap re-reads.
    private func delta(base: Int, seq: Int, upserts: [[String: Any]], removed: [String],
                       added: [[String: String]] = [], unlinked: [[String: String]] = []) throws -> PhoneBoardDelta {
        let json: [String: Any] = ["baseSeq": base, "seq": seq, "at": 1_793_000_100_000, "upserts": upserts, "removed": removed,
                                   "projects": [["id": "proj-harbour", "name": "Harbour"]], "links": ["added": added, "removed": unlinked]]
        return try JSONDecoder().decode(PhoneBoardDelta.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func aDeltaOnItsBaseGivesTheNextBoard() throws {
        var later = task("t-tide", key: "INF-14", title: "Read the tide table", status: "open")
        later["createdAt"] = 1_793_000_000_500
        let held = try board([
            task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "active", activity: "idle"),
            task("t-buoys", key: "INF-13", title: "Count the buoys", status: "open"),
        ])
        let next = try #require(held.applying(delta(
            base: 41, seq: 42,
            upserts: [later, task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "active", activity: "running")],
            removed: ["t-buoys"], added: [["fromId": "t-chart", "toId": "t-tide", "type": "blocks"]])))
        #expect(next.seq == 42)
        #expect(next.tasks.map(\.id) == ["t-chart", "t-tide"])
        #expect(next.tasks.first?.activity == "running")
        #expect(next.groups["t-chart"] == .working)
        #expect(next.links?.map(\.toId) == ["t-tide"])
        let unlinked = try #require(next.applying(delta(base: 42, seq: 43, upserts: [], removed: [],
                                                        unlinked: [["fromId": "t-chart", "toId": "t-tide", "type": "blocks"]])))
        #expect(unlinked.links?.isEmpty == true)
    }

    @Test func aDeltaPastAGapAsksForTheWholeBoardAndAnOldOneChangesNothing() throws {
        let held = try board([task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "open")])
        #expect(held.applying(try delta(base: 43, seq: 44, upserts: [], removed: ["t-chart"])) == nil)
        let stale = try #require(held.applying(delta(base: 40, seq: 41, upserts: [], removed: ["t-chart"])))
        #expect(stale.seq == 41 && stale.tasks.map(\.id) == ["t-chart"])
    }

    /// INF-2773: a reopen reads a run of deltas and folds them with one sort; the board is the one applying each in
    /// turn gives, through an upsert after a removal, a task removed after its upsert, a link added then taken away,
    /// an older delta passed over, and a later gap that asks for the whole board.
    @Test func aRunOfDeltasGivesTheBoardThatApplyingEachInTurnGives() throws {
        func at(_ row: [String: Any], _ createdAt: Double) -> [String: Any] { var row = row; row["createdAt"] = createdAt; return row }
        let held = try board([
            task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "active", activity: "idle"),
            at(task("t-buoys", key: "INF-13", title: "Count the buoys", status: "open"), 1_793_000_000_200),
        ])
        let run = [
            try delta(base: 40, seq: 41, upserts: [], removed: ["t-chart"]),
            try delta(base: 41, seq: 42, upserts: [at(task("t-tide", key: "INF-14", title: "Read the tide table", status: "queued"), 1_793_000_000_100)],
                      removed: ["t-buoys"], added: [["fromId": "t-chart", "toId": "t-tide", "type": "blocks"]]),
            try delta(base: 42, seq: 43, upserts: [at(task("t-buoys", key: "INF-13", title: "Count the buoys", status: "active", activity: "running"), 1_793_000_000_200)],
                      removed: [], added: [["fromId": "t-buoys", "toId": "t-tide", "type": "blocks"]]),
            try delta(base: 43, seq: 44, upserts: [at(task("t-mast", key: "INF-15", title: "Step the mast", status: "queued"), 1_793_000_000_100)],
                      removed: ["t-tide"], unlinked: [["fromId": "t-chart", "toId": "t-tide", "type": "blocks"]]),
            try delta(base: 44, seq: 45, upserts: [task("t-chart", key: "INF-12", title: "Chart the northern entrance", status: "done")], removed: []),
        ]
        let stepped = try run.reduce(held) { board, next in try #require(board.applying(next)) }
        let folded = try #require(held.applying(run: run))
        #expect(folded.seq == stepped.seq)
        #expect(folded.tasks.map(\.id) == stepped.tasks.map(\.id))
        #expect(folded.tasks.map(\.status) == stepped.tasks.map(\.status))
        #expect(folded.links?.map { "\($0.fromId) \($0.toId)" } == stepped.links?.map { "\($0.fromId) \($0.toId)" })
        #expect(folded.tasks.map(\.id) == ["t-chart", "t-mast", "t-buoys"])
        #expect(held.applying(run: run + [try delta(base: 47, seq: 48, upserts: [], removed: [])]) == nil)
        #expect(held.applying(run: [try delta(base: 39, seq: 40, upserts: [], removed: ["t-chart"])])?.tasks.count == 2)
    }
}
