import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-1755: the warp fidgets play on the phone as on the Mac (captain, INF-1750: "add all 3 actually"). Only the
/// crew circling the first mate ride along, crew on another computer stay in their own group (the captain's answer:
/// "Only the crew circling the first mate"), and every rider comes home to its own seat on its own orbit.
@MainActor final class PhoneWarpTests: XCTestCase {
    private func roster(home: Int, remote: Int) throws -> PhoneSceneRoster {
        func task(_ id: String, device: String?) -> [String: Any] {
            var task: [String: Any] = ["id": id, "key": id, "projectId": "p", "kind": "work", "title": id, "status": "active",
                                       "createdAt": 0.0, "blockedBy": [String](), "activity": "running"]
            if let device { task["executionDeviceId"] = device }
            return task
        }
        let tasks = (1...home).map { task("home-\($0)", device: nil) } + (1...remote).map { task("studio-\($0)", device: "studio") }
        let json: [String: Any] = ["seq": 1, "tasks": tasks, "projects": [["id": "p", "name": "Infinitary"]], "links": [[String: Any]]()]
        let board = try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
        let presence = try JSONDecoder().decode([PhoneComputerPresence].self, from: Data(#"[{"id":"studio","name":"Studio","inReach":true}]"#.utf8))
        return PhoneSceneRoster.Cache().read(board: board, presence: presence, homeName: "Mac", inReach: true, generation: 1, revision: 1)
    }

    func testEveryWarpTakesOnlyTheHomeCrewAndBringsEachHomeToItsSeat() throws {
        let roster = try roster(home: 8, remote: 3)
        let home = try XCTUnwrap(roster.computers.first { $0.id == "home" })
        for variant in [CharacterMachine.Fidget.tunnel, .sphere, .corkscrew] {
            let riding = PhoneSceneMotion(), still = PhoneSceneMotion()
            let seconds = CharacterCatalog.shared.fidgets[variant.rawValue]! / 1000
            var moved = 0.0, last: PhoneSceneMotion.Frame?
            for step in 0...Int((seconds + 1) * 60) {
                let now = Double(step) / 60
                var pose = CharacterPose(mode: .fidget, progress: min(1, now / seconds), variant: variant, milliseconds: now * 1000)
                if now >= seconds { pose.mode = .idle; pose.variant = nil }
                let a = riding.frame(roster: roster, now: now, settled: false, warp: CharacterWarp.frame(pose, coreR: 280 * 0.27))
                let b = still.frame(roster: roster, now: now, settled: false)
                let alone = Dictionary(uniqueKeysWithValues: b.glyphs.map { ($0.task.id, $0) })
                for glyph in a.glyphs {
                    let other = try XCTUnwrap(alone[glyph.task.id])
                    if glyph.task.id.hasPrefix("studio") {
                        // Crew on another computer keep their own group and pace.
                        XCTAssertEqual(glyph.point.x, other.point.x, accuracy: 0.000001, "\(variant) \(glyph.task.id) at \(now)")
                        XCTAssertEqual(glyph.point.y, other.point.y, accuracy: 0.000001, "\(variant) \(glyph.task.id) at \(now)")
                    } else { moved = max(moved, hypot(glyph.point.x - other.point.x, glyph.point.y - other.point.y)) }
                }
                last = a
            }
            XCTAssertGreaterThan(moved, 20, "\(variant): the home crew ride the warp")
            XCTAssertEqual(riding.warp == nil, true, "\(variant): the warp has ended")
            // Home again: each rider is back on its own orbit's circle, at its full size, with no trail.
            for glyph in try XCTUnwrap(last).glyphs where glyph.task.id.hasPrefix("home") {
                let seat = try XCTUnwrap(home.book.crew[glyph.task.id]), orbit = try XCTUnwrap(glyph.orbit)
                XCTAssertEqual(Int(orbit.plane.rounded()), seat.plane, "\(variant) \(glyph.task.id)'s orbit")
                let drawn = PhoneSceneRoster.projected(orbit)
                XCTAssertEqual(glyph.point.x, glyph.center.x + drawn.point.x, accuracy: 0.5, "\(variant) \(glyph.task.id)")
                XCTAssertEqual(glyph.point.y, glyph.center.y + drawn.point.y, accuracy: 0.5, "\(variant) \(glyph.task.id)")
                XCTAssertEqual(glyph.scale, 1)
                XCTAssertTrue(glyph.streak.isEmpty)
            }
        }
    }
}
