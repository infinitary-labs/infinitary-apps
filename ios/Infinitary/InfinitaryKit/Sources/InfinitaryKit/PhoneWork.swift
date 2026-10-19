import Foundation

public struct PhoneLastTurn: Decodable, Sendable {
    public let you: String
    public let reply: Reply?
    public struct Reply: Decodable, Sendable {
        public let text: String
        public let problem: Bool?
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
    public var canSteer: Bool { status == "active" && startedAt != nil }
    public var group: PhoneTaskGroup? {
        .reading(status: status, work: kind == "work", required: requiredAction != nil,
                 waiting: waitingCardId != nil,
                 starting: startAttempt?.phase == "preparing" || startAttempt?.phase == "checking" || (status == "active" && activity == "starting"),
                 onRequest: startPolicy == "on-request")
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
    public struct Place: Decodable, Sendable { public let `where`: String }
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
    public let tasks: [PhoneTask]
    public let projects: [Project]
    public struct Project: Decodable, Sendable { public let id: String; public let name: String }

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
