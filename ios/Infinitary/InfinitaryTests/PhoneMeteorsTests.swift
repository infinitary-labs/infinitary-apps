import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// The meteor fidgets play on the phone as on the Mac (the captain's ask: "a few variants of a meteor shower fidget
/// animation to the pool of first mate fidget animations. it should look visually pleasing and inspire a sense of awe";
/// the approved plan lights only the crew circling the first mate and moves none of them): the carriage, eyes, lights,
/// storm points and crew light replay the desktop's own readings, and the crew end as they were.
@MainActor final class PhoneMeteorsTests: XCTestCase {
    private struct Reading: Decodable {
        let variant: String
        let et: Double
        let rank: [Int]
        let home, body, eyes, watch: [Double]
        let lights: Int
        let lit: [Double]
        let flights: [[Double]]
        let progress, scale, fade, white: [Double]
        let glints: Int
    }

    func testTheMeteorsReplayTheDesktopsReadings() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneMeteorsTraces.generated", withExtension: "json"))
        let readings = try JSONDecoder().decode([Reading].self, from: Data(contentsOf: url))
        XCTAssertEqual(Set(readings.map(\.variant)), ["shower", "storm", "fireball"])
        let close = 0.000001
        let crew: [(Double, Double)] = [(0, 0), (110, -40), (-150, 60), (40, 180), (-90, -200), (220, 90)]
        for reading in readings {
            let variant = try XCTUnwrap(CharacterMachine.Fidget(rawValue: reading.variant)), et = reading.et
            let label = "\(reading.variant) at \(et)"
            let flights = variant == .storm ? CharacterMeteors.flights(et, rank: reading.rank, home: reading.home) : []
            XCTAssertEqual(flights.count, reading.flights.count, label)
            for (mine, theirs) in zip(flights, reading.flights) {
                for (a, b) in zip([Double(mine.i), mine.x, mine.y, mine.dn], theirs) { XCTAssertEqual(a, b, accuracy: close, label) }
            }
            let sky = CharacterMeteors.lights(variant, et, flights: flights)
            XCTAssertEqual(sky.lights.count, reading.lights, label)
            for (a, b) in zip([sky.watch.x, sky.watch.y, sky.watch.v], reading.watch) { XCTAssertEqual(a, b, accuracy: close, label) }
            for ((x, y), theirs) in zip(crew, reading.lit) {
                XCTAssertEqual(CharacterMeteors.lit(sky.lights, x, y), theirs, accuracy: close, "\(label) at \(x), \(y)")
            }
            let body = CharacterMeteors.body(variant, et)
            for (a, b) in zip([body.hush, body.spin, body.follow, body.wish], reading.body) { XCTAssertEqual(a, b, accuracy: close, label) }
            let landed = variant == .storm ? CharacterMeteors.landed(et, rank: reading.rank, home: reading.home) : nil
            let eyes = CharacterMeteors.eyes(variant, et, watch: sky.watch, landed: landed, r: 280 * 0.27)
            for (a, b) in zip([eyes.look.x, eyes.look.y, eyes.lid, eyes.wide, eyes.happy], reading.eyes) {
                XCTAssertEqual(a, b, accuracy: close, label)
            }
            guard variant == .storm else { continue }
            var glints = 0
            for i in 0..<16 {
                let v = CharacterMeteors.stormVertex(rank: reading.rank[i], et: et)
                XCTAssertEqual(v.progress, reading.progress[i], accuracy: close, "\(label) point \(i)")
                XCTAssertEqual(v.scale, reading.scale[i], accuracy: close, "\(label) point \(i)")
                XCTAssertEqual(v.fade, reading.fade[i], accuracy: close, "\(label) point \(i)")
                XCTAssertEqual(v.white, reading.white[i], accuracy: close, "\(label) point \(i)")
                if v.glint != nil { glints += 1 }
            }
            XCTAssertEqual(glints, reading.glints, label)
        }
    }

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

    /// Plays one meteor fidget to `endAt` seconds, or the whole of it, and then a second more, beside a scene with
    /// none. Returns how far any crewmate moved and how brightly the home crew lit, and checks other computers' crew
    /// stay dark.
    private func play(_ variant: CharacterMachine.Fidget, _ roster: PhoneSceneRoster, endAt: Double? = nil) throws
        -> (moved: Double, lit: Double, last: PhoneSceneMotion.Frame, still: PhoneSceneMotion.Frame, motion: PhoneSceneMotion) {
        let raining = PhoneSceneMotion(), still = PhoneSceneMotion()
        let seconds = CharacterCatalog.shared.fidgets[variant.rawValue]! / 1000, end = endAt ?? seconds
        let home = [Double](repeating: 20, count: 32)
        var moved = 0.0, lit = 0.0, last: PhoneSceneMotion.Frame?, alone: PhoneSceneMotion.Frame?
        for step in 0...Int((end + 1) * 60) {
            let now = Double(step) / 60
            var pose = CharacterPose(mode: .fidget, progress: min(1, now / seconds), variant: variant, milliseconds: now * 1000)
            if now >= end { pose.mode = .idle; pose.variant = nil }
            let a = raining.frame(roster: roster, now: now, settled: false, meteors: CharacterMeteors.frame(pose, coreR: 280 * 0.27, home: home))
            let b = still.frame(roster: roster, now: now, settled: false)
            let twin = Dictionary(uniqueKeysWithValues: b.glyphs.map { ($0.task.id, $0) })
            for glyph in a.glyphs {
                let other = try XCTUnwrap(twin[glyph.task.id])
                moved = max(moved, hypot(glyph.point.x - other.point.x, glyph.point.y - other.point.y))
                if glyph.task.id.hasPrefix("studio") { XCTAssertEqual(glyph.flash, other.flash, "\(glyph.task.id) at \(now)") }
                else { lit = max(lit, glyph.flash - other.flash) }
            }
            last = a; alone = b
        }
        return (moved, lit, try XCTUnwrap(last), try XCTUnwrap(alone), raining)
    }

    private func assertAsTwin(_ frame: PhoneSceneMotion.Frame, _ twin: PhoneSceneMotion.Frame, _ label: String) {
        let other = Dictionary(uniqueKeysWithValues: twin.glyphs.map { ($0.task.id, $0) })
        for glyph in frame.glyphs { XCTAssertEqual(glyph.flash, other[glyph.task.id]?.flash, "\(label) \(glyph.task.id)") }
    }

    func testTheMeteorsLightOnlyTheHomeCrewAndMoveNone() throws {
        let roster = try roster(home: 12, remote: 3)
        for variant in [CharacterMachine.Fidget.shower, .storm, .fireball] {
            let played = try play(variant, roster)
            XCTAssertEqual(played.moved, 0, accuracy: 0.000001, "\(variant) moves no crewmate")
            XCTAssertGreaterThan(played.lit, 0.3, "\(variant) lights the home crew it passes")
            XCTAssertNil(played.motion.meteors, "\(variant) has ended")
            assertAsTwin(played.last, played.still, "\(variant) played whole")
        }
    }

    func testAMeteorFidgetCutShortLetsItsLightGo() throws {
        let roster = try roster(home: 12, remote: 3)
        let seconds = CharacterCatalog.shared.fidgets["fireball"]! / 1000
        let played = try play(.fireball, roster, endAt: seconds * 0.4)
        XCTAssertNil(played.motion.meteors, "the release has ended")
        assertAsTwin(played.last, played.still, "cut short")
    }
}
