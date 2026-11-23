import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-3634: the captain's Approve and build of the fixed stars - every crewmate the Tasks list shows under Pinned leaves
/// its orbit for a place in the upper-left sky, lit by a glint - reaches the phone's scene from the same numbers as the
/// desktop. The desktop's own places and settled stages are recorded by scripts/generate-phone-scene.ts.
@MainActor final class PhoneFixedStarsTests: XCTestCase {
    private struct Readings: Decodable {
        struct Place: Decodable { let crew: Int; let count: Int; let orbits: [Orbit]; let points: [[Double]]; let joins: [[Int]] }
        struct Orbit: Decodable { let plane: Int; let radius: Double }
        struct Stage: Decodable { let crew: Int; let pinned: [String]; let stars: [String: [Double]]; let joins: [[String]] }
        let places: [Place]
        let stages: [Stage]
    }

    private func readings() throws -> Readings {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneFixedStars.generated", withExtension: "json"))
        return try JSONDecoder().decode(Readings.self, from: Data(contentsOf: url))
    }

    /// The board the phone reads: `crew` crewmates in creation order on one computer, `pinned` pinned in that order.
    private func board(crew: Int, pinned: [String], device: String? = nil, seq: Int = 1, waits: [String: String] = [:]) throws -> PhoneBoard {
        let tasks: [[String: Any]] = (1...crew).map { i in
            let id = "crew-\(i)"
            var task: [String: Any] = ["id": id, "key": id, "projectId": "p", "kind": "work", "title": id, "status": "active",
                                       "createdAt": Double(i), "blockedBy": [String](), "activity": "running"]
            if let at = pinned.firstIndex(of: id) { task["pinnedAt"] = Double(100 + at) }
            if let blocker = waits[id] {
                task["blockedBy"] = [blocker]; task["activity"] = "idle"
                task["workPosture"] = ["state": "idle", "reason": "dependency"]
            }
            if let device { task["executionDeviceId"] = device }
            return task
        }
        let json: [String: Any] = ["seq": seq, "tasks": tasks, "projects": [["id": "p", "name": "Infinitary"]], "links": [[String: Any]]()]
        return try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private let presence = #"[{"id":"studio","name":"Studio","inReach":true}]"#

    private func read(_ cache: PhoneSceneRoster.Cache, _ board: PhoneBoard) throws -> PhoneSceneRoster {
        let presence = try JSONDecoder().decode([PhoneComputerPresence].self, from: Data(self.presence.utf8))
        return cache.read(board: board, presence: presence, homeName: "Mac", inReach: true, generation: 1, revision: board.seq)
    }

    /// A point drawn on an orbit, back on that orbit's own circle: its angle and its radius.
    private static func polar(_ point: CGPoint, plane: Int) -> (angle: Double, radius: Double) {
        let p = CharacterCatalog.shared.planes[plane], incline = p.inclination * .pi / 180
        let u = point.x * cos(p.node) + point.y * sin(p.node), v = (-point.x * sin(p.node) + point.y * cos(p.node)) / cos(incline)
        return (atan2(v, u), hypot(u, v))
    }

    /// The crew still seated on each orbit sit evenly round it, at its size, with the stars' seats closed up.
    private func evenlySeated(_ frame: PhoneSceneMotion.Frame, computer: PhoneSceneRoster.Computer, stars: Set<String>, _ label: String) {
        let share = computer.share * PhoneSceneRoster.ringScale
        for plane in CharacterCatalog.shared.planes.indices {
            let seated = frame.glyphs.filter { computer.book.crew[$0.task.id]?.plane == plane && !stars.contains($0.task.id) }
            let places = seated.map { Self.polar(CGPoint(x: ($0.point.x - $0.center.x) / share, y: ($0.point.y - $0.center.y) / share), plane: plane) }
            for place in places {
                XCTAssertEqual(place.radius, PhoneSceneRoster.desktopRadius(plane, counts: computer.book.counts), accuracy: 1e-5, "\(label): orbit \(plane)'s size")
            }
            let angles = places.map(\.angle).sorted()
            for (i, angle) in angles.enumerated() {
                let next = angles[(i + 1) % angles.count] + (i == angles.count - 1 ? 2 * .pi : 0)
                XCTAssertEqual(next - angle, 2 * .pi / Double(angles.count), accuracy: 1e-6, "\(label): orbit \(plane)'s spacing")
            }
        }
    }

    /// The constellation's places over every crew size and star count the desktop recorded, and its hairline.
    func testPlacesMatchTheDesktop() throws {
        for reading in try readings().places {
            let label = "\(reading.count) stars over \(reading.crew) crew"
            let book = PhoneSceneRoster.SeatBook(crew: (1...reading.crew).map { "crew-\($0)" }, marks: [])
            let orbits = PhoneFixedStars.orbits(counts: book.counts)
            XCTAssertEqual(orbits.map(\.plane), reading.orbits.map(\.plane), label)
            for (orbit, desktop) in zip(orbits, reading.orbits) { XCTAssertEqual(orbit.radius, desktop.radius, accuracy: 1e-5, label) }
            let places = PhoneFixedStars.places(reading.count, orbits: orbits)
            XCTAssertEqual(places.points.count, reading.points.count, label)
            for (point, desktop) in zip(places.points, reading.points) {
                XCTAssertEqual(point.x, desktop[0], accuracy: 1e-4, label)
                XCTAssertEqual(point.y, desktop[1], accuracy: 1e-4, label)
            }
            XCTAssertEqual(places.joins.map { [$0.0, $0.1] }, reading.joins, label)
        }
    }

    /// A settled stage hangs each pinned crewmate where the desktop does, at the phone's scale, joins them as it does, and
    /// closes the gaps they leave on the orbits; another computer's group hangs its own constellation at its share.
    func testPinnedCrewLeaveTheirSeatsForTheDesktopsPlaces() throws {
        for stage in try readings().stages {
            for device in [nil, "studio"] as [String?] {
                let label = "\(stage.crew) crew, \(stage.pinned.count) pinned, on \(device ?? "home")"
                let roster = try read(PhoneSceneRoster.Cache(), board(crew: stage.crew, pinned: stage.pinned, device: device))
                let computer = try XCTUnwrap(roster.computers.first { $0.id == (device ?? "home") })
                XCTAssertEqual(computer.pinned, stage.pinned, label)
                let frame = PhoneSceneMotion().frame(roster: roster, now: 0, settled: true)
                let share = computer.share * PhoneSceneRoster.ringScale
                let byID = Dictionary(uniqueKeysWithValues: frame.glyphs.map { ($0.task.id, $0) })
                for (id, desktop) in stage.stars {
                    let star = try XCTUnwrap(byID[id], label)
                    XCTAssertEqual(star.star, 1, label)
                    XCTAssertEqual(star.twinkle, 0, "\(label): a settled frame holds the glint steady")
                    XCTAssertEqual((star.point.x - star.center.x) / share, desktop[0], accuracy: 1e-4, "\(label): \(id)")
                    XCTAssertEqual((star.point.y - star.center.y) / share, desktop[1], accuracy: 1e-4, "\(label): \(id)")
                    XCTAssertEqual(star.depth, CharacterCatalog.shared.fixedStars.depth, accuracy: 1e-9, label)
                }
                for glyph in frame.glyphs where !stage.pinned.contains(glyph.task.id) { XCTAssertEqual(glyph.star, 0, label) }
                XCTAssertEqual(frame.starJoins.map { [$0.from, $0.to] }, stage.joins, label)
                // A star keeps its orbit: the orbits keep their size, and the crew left on them close up.
                XCTAssertEqual(computer.book.counts.reduce(0, +), stage.crew, label)
                evenlySeated(frame, computer: computer, stars: Set(stage.pinned), label)
            }
        }
    }

    func testASettledFrameIsSteady() throws {
        let roster = try read(PhoneSceneRoster.Cache(), board(crew: 8, pinned: ["crew-4", "crew-7"]))
        let motion = PhoneSceneMotion()
        let first = motion.frame(roster: roster, now: 1, settled: true), later = motion.frame(roster: roster, now: 7.3, settled: true)
        let a = Dictionary(uniqueKeysWithValues: first.glyphs.map { ($0.task.id, $0) })
        for glyph in later.glyphs where glyph.star > 0 {
            let earlier = try XCTUnwrap(a[glyph.task.id])
            XCTAssertEqual(glyph.point, earlier.point)
            XCTAssertEqual(glyph.twinkle, 0); XCTAssertEqual(earlier.twinkle, 0)
        }
        XCTAssertEqual(later.glyphs.filter { $0.star == 1 }.count, 2)
    }

    /// A newly pinned crewmate eases out to its place over a second or so, twinkling as it hangs; a wait on it neither
    /// circles it nor makes it circle; it holds still through a warp while the rest ride; unpinned, it eases back to a
    /// seat and the orbit spaces evenly again.
    func testAPinEasesOutHoldsThroughAWarpAndAnUnpinReturns() throws {
        let cache = PhoneSceneRoster.Cache(), motion = PhoneSceneMotion()
        let waits = ["crew-2": "crew-4"]
        let plain = try read(cache, board(crew: 6, pinned: [], seq: 1, waits: waits))
        _ = motion.frame(roster: plain, now: 0, settled: true)
        XCTAssertNotNil(motion.frame(roster: plain, now: 0.016, settled: false).links.first)
        let pinned = try read(cache, board(crew: 6, pinned: ["crew-4"], seq: 2, waits: waits))
        let first = try XCTUnwrap(motion.frame(roster: pinned, now: 0.032, settled: false).glyphs.first { $0.task.id == "crew-4" })
        XCTAssertLessThan(first.star, 0.2, "it eases out, never jumps")
        var frame = motion.frame(roster: pinned, now: 0.048, settled: false)
        var now = 0.048
        while now < 3 { now += 1.0 / 60; frame = motion.frame(roster: pinned, now: now, settled: false) }
        let held = try XCTUnwrap(frame.glyphs.first { $0.task.id == "crew-4" })
        XCTAssertGreaterThan(held.star, 0.99)
        XCTAssertNotEqual(held.twinkle, 0, "a moving frame twinkles")
        let home = try XCTUnwrap(pinned.computers.first)
        let place = PhoneFixedStars.places(1, orbits: PhoneFixedStars.orbits(counts: home.book.counts)).points[0]
        XCTAssertEqual((held.point.x - held.center.x) / PhoneSceneRoster.ringScale, place.x, accuracy: 0.5)
        XCTAssertEqual((held.point.y - held.center.y) / PhoneSceneRoster.ringScale, place.y, accuracy: 0.5)
        // The wait on the star keeps its slot and its arrow: no circle round a star.
        let waiting = try XCTUnwrap(frame.glyphs.first { $0.task.id == "crew-2" })
        XCTAssertEqual(waiting.star, 0)
        let seat = try XCTUnwrap(waiting.orbit)
        let drawn = PhoneSceneRoster.projected(seat)
        XCTAssertEqual(waiting.point.x, waiting.center.x + drawn.point.x, accuracy: 0.5, "the waiting crewmate stays on its orbit")
        XCTAssertEqual(frame.links.count, 1)
        let seconds = CharacterCatalog.shared.fidgets[CharacterMachine.Fidget.tunnel.rawValue]! / 1000
        var moved = 0.0, drift = 0.0
        let rest = Dictionary(uniqueKeysWithValues: frame.glyphs.map { ($0.task.id, $0.point) })
        for step in 1...Int(seconds * 60 * 0.6) {
            let at = now + Double(step) / 60
            let pose = CharacterPose(mode: .fidget, progress: Double(step) / 60 / seconds, variant: .tunnel, milliseconds: at * 1000)
            let riding = motion.frame(roster: pinned, now: at, settled: false, warp: CharacterWarp.frame(pose, coreR: 280 * 0.27))
            for glyph in riding.glyphs {
                let before = try XCTUnwrap(rest[glyph.task.id])
                if glyph.task.id == "crew-4" {
                    drift = max(drift, hypot(glyph.point.x - before.x, glyph.point.y - before.y))
                    XCTAssertTrue(glyph.streak.isEmpty)
                } else { moved = max(moved, hypot(glyph.point.x - before.x, glyph.point.y - before.y)) }
            }
            if motion.warp != nil { XCTAssertEqual(motion.riders, 5, "the star rides no warp") }
            now = at
        }
        XCTAssertLessThan(drift, 0.5, "the star holds still through the warp")
        XCTAssertGreaterThan(moved, 20, "the rest ride the warp")
        let unpinned = try read(cache, board(crew: 6, pinned: [], seq: 3, waits: waits))
        let leaving = try XCTUnwrap(motion.frame(roster: unpinned, now: now + 1.0 / 60, settled: false).glyphs.first { $0.task.id == "crew-4" })
        XCTAssertGreaterThan(leaving.star, 0.5, "it eases back, never jumps")
        let back = motion.frame(roster: unpinned, now: now + 0.1, settled: true)
        XCTAssertTrue(back.glyphs.allSatisfy { $0.star == 0 })
        XCTAssertTrue(back.starJoins.isEmpty)
        evenlySeated(back, computer: try XCTUnwrap(unpinned.computers.first), stars: ["crew-2"], "unpinned")
    }

    /// The production painter draws the glint and the hairline: photographed for the change's review, not a pixel golden.
    func testThePainterDrawsTheConstellation() throws {
        let roster = try read(PhoneSceneRoster.Cache(), board(crew: 8, pinned: ["crew-3", "crew-6", "crew-1"]))
        let frame = PhoneSceneMotion().frame(roster: roster, now: 0, settled: true)
        XCTAssertEqual(frame.starJoins.count, 2)
        for scheme in [ColorScheme.dark, .light] {
            let paint = CharacterPainter.Cache()
            let renderer = ImageRenderer(content: Canvas { context, _ in
                PhoneCrewPainter.draw(frame, roster: roster, now: 0, still: true, in: &context, palette: paint.palette(context.environment))
            }.frame(width: roster.width, height: roster.height).background(PhoneTheme.background).environment(\.colorScheme, scheme))
            renderer.scale = 2
            let picture = XCTAttachment(image: try XCTUnwrap(renderer.uiImage))
            picture.name = "native-scene-fixed-stars-\(scheme == .dark ? "dark" : "light")"; picture.lifetime = .keepAlways; add(picture)
        }
    }
}
