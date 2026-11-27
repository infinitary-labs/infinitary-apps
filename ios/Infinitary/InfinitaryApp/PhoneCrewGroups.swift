import InfinitaryKit

/// Grouping the crew animation by project (docs/crew-orbits.md, "Grouping by project"), while the computer's
/// Appearance groups it so: a port of the desktop's src/renderer/src/character/crew/crewGroups.ts (`groupPlanOf`,
/// `groupOf`), replayed against that rule's own readings in PhoneCrewGroupsTests.
///
/// - A crewmate whose computer is away (out of reach, or not known to be in reach) stays in that computer's frozen group.
/// - The built-in projects, Scratch and the app's own workspace, always sit with the first mate.
/// - So does the middle project: the only project of the person's own with crew, else the focused one, else none.
///   The phone has no project focus yet, so it passes none.
/// - Every other crewmate sits in its project's group.
/// - A crewmate whose project the board does not name yet keeps its computer's group.
enum PhoneCrewGroups {
    static let home = "home"
    /// A project group's id is this, then the project's id: never a computer's id.
    static let prefix = "project:"

    struct Project: Equatable { let id: String; let name: String; let builtIn: Bool }
    struct Crew: Equatable { let id: String; let computer: String; let away: Bool }
    struct Group: Equatable { let id: String; let name: String }
    struct Plan: Equatable {
        /// The project that orbits the first mate at full size, or none.
        let middle: String?
        /// The project groups that hold crew, in the board's order.
        let groups: [Group]
    }

    /// Scratch (no repository) or the app's own workspace (a `personal` repository), as the desktop's `builtInProject`.
    static func builtIn(_ project: PhoneBoard.Project) -> Bool { project.repo == nil || project.repo?.kind == "personal" }

    /// The plan for this roster, or nil for grouping by computer: the switch is off, or the board names no projects.
    static func plan(grouping: String, projects: [Project], projectOf: (String) -> String?, focus: String?, crew: [Crew]) -> Plan? {
        guard grouping == "project", !projects.isEmpty else { return nil }
        let byID = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var own = Set<String>()
        for member in crew where !member.away {
            if let project = byID[projectOf(member.id) ?? ""], !project.builtIn { own.insert(project.id) }
        }
        let focused = focus.flatMap { byID[$0] }
        let middle = own.count == 1 ? own.first : focused.flatMap { $0.builtIn ? nil : $0.id }
        return Plan(middle: middle, groups: projects.filter { own.contains($0.id) && $0.id != middle }
            .map { Group(id: prefix + $0.id, name: $0.name) })
    }

    /// The group a crewmate sits in under `plan`; a project the board does not name keeps its computer.
    static func group(_ plan: Plan, projects: [Project], projectOf: (String) -> String?, _ member: Crew) -> String {
        if member.away { return member.computer }
        guard let project = projects.first(where: { $0.id == projectOf(member.id) }) else { return member.computer }
        return project.builtIn || project.id == plan.middle ? home : prefix + project.id
    }

    /// Each active crewmate's group on this board, by task id, and the plan; nil groups everyone by computer.
    static func read(board: PhoneBoard?, tasks: [PhoneTask], presence: [PhoneComputerPresence], grouping: String)
        -> (plan: Plan, groups: [String: String])? {
        guard let board else { return nil }
        let projects = board.projects.map { Project(id: $0.id, name: $0.name, builtIn: builtIn($0)) }
        let projectOf = Dictionary(tasks.map { ($0.id, $0.projectId) }, uniquingKeysWith: { first, _ in first })
        let crew = tasks.map { task -> Crew in
            let computer = PhoneSceneRoster.computerID(task)
            return Crew(id: task.id, computer: computer,
                        away: computer != home && presence.first { $0.id == computer }?.inReach != true)
        }
        guard let plan = plan(grouping: grouping, projects: projects, projectOf: { projectOf[$0] }, focus: nil, crew: crew)
        else { return nil }
        return (plan, Dictionary(crew.map { ($0.id, group(plan, projects: projects, projectOf: { projectOf[$0] }, $0)) },
                                 uniquingKeysWith: { first, _ in first }))
    }
}
