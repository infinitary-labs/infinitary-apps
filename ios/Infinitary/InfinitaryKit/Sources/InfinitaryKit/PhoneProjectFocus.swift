import Foundation

/// INF-2820 piece 2, the captain's approved plan: the phone's own project focus, picked from the Filter button, which
/// narrows Tasks, the tag row, Activity, the crew's light, Panels, messages and Home's cards to one project, as a Mac
/// window's focus does (docs/project-focus.md). A port of the desktop's src/shared/projectFocus.ts (`projectPillsOf`,
/// `pillShown`, `heldFocus`, `waitingElsewhere`, `holdsBack`) and src/panels/activity/feedRows.ts (`linesInFocus`), so
/// both read one rule.
public enum PhoneProjectFocus {
    /// One project the Filter sheet offers, and how many of its tasks wait on the captain and work.
    public struct Pill: Equatable, Sendable, Identifiable {
        public let id: String
        public let key: String
        public let name: String
        public let waiting: Int
        public let working: Int
    }

    /// The projects offered, and the totals All projects shows.
    public struct Pills: Equatable, Sendable {
        public let projects: [Pill]
        public let waiting: Int
        public let working: Int
        /// The Mac's `pillShown`: the Filter button shows only while there is a choice, two projects or more.
        public var shown: Bool { projects.count >= 2 }
    }

    /// The Mac's `projectPillsOf`: every project that is not archived, in the board's order, except Scratch (no
    /// repository) and the app's own workspace (a repository of kind `personal`), which get one only while each has a
    /// task Tasks lists, counting the Done rows a board read without its closed rows left out. Each task counts once, by
    /// its own state (`PhoneTask.group`, the Mac's `nowGroupOf`), not the Working tree Tasks draws it in.
    public static func pills(_ board: PhoneBoard) -> Pills {
        var counts: [String: (waiting: Int, working: Int, listed: Int)] = [:]
        var waiting = 0, working = 0
        for task in board.tasks {
            guard let group = task.group else { continue }
            var entry = counts[task.projectId] ?? (0, 0, 0)
            entry.listed += 1
            if group == .waiting { entry.waiting += 1; waiting += 1 }
            else if group == .working { entry.working += 1; working += 1 }
            counts[task.projectId] = entry
        }
        let projects = board.projects.filter { project in
            guard project.archived != true else { return false }
            if let repo = project.repo, repo.kind != "personal" { return true }
            return (counts[project.id]?.listed ?? 0) + (board.closedLeftOut?.done[project.id]?.count ?? 0) > 0
        }.map { project in
            Pill(id: project.id, key: project.key ?? "", name: project.name,
                 waiting: counts[project.id]?.waiting ?? 0, working: counts[project.id]?.working ?? 0)
        }
        return Pills(projects: projects, waiting: waiting, working: working)
    }

    /// The Mac's `heldFocus`: the saved project while it still has a pill and the pills show, otherwise All projects
    /// (nil), so a removed or archived project lets go without anyone writing it. Before the first board read the saved
    /// project holds, as the plan asks, so a relaunch opens on it.
    public static func held(_ saved: String?, board: PhoneBoard?) -> String? {
        guard let saved else { return nil }
        guard let board else { return saved }
        let pills = pills(board)
        return pills.shown && pills.projects.contains { $0.id == saved } ? saved : nil
    }

    /// The Mac's `waitingElsewhere`: tasks waiting on the captain in projects other than the focused one.
    public static func waitingElsewhere(_ pills: Pills, focus: String?) -> Int {
        guard let focus else { return 0 }
        return pills.waiting - (pills.projects.first { $0.id == focus }?.waiting ?? 0)
    }

    /// The Mac's `linesInFocus`: a line about another project's task leaves and a line about no task stays. A task's
    /// key starts with its project's key, which never changes, so the key says the project even for a task the board no
    /// longer lists. With no focus, or no key known before the board is read, every line stays.
    public static func lines(_ lines: [ActivityLine], key: String?) -> [ActivityLine] {
        guard let key, !key.isEmpty else { return lines }
        let prefix = key + "-"
        return lines.filter { line in line.taskKey.map { $0.hasPrefix(prefix) } ?? true }
    }

    /// The Mac's `holdsBack` (INF-2820 piece 3, the captain's "Held back until you pick their project or All projects"):
    /// the focus holds a card about another project's task off Home. A card about no task stays, and so does one whose
    /// task the board does not list; before the board is read nothing is held, so a board that cannot be read never hides
    /// a card behind a Filter that is not shown.
    public static func holdsBack(_ card: PhoneCard, focus: String?, board: PhoneBoard?) -> Bool {
        guard let focus, let task = card.taskID, let board else { return false }
        guard let project = board.tasks.first(where: { $0.id == task })?.projectId else { return false }
        return project != focus
    }

    /// The cards the captain pointed at, and the focus they were pointed under: a held card pointed at comes forward on
    /// Home without moving the focus, and stays only until the focus changes, as the Mac's `letThroughCardIds` do.
    public struct LetThrough: Equatable, Sendable {
        public private(set) var focus: String?
        public private(set) var cards: Set<String> = []
        public init() {}

        /// Lets `card` through under `focus`; a pick of another focus first lets go of the cards pointed at before.
        public mutating func point(at card: String, under focus: String?) {
            guard let focus else { return }
            if focus != self.focus { self.focus = focus; cards = [] }
            cards.insert(card)
        }

        /// Whether `card` was pointed at under `focus`, the one that holds now.
        public func lets(_ card: String, under focus: String?) -> Bool { focus != nil && focus == self.focus && cards.contains(card) }
    }

    /// Home's stack under the focus: `stack` with every card the focus holds back left out, short of those let through,
    /// in the stack's own order, so a card picked back returns to its place.
    public static func shown(_ stack: [PhoneCard], focus: String?, board: PhoneBoard?, letThrough: LetThrough) -> [PhoneCard] {
        guard focus != nil, board != nil else { return stack }
        return stack.filter { !holdsBack($0, focus: focus, board: board) || letThrough.lets($0.id, under: focus) }
    }

    /// The focused project's key, the Mac's `focusedKeyOf`: nil with no focus or before the board is read.
    public static func key(_ focus: String?, board: PhoneBoard?) -> String? {
        guard let focus else { return nil }
        return board?.projects.first { $0.id == focus }?.key
    }

    /// The captain's answer "Its own, saved on the phone for each computer": one focus per kept computer, by its pin,
    /// kept on the phone alone; nothing is written to the computer.
    public static func saved(computer pin: String, in defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: savedKey + pin)
    }

    public static func save(_ focus: String?, computer pin: String, in defaults: UserDefaults = .standard) {
        if let focus { defaults.set(focus, forKey: savedKey + pin) } else { defaults.removeObject(forKey: savedKey + pin) }
    }

    static let savedKey = "projectFocus."
}

extension ReadOnlySession {
    /// The project the phone is focused on now (`PhoneProjectFocus.held`), or nil for All projects.
    public var projectFocus: String? { PhoneProjectFocus.held(savedProjectFocus, board: board) }

    /// The projects the Filter sheet offers; none before the board is read.
    public var projectPills: PhoneProjectFocus.Pills {
        board.map(PhoneProjectFocus.pills) ?? PhoneProjectFocus.Pills(projects: [], waiting: 0, working: 0)
    }
}
