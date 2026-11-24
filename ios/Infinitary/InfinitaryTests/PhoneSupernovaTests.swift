import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// The supernova fidget plays on the phone as on the Mac (the captain's ask: "one more fidget animation added to the
/// pool for the first mate character that's somewhat like a supernova explosion", approved reaching through the crew):
/// its curves, eyes, vertices and crew kick replay the desktop's own readings, only the crew circling the first mate
/// are kicked, and every one of them ends on its own seat.
@MainActor final class PhoneSupernovaTests: XCTestCase {
    private struct Reading: Decodable {
        let et, collapse, front, fade, flash, pulsar: Double
        let body, eyes: [Double]
        let rank: [Int]
        let points: [[Double]]
        let progress, scale, white: [Double]
        let trails: Int
        let kick: [Double]
    }

    func testTheSupernovaReplaysTheDesktopsReadings() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneSupernovaTraces.generated", withExtension: "json"))
        let readings = try JSONDecoder().decode([Reading].self, from: Data(contentsOf: url))
        XCTAssertFalse(readings.isEmpty)
        let c = 100.0, r = 27.0, close = 0.000001
        for reading in readings {
            let et = reading.et, label = "at \(et)"
            XCTAssertEqual(CharacterSupernova.collapse(et), reading.collapse, accuracy: close, label)
            XCTAssertEqual(CharacterSupernova.front(et), reading.front, accuracy: close, label)
            XCTAssertEqual(CharacterSupernova.fade(et), reading.fade, accuracy: close, label)
            XCTAssertEqual(CharacterSupernova.flash(et), reading.flash, accuracy: close, label)
            XCTAssertEqual(CharacterSupernova.pulsar(et), reading.pulsar, accuracy: close, label)
            let body = CharacterSupernova.body(et), eyes = CharacterSupernova.eyes(et)
            for (mine, theirs) in zip([body.squeeze, body.spin, body.glow], reading.body) { XCTAssertEqual(mine, theirs, accuracy: close, label) }
            for (mine, theirs) in zip([eyes.look.x, eyes.look.y, eyes.lid, eyes.wide, eyes.gather], reading.eyes) {
                XCTAssertEqual(mine, theirs, accuracy: close, label)
            }
            var trails = 0
            for i in 0..<16 {
                let base = CGPoint(x: c + cos(Double(i) * 0.4) * r, y: c + sin(Double(i) * 0.7) * r)
                let v = CharacterSupernova.vertex(i, rank: Double(reading.rank[i]), base: base, et: et, c: c, r: r, time: 3.5)
                XCTAssertEqual(v.point.x, reading.points[i][0], accuracy: close, "\(label) vertex \(i)")
                XCTAssertEqual(v.point.y, reading.points[i][1], accuracy: close, "\(label) vertex \(i)")
                XCTAssertEqual(v.progress, reading.progress[i], accuracy: close, "\(label) vertex \(i)")
                XCTAssertEqual(v.scale, reading.scale[i], accuracy: close, "\(label) vertex \(i)")
                XCTAssertEqual(v.white, reading.white[i], accuracy: close, "\(label) vertex \(i)")
                if v.trail != nil { trails += 1 }
            }
            XCTAssertEqual(trails, reading.trails, label)
            let frame = CharacterSupernova.Frame(et: et, t: 3.5, release: 1, coreR: 81, heat: 0)
            for (d, theirs) in zip([0.0, 60, 120, 180, 240], reading.kick) {
                XCTAssertEqual(CharacterSupernova.kick(d, frame), theirs, accuracy: close, "\(label) \(d) px out")
            }
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

    /// Plays one supernova to `endAt` seconds, or the whole of it, and then a second more, beside a scene with none.
    /// Returns how far the home crew were kicked and how far each lit up, and checks other computers' crew stay put.
    private func play(_ roster: PhoneSceneRoster, endAt: Double? = nil) throws -> (moved: Double, lit: Double, last: PhoneSceneMotion.Frame, motion: PhoneSceneMotion) {
        let bursting = PhoneSceneMotion(), still = PhoneSceneMotion()
        let seconds = CharacterCatalog.shared.fidgets["supernova"]! / 1000, end = endAt ?? seconds
        var moved = 0.0, lit = 0.0, last: PhoneSceneMotion.Frame?
        for step in 0...Int((end + 1) * 60) {
            let now = Double(step) / 60
            var pose = CharacterPose(mode: .fidget, progress: min(1, now / seconds), variant: .supernova, milliseconds: now * 1000)
            if now >= end { pose.mode = .idle; pose.variant = nil }
            let a = bursting.frame(roster: roster, now: now, settled: false, supernova: CharacterSupernova.frame(pose, coreR: 280 * 0.27))
            let b = still.frame(roster: roster, now: now, settled: false)
            let alone = Dictionary(uniqueKeysWithValues: b.glyphs.map { ($0.task.id, $0) })
            for glyph in a.glyphs {
                let other = try XCTUnwrap(alone[glyph.task.id])
                if glyph.task.id.hasPrefix("studio") {
                    XCTAssertEqual(glyph.point.x, other.point.x, accuracy: 0.000001, "\(glyph.task.id) at \(now)")
                    XCTAssertEqual(glyph.point.y, other.point.y, accuracy: 0.000001, "\(glyph.task.id) at \(now)")
                    XCTAssertEqual(glyph.flash, 0, "\(glyph.task.id) at \(now)")
                } else {
                    moved = max(moved, hypot(glyph.point.x - other.point.x, glyph.point.y - other.point.y))
                    lit = max(lit, glyph.flash)
                }
            }
            last = a
        }
        return (moved, lit, try XCTUnwrap(last), bursting)
    }

    private func assertSeated(_ frame: PhoneSceneMotion.Frame, _ roster: PhoneSceneRoster, _ label: String) throws {
        let home = try XCTUnwrap(roster.computers.first { $0.id == "home" })
        for glyph in frame.glyphs where glyph.task.id.hasPrefix("home") {
            let seat = try XCTUnwrap(home.book.crew[glyph.task.id]), orbit = try XCTUnwrap(glyph.orbit)
            XCTAssertEqual(Int(orbit.plane.rounded()), seat.plane, "\(label) \(glyph.task.id)'s orbit")
            let drawn = PhoneSceneRoster.projected(orbit)
            XCTAssertEqual(glyph.point.x, glyph.center.x + drawn.point.x, accuracy: 0.5, "\(label) \(glyph.task.id)")
            XCTAssertEqual(glyph.point.y, glyph.center.y + drawn.point.y, accuracy: 0.5, "\(label) \(glyph.task.id)")
            XCTAssertEqual(glyph.flash, 0, "\(label) \(glyph.task.id)")
        }
    }

    func testTheBlastKicksOnlyTheHomeCrewAndEachEndsOnItsSeat() throws {
        let roster = try roster(home: 8, remote: 3)
        let played = try play(roster)
        XCTAssertGreaterThan(played.moved, 10, "the front kicks the home crew outward")
        XCTAssertGreaterThan(played.lit, 0.5, "the flash lights the home crew")
        XCTAssertNil(played.motion.supernova, "the supernova has ended")
        try assertSeated(played.last, roster, "played whole")
    }

    func testASupernovaCutShortLetsTheCrewGoHome() throws {
        let roster = try roster(home: 8, remote: 3)
        let seconds = CharacterCatalog.shared.fidgets["supernova"]! / 1000
        // Cut while the front is still passing the crew.
        let played = try play(roster, endAt: seconds * 0.3)
        XCTAssertGreaterThan(played.moved, 5, "the front reached the crew before the cut")
        XCTAssertNil(played.motion.supernova, "the release has ended")
        try assertSeated(played.last, roster, "cut short")
    }
}
