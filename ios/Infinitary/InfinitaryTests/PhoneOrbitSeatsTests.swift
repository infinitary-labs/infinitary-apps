import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-1325: the captain asked the phone's orbits to work as the desktop's updated ones do.
/// The desktop's own seat choices, recorded by scripts/generate-phone-scene.ts through arrivals and departures,
/// are replayed here through the phone's roster and scene, a read of the board per step.
@MainActor final class PhoneOrbitSeatsTests: XCTestCase {
    private struct Step: Decodable {
        let arrive: [String]?
        let leave: [String]?
        let program: Program?
        let crew: [String: [Double]]?
        let marks: [String: [Double]]?
        let outer: Double?
        struct Program: Decodable { let id: String; let parts: [String] }
    }

    private func sequences() throws -> [String: [Step]] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneOrbitSeats.generated", withExtension: "json"))
        return try JSONDecoder().decode([String: [Step]].self, from: Data(contentsOf: url))
    }

    /// The board the phone reads after each step: the crew in arrival order, on one computer, and the program while it runs.
    private func board(_ crew: [String], arrived: [String: Int], program: Step.Program?, device: String?, seq: Int) throws -> PhoneBoard {
        var tasks: [[String: Any]] = crew.map { id in
            var task: [String: Any] = ["id": id, "key": id, "projectId": "p", "kind": "work", "title": id, "status": "active",
                                       "createdAt": Double(arrived[id] ?? 0),
                                       "blockedBy": [String](), "activity": "running"]
            if let device { task["executionDeviceId"] = device }
            if let program, program.parts.contains(id) { task["parentId"] = program.id }
            return task
        }
        if let program {
            tasks.append(["id": program.id, "key": program.id, "projectId": "p", "kind": "work", "title": program.id, "status": "active",
                          "createdAt": 0.0, "blockedBy": [String](), "program": true])
        }
        let json: [String: Any] = ["seq": seq, "tasks": tasks, "projects": [["id": "p", "name": "Infinitary"]], "links": [[String: Any]]()]
        return try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// A point drawn on an orbit, back on that orbit's own circle: its angle and its radius.
    private static func polar(_ point: CGPoint, plane: Int) -> (angle: Double, radius: Double) {
        let p = CharacterCatalog.shared.planes[plane], incline = p.inclination * .pi / 180
        let u = point.x * cos(p.node) + point.y * sin(p.node), v = (-point.x * sin(p.node) + point.y * cos(p.node)) / cos(incline)
        return (atan2(v, u), hypot(u, v))
    }

    private func replay(_ name: String, device: String? = nil) throws {
        let steps = try XCTUnwrap(sequences()[name])
        let presence = try JSONDecoder().decode([PhoneComputerPresence].self, from: Data(#"[{"id":"studio","name":"Studio","inReach":true}]"#.utf8))
        // The phone draws the desktop's ring at its own scale, so the eight crewmates of the captain's ask fit an iPhone.
        let share = (device == nil ? 1 : CharacterCatalog.shared.ring["remoteShare"]!) * PhoneSceneRoster.ringScale
        let cache = PhoneSceneRoster.Cache(), motion = PhoneSceneMotion()
        _ = cache.read(board: try board([], arrived: [:], program: nil, device: device, seq: 0), presence: presence, homeName: "Mac", inReach: true, generation: 1, revision: 0)
        var present: [String] = [], arrived: [String: Int] = [:]
        for (index, step) in steps.enumerated() {
            present.removeAll { step.leave?.contains($0) == true }
            for id in step.arrive ?? [] { present.append(id); arrived[id] = arrived.count + 1 }
            let seq = index + 1
            let roster = cache.read(board: try board(present, arrived: arrived, program: step.program, device: device, seq: seq), presence: presence,
                                    homeName: "Mac", inReach: true, generation: 1, revision: seq)
            guard let crew = step.crew, !present.isEmpty else { continue }
            let computer = try XCTUnwrap(roster.computers.first { $0.id == (device ?? "home") })
            let frame = motion.frame(roster: roster, now: 0, settled: true)
            let label = "\(name) step \(index + 1)"
            XCTAssertEqual(Set(computer.book.crew.keys), Set(present), label)
            // Each crewmate is on the orbit the desktop chose for it.
            for (id, reading) in crew { XCTAssertEqual(computer.book.crew[id]?.plane, Int(reading[0]), "\(label): \(id)'s orbit") }
            let marks = frame.marks.filter { $0.computerID == computer.id }
            XCTAssertEqual(Set(marks.map(\.task.id)), Set((step.marks ?? [:]).keys), label)
            // Each orbit has the desktop's size, its crew and program rings evenly spaced around it. Which of several
            // equal gaps a newcomer takes rests on the last bit of the desktop's rounding, so the turn of the whole
            // orbit is not compared.
            for plane in CharacterCatalog.shared.planes.indices {
                let desktop = crew.values.filter { Int($0[0]) == plane }.map { CGPoint(x: $0[1], y: $0[2]) }
                guard let expected = desktop.first.map({ Self.polar($0, plane: plane).radius }) else { continue }
                let parts = Set(step.program?.parts ?? [])
                var points = frame.glyphs.filter { computer.book.crew[$0.task.id]?.plane == plane && !parts.contains($0.task.id) }
                    .map { CGPoint(x: ($0.point.x - $0.center.x) / share, y: ($0.point.y - $0.center.y) / share) }
                XCTAssertEqual(points.count, desktop.count, "\(label): crew on orbit \(plane)")
                if plane == 0 { points += marks.map { CGPoint(x: ($0.point.x - $0.center.x) / share, y: ($0.point.y - $0.center.y) / share) } }
                let places = points.map { Self.polar($0, plane: plane) }
                for place in places { XCTAssertEqual(place.radius, expected, accuracy: 1e-4, "\(label): orbit \(plane)'s size") }
                let seats = places.count + (plane == 0 ? parts.intersection(present).count : 0)
                let angles = places.map(\.angle).sorted()
                for (i, angle) in angles.enumerated().dropFirst() {
                    let gap = angle - angles[i - 1]
                    XCTAssertEqual((gap / (2 * .pi / Double(seats))).rounded() * (2 * .pi / Double(seats)), gap, accuracy: 1e-6, "\(label): orbit \(plane)'s spacing")
                    if seats == places.count { XCTAssertEqual(gap, 2 * .pi / Double(seats), accuracy: 1e-6, "\(label): orbit \(plane)'s spacing") }
                }
            }
            if computer.programs.isEmpty, !present.isEmpty {
                XCTAssertEqual(computer.radius, try XCTUnwrap(step.outer) * share, accuracy: 1e-4, "\(label): the area follows the first orbit")
            }
        }
    }

    /// Growth, two orbits and no third, refills from the second orbit, and a new start from empty.
    func testHomeSeatsMatchTheDesktop() throws { try replay("ring") }
    /// Another computer's group follows the same rule at the desktop's share of home's size.
    func testAnotherComputerSeatsAtItsShare() throws { try replay("ring", device: "studio") }
    /// A program's ring sits on the first orbit among the crew, and its parts keep their seats.
    func testProgramRingSitsOnTheFirstOrbit() throws { try replay("program") }

    /// The captain's ask: "by default 8 crewmates should all be visible on a portrait screen on ios". Through a whole
    /// turn of the first orbit, every one of eight crewmates stays inside the narrowest portrait iPhone around home.
    func testEightCrewmatesFitTheNarrowestPortraitIPhone() throws {
        let crew = (1...8).map { "crew-\($0)" }
        let arrived = Dictionary(uniqueKeysWithValues: crew.enumerated().map { ($1, $0 + 1) })
        let roster = PhoneSceneRoster(board: try board(crew, arrived: arrived, program: nil, device: nil, seq: 1), presence: [],
                                      homeName: "Mac", inReach: true, generation: 1)
        let motion = PhoneSceneMotion(), half = PhoneSceneRoster.narrowestPortraitWidth / 2
        let turn = 360 / abs(CharacterCatalog.shared.planes[0].speedDegPerSec)
        for step in 0...Int(turn * 4) {
            let frame = motion.frame(roster: roster, now: Double(step) / 4, settled: false)
            XCTAssertEqual(frame.glyphs.count, crew.count)
            for glyph in frame.glyphs {
                XCTAssertLessThanOrEqual(abs(glyph.point.x - roster.homeX) + glyph.size / 2, half, "\(glyph.task.id) at \(Double(step) / 4) s")
            }
        }
    }
}
