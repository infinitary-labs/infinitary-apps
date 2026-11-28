import XCTest
@testable import Infinitary
import InfinitaryKit

/// Grouping the crew animation by project (docs/crew-orbits.md, "Grouping by project"): the phone seats each crewmate
/// in the group the desktop's own rule picks (src/renderer/src/character/crew/crewGroups.ts), read for rosters across
/// the captain's answers on the middle ring and an away computer (scripts/generate-phone-scene.ts).
final class PhoneCrewGroupsTests: XCTestCase {
    func testThePhonesGroupsMatchTheDesktopsForEachRoster() throws {
        struct Project: Decodable { let id: String; let name: String; let builtIn: Bool }
        struct Member: Decodable { let id: String; let computer: String; let away: Bool; let project: String? }
        struct Group: Decodable { let id: String; let name: String }
        struct Plan: Decodable { let middle: String?; let groups: [Group] }
        struct Roster: Decodable {
            let name: String; let grouping: String; let focus: String?
            let crew: [Member]; let plan: Plan?; let groups: [String: String]?
        }
        struct Readings: Decodable { let projects: [Project]; let rosters: [Roster] }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneCrewGroups.generated", withExtension: "json"))
        let readings = try JSONDecoder().decode(Readings.self, from: Data(contentsOf: url))
        let projects = readings.projects.map { PhoneCrewGroups.Project(id: $0.id, name: $0.name, builtIn: $0.builtIn) }
        for roster in readings.rosters {
            let projectOf = Dictionary(uniqueKeysWithValues: roster.crew.compactMap { m in m.project.map { (m.id, $0) } })
            let crew = roster.crew.map { PhoneCrewGroups.Crew(id: $0.id, computer: $0.computer, away: $0.away) }
            let plan = PhoneCrewGroups.plan(grouping: roster.grouping, projects: projects, projectOf: { projectOf[$0] },
                                            focus: roster.focus, crew: crew)
            XCTAssertEqual(plan?.middle, roster.plan?.middle, roster.name)
            XCTAssertEqual(plan?.groups.map(\.id), roster.plan?.groups.map(\.id), roster.name)
            XCTAssertEqual(plan?.groups.map(\.name), roster.plan?.groups.map(\.name), roster.name)
            guard let plan, let groups = roster.groups else {
                XCTAssertNil(plan, roster.name); XCTAssertNil(roster.groups, roster.name); continue
            }
            for member in crew {
                XCTAssertEqual(PhoneCrewGroups.group(plan, projects: projects, projectOf: { projectOf[$0] }, member),
                               groups[member.id], "\(roster.name), \(member.id)")
            }
        }
    }

    /// docs/crew-orbits.md, "Grouping by project": a program draws once, where its live parts run, as the desktop's
    /// routePrograms. The phone's focus moves north-pier's live part from its project's group to the first mate's ring,
    /// and its program moves with it instead of keeping a copy in the group it left.
    @MainActor func testAProgramDrawsOnceWhereItsLivePartsRunWhenTheFocusMovesThem() throws {
        func task(_ id: String, _ project: String, parent: String? = nil, program: Bool = false) -> [String: Any] {
            var task: [String: Any] = ["id": id, "key": id, "projectId": project, "kind": "work", "title": id, "status": "active",
                                       "createdAt": 0.0, "blockedBy": [String](), "activity": "running"]
            if let parent { task["parentId"] = parent }
            if program { task["program"] = true }
            return task
        }
        let json: [String: Any] = [
            "seq": 1, "links": [[String: Any]](),
            "projects": [["id": "north", "name": "north-pier", "repo": ["name": "north-pier", "kind": "git"]],
                         ["id": "south", "name": "south-pier", "repo": ["name": "south-pier", "kind": "git"]]],
            "tasks": [task("survey", "north", program: true), task("north-part", "north", parent: "survey"), task("south-crew", "south")],
        ]
        let board = try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
        let cache = PhoneSceneRoster.Cache()
        func drawnAt(focus: String?) -> [String] {
            cache.read(board: board, presence: [], homeName: "Mac", inReach: true, generation: 1, revision: 1, grouping: "project", focus: focus)
                .computers.filter { $0.programs.contains { $0.id == "survey" } }.map(\.id)
        }
        XCTAssertEqual(drawnAt(focus: nil), ["project:north"], "Two projects' crew and no focus: north-pier keeps its own group")
        XCTAssertEqual(drawnAt(focus: "north"), ["home"], "Focused on north-pier, its program sits with the first mate alone")
        XCTAssertEqual(drawnAt(focus: nil), ["project:north"], "At All projects it goes back to north-pier's group alone")
    }

    /// docs/crew-orbits.md, "Grouping by project", as the desktop lists only the plan's groups: a program between stages
    /// keeps the group its parts last ran in, draws nothing while the focus makes that project the middle, and comes
    /// back to the group at All projects, never drawn alone in a group the plan does not have.
    @MainActor func testAProgramBetweenStagesDrawsNothingWhileItsGroupLeavesThePlan() throws {
        func task(_ id: String, _ project: String, parent: String? = nil, program: Bool = false) -> [String: Any] {
            var task: [String: Any] = ["id": id, "key": id, "projectId": project, "kind": "work", "title": id, "status": "active",
                                       "createdAt": 0.0, "blockedBy": [String](), "activity": "running"]
            if let parent { task["parentId"] = parent }
            if program { task["program"] = true }
            return task
        }
        func board(_ tasks: [[String: Any]], seq: Int) throws -> PhoneBoard {
            let json: [String: Any] = [
                "seq": seq, "links": [[String: Any]](), "tasks": tasks,
                "projects": [["id": "north", "name": "north-pier", "repo": ["name": "north-pier", "kind": "git"]],
                             ["id": "south", "name": "south-pier", "repo": ["name": "south-pier", "kind": "git"]]],
            ]
            return try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let cache = PhoneSceneRoster.Cache()
        let running = try board([task("survey", "north", program: true), task("north-part", "north", parent: "survey"),
                                 task("north-crew", "north"), task("south-crew", "south")], seq: 1)
        let between = try board([task("survey", "north", program: true), task("north-crew", "north"), task("south-crew", "south")], seq: 2)
        func read(_ board: PhoneBoard, revision: Int, focus: String?) -> (groups: [String], program: [String]) {
            let roster = cache.read(board: board, presence: [], homeName: "Mac", inReach: true, generation: 1, revision: revision,
                                    grouping: "project", focus: focus)
            return (roster.computers.map(\.id), roster.computers.filter { $0.programs.contains { $0.id == "survey" } }.map(\.id))
        }
        XCTAssertEqual(read(running, revision: 1, focus: nil).program, ["project:north"])
        XCTAssertEqual(read(between, revision: 2, focus: nil).program, ["project:north"], "Between stages it keeps north-pier's group")
        let focused = read(between, revision: 2, focus: "north")
        XCTAssertEqual(focused.groups, ["home", "project:south"], "Focused on north-pier, no group is left for north-pier alone")
        XCTAssertEqual(focused.program, [], "Its group left the plan, so the program draws nothing, as on the desktop")
        XCTAssertEqual(read(between, revision: 2, focus: nil).program, ["project:north"], "At All projects it is back in north-pier's group")
    }
}
