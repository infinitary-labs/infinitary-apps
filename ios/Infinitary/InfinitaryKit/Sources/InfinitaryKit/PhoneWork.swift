import Foundation

public struct PhoneLastTurn: Decodable, Sendable {
    public let you: String
    public let reply: Reply?
    public struct Reply: Decodable, Sendable {
        public let text: String
        public let problem: Bool?
        /// INF-1517: `completed` lets the line fade after its reading time; anything else stays (docs/composer.md).
        public let eligibility: String?
        /// The closing words as written, line breaks kept, when they differ from `text`.
        public let words: String?
    }
}

public struct PhoneMove: Decodable, Sendable {
    public let ok: Bool
    public let text: String?
}

/// The Mac owns state, allowed moves and timeline wording. Unknown fields stay with the Mac.
public struct PhoneTask: Decodable, Identifiable, Sendable {
    public let id: String
    public let key: String
    public let projectId: String
    public let parentId: String?
    public let kind: String
    public let title: String
    public let status: String
    public let createdAt: Double
    public let startPolicy: String?
    public let startAttempt: StartAttempt?
    public let requiredAction: RequiredAction?
    public let activity: String?
    public let tier: String?
    public let executionDeviceId: String?
    public let reviewOf: String?
    public let program: Bool?
    public let workPosture: WorkPosture?
    public struct WorkPosture: Decodable, Sendable { public let state: String; public let reason: String }
    public let goal: String?
    public let startedAt: Double?
    public let moves: [String: PhoneMove]?
    public let outcomeSummary: String?
    public let waitingCardId: String?
    public let assignee: String?
    public let modelLabel: String?
    public let brief: String?
    public let outcome: String?
    public let problem: String?
    public let events: [Event]?
    public let intent: Intent?
    public let plan: Plan?
    public let place: Place?
    public let blockedBy: [String]
    /// INF-1517: a card of this task put aside on the Mac, set only by `PhoneBoard.presenting`, as the Mac's own
    /// `presentTask` (src/shared/taskWaiting.ts) sets it for presentation alone.
    public internal(set) var minimizedCardId: String?
    public var canSteer: Bool { status == "active" && startedAt != nil }
    public var group: PhoneTaskGroup? {
        .reading(status: status, work: kind == "work", required: requiredAction != nil,
                 waiting: waitingCardId != nil,
                 starting: startAttempt?.phase == "preparing" || startAttempt?.phase == "checking" || (status == "active" && activity == "starting"),
                 onRequest: startPolicy == "on-request", minimized: minimizedCardId != nil)
    }
    public struct StartAttempt: Decodable, Sendable { public let phase: String }
    public struct RequiredAction: Decodable, Sendable {}
    public var state: String {
        if waitingCardId != nil { return "Waiting on you" }
        if status == "done" { return "Done" }
        if status == "dropped" { return "Dropped" }
        if startAttempt?.phase == "preparing" || startAttempt?.phase == "checking" { return "Starting" }
        if !blockedBy.isEmpty { return "Waiting on another task" }
        if status == "open" { return startPolicy == "on-request" ? "Backlog" : "Queued" }
        switch activity {
        case "running": return "Working"
        case "starting": return "Starting"
        case "interrupted": return "Interrupted"
        case "idle": return "Idle"
        default: return "Not started"
        }
    }
    public struct Place: Decodable, Sendable { public let `where`: String; public let name: String? }
    public struct Intent: Decodable, Sendable { public let userWords: String }
    public struct Plan: Decodable, Sendable {
        public let items: [Item]
        public struct Item: Decodable, Sendable { public let label: String; public let state: String }
    }
    public struct Event: Decodable, Identifiable, Sendable {
        public let id: Int
        public let at: Double
        public let actor: String
        public let kind: String
        public let text: String
    }
}

public struct PhoneBoard: Decodable, Sendable {
    public let seq: Int
    public private(set) var tasks: [PhoneTask]
    public let projects: [Project]
    public let links: [Link]?
    public struct Link: Decodable, Sendable { public let fromId: String; public let toId: String; public let type: String }
    public struct Project: Decodable, Sendable { public let id: String; public let name: String }

    /// INF-1517: the Mac's `presentTask` rule (src/shared/taskWaiting.ts, docs/task-record.md "Minimized cards in
    /// Tasks") for a card put aside: its task lists under Waiting on you, unless the task is active and its author still
    /// works or owes the card an answer. Presentation only; the card stays minimized until a row brings it back.
    public func presenting(_ cards: [PhoneCard]) -> PhoneBoard {
        var board = self
        board.tasks = tasks.map { task in
            let associated = { (card: PhoneCard) in card.taskID == task.id || card.id == task.waitingCardId }
            let authorWorking = task.status == "active" && (task.workPosture?.state == "active"
                || (task.workPosture == nil && task.activity == "running")
                || cards.contains { associated($0) && $0.awaiting == "answer" })
            var shown = task
            shown.minimizedCardId = authorWorking ? nil : cards.first { $0.minimized && associated($0) }?.id
            return shown
        }
        return board
    }

    /// The cards put aside that belong to no task here, each listed as its own row titled by the card, as the Mac's
    /// `presentBoard` does; a card whose task the board does not hold gets none.
    public func tasklessMinimized(_ cards: [PhoneCard]) -> [PhoneCard] {
        cards.filter { card in
            card.minimized && card.taskID == nil && !tasks.contains { $0.minimizedCardId == card.id }
        }
    }

    /// The minimized cards a task's row brings back: every card of the task put aside, as the Mac's row does.
    public static func minimized(of task: PhoneTask, in cards: [PhoneCard]) -> [PhoneCard] {
        cards.filter { $0.minimized && ($0.taskID == task.id || $0.id == task.waitingCardId || $0.id == task.minimizedCardId) }
    }

    /// Keep an active parent and its parts together, as the Mac's Tasks panel does.
    public var groups: [String: PhoneTaskGroup] {
        let byID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        var working = Set<String>()
        for task in tasks where task.group == .working {
            var member: PhoneTask? = task
            var visited = Set<String>()
            while let next = member, visited.insert(next.id).inserted {
                working.insert(next.id)
                member = next.parentId.flatMap { byID[$0] }
            }
        }
        for task in tasks {
            var parent = task.parentId
            var visited = Set<String>()
            while let id = parent, visited.insert(id).inserted {
                if working.contains(id) { working.insert(task.id); break }
                parent = byID[id]?.parentId
            }
        }
        return Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            guard let group = task.group else { return nil }
            return (task.id, working.contains(task.id) && group != .waiting ? .working : group)
        })
    }
}

public struct PhoneCrew: Decodable, Sendable {
    public let taskId: String
    public let earlier: Int
    public let lines: [Line]
    public struct Line: Decodable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let text: String?
        public let title: String?
        public let summary: String?
        public let from: String?
        public let name: String?
        public let target: String?
        public let reading: String?
        public let result: Result?
        public var words: String {
            text ?? title ?? reading ?? (kind == "compacted" ? "The conversation was shortened to fit." : kind == "stopped" ? "The turn was interrupted." : kind)
        }
        public struct Result: Decodable, Sendable {
            public let ref: String
            public let preview: String
            public let lines: Int
        }
    }
}

public struct PhoneCrewLive: Decodable, Sendable {
    public let text: String
    public let since: Double?
}
public struct PhoneResultText: Decodable, Sendable {
    public let text: String
    public let cut: Int
}

public struct PhoneAnswer: Decodable, Sendable {
    public let ok: Bool
    public let text: String?
    public func accepted() throws {
        if !ok { throw PhoneError.refused(text ?? "Your computer could not make this change.") }
    }
}
