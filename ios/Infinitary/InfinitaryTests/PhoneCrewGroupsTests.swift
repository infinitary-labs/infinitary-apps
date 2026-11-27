import XCTest
@testable import Infinitary

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
}
