import InfinitaryKit
import SwiftUI

/// A presentation of existing board facts. No title, prose or age decides whether someone is working.
struct PhoneSceneRoster {
    /// Keeps prepared geometry outside display callbacks and remembers only programs actually seen running.
    @MainActor final class Cache {
        private struct Key: Equatable {
            let revision: Int, generation: Int
            let presence: [PhoneComputerPresence]
            let homeName: String
            let inReach: Bool
        }
        private var key: Key?
        private var value: PhoneSceneRoster?
        private var retained: [String: Set<String>] = [:]
        func read(board: PhoneBoard?, presence: [PhoneComputerPresence], homeName: String, inReach: Bool, generation: Int, revision: Int) -> PhoneSceneRoster {
            let next = Key(revision: revision, generation: generation, presence: presence, homeName: homeName, inReach: inReach)
            if key == next, let value { return value }
            if key?.generation != generation { retained = [:] }
            let roots = Set((board?.tasks ?? []).filter { $0.program == true && ($0.status == "active" || $0.status == "open") }.map(\.id))
            retained = retained.filter { roots.contains($0.key) }
            for task in board?.tasks ?? [] where task.kind == "work" && task.status == "active" && task.program != true && task.reviewOf == nil {
                if let parent = task.parentId, roots.contains(parent) { retained[parent, default: []].insert(PhoneSceneRoster.computerID(task)) }
            }
            var roster = PhoneSceneRoster(board: board, presence: presence, homeName: homeName, inReach: inReach, generation: generation, retainedPrograms: retained)
            if let previous = value, key?.generation == generation {
                // Keep the panned extent while work departs; a removal must not clip its flight or move the viewport.
                let left = max(roster.homeX, previous.homeX), right = max(roster.width - roster.homeX, previous.width - previous.homeX)
                for index in roster.computers.indices { roster.computers[index].x += left - roster.homeX }
                roster.homeX = left; roster.width = left + right; roster.height = max(roster.height, previous.height)
            }
            key = next; value = roster
            return roster
        }
    }
    struct Computer: Identifiable {
        let id: String
        let name: String
        let reachable: Bool
        let tasks: [PhoneTask]
        let programs: [Program]
        let ordinary: [PhoneTask]
        let programParts: Set<String>
        let seats: [String]
        let rings: [Path]
        let radius: Double
        var x: Double = 0
        var width: Double { radius * 2 + 80 }
    }
    struct Program: Identifiable {
        let task: PhoneTask
        let parts: [PhoneTask]
        let parents: [String: [String]]
        let branches: [(id: String, distance: Double, angle: Double)]
        var id: String { task.id }
        init(_ task: PhoneTask, parts: [PhoneTask], links: [PhoneBoard.Link]) {
            self.task = task; self.parts = parts
            let live = Set(parts.map(\.id))
            let parents = Dictionary(grouping: links.filter { $0.type == "blocks" && live.contains($0.fromId) && live.contains($0.toId) }, by: \.toId).mapValues { $0.map(\.fromId) }
            self.parents = parents
            var memo: [String: Int] = [:]
            func layer(_ id: String, seen: Set<String> = []) -> Int {
                if let known = memo[id] { return known }
                if seen.contains(id) { return 1 }
                let value = 1 + (parents[id] ?? []).map { layer($0, seen: seen.union([id])) }.max(default: 0)
                memo[id] = value; return value
            }
            let tuning = CharacterCatalog.shared.program
            let levels = Dictionary(grouping: parts, by: { layer($0.id) })
            var placed: [(id: String, distance: Double, angle: Double)] = [], angles: [String: Double] = [:]
            var distance = 0.0
            let widest = tuning["widestSpreadDeg"]! * .pi / 180, gap = tuning["crewGapPx"]!
            for level in levels.keys.sorted() {
                distance += tuning["branchPx"]! * pow(tuning["branchDecay"]!, Double(level - 1))
                let siblings = levels[level]!, steps = siblings.count - 1
                if steps > 0 { distance = max(distance, gap / (2 * sin(widest / Double(steps) / 2))) }
                let spread = steps > 0 ? max(tuning["spreadDeg"]! * .pi / 180, Double(steps) * 2 * asin(min(1, gap / (2 * distance)))) : 0
                let rankings: [(part: PhoneTask, index: Int, angle: Double)] = siblings.enumerated().map { index, part in
                    let parentAngles: [Double] = (parents[part.id] ?? []).map { angles[$0] ?? 0 }
                    let totalAngle: Double = parentAngles.reduce(0.0, +)
                    let meanAngle: Double = parentAngles.isEmpty ? 0.0 : totalAngle / Double(parentAngles.count)
                    return (part: part, index: index, angle: meanAngle)
                }
                let ordered = rankings.sorted { $0.angle == $1.angle ? $0.index < $1.index : $0.angle < $1.angle }
                for (index, sibling) in ordered.enumerated() {
                    let angle = steps > 0 ? spread * (Double(index) / Double(steps) - 0.5) : 0
                    angles[sibling.part.id] = angle
                    placed.append((sibling.part.id, distance, angle))
                }
            }
            branches = placed
        }
    }
    let tasks: [PhoneTask]
    let order: [String: Int]
    let links: [PhoneBoard.Link]
    let allTasks: [PhoneTask]
    var computers: [Computer]
    var width: Double
    var height: Double
    var homeX: Double
    let generation: Int
    let sequence: Int
    let inReach: Bool

    init(board: PhoneBoard?, presence: [PhoneComputerPresence], homeName: String, inReach: Bool, generation: Int, retainedPrograms: [String: Set<String>] = [:]) {
        self.generation = generation; sequence = board?.seq ?? -1; self.inReach = inReach
        let all = board?.tasks ?? []
        allTasks = all; links = board?.links ?? []
        tasks = all.filter { $0.kind == "work" && $0.status == "active" && $0.program != true }
            .sorted { $0.createdAt == $1.createdAt ? $0.key < $1.key : $0.createdAt < $1.createdAt }
        order = Dictionary(uniqueKeysWithValues: tasks.enumerated().map { ($0.element.id, $0.offset) })
        let programs = all.filter { $0.program == true && ($0.status == "active" || $0.status == "open") }
        let grouped = Dictionary(grouping: tasks, by: Self.computerID)
        let ids = ["home"] + Set(grouped.keys).union(retainedPrograms.values.flatMap { $0 }).filter { $0 != "home" }.sorted()
        computers = ids.map { id in
            let members = grouped[id] ?? [], observed = presence.first { $0.id == id }
            let roots = programs.filter { program in members.contains { $0.parentId == program.id && $0.reviewOf == nil } || retainedPrograms[program.id]?.contains(id) == true }
                .map { root in Program(root, parts: members.filter { $0.parentId == root.id && $0.reviewOf == nil }, links: board?.links ?? []) }
            let ordinary = members.filter { task in task.reviewOf != nil || !roots.contains { $0.id == task.parentId } }
            let seats = ordinary.map(\.id) + roots.map(\.id)
            let count = seats.count
            let occupied = Self.seat(max(0, count - 1))
            // A program keeps room for its live branches; no unstarted, finished or remote placeholder dot is added.
            let programReach = roots.flatMap(\.branches).map(\.distance).max() ?? 0
            var seen = Set<Double>()
            let rings = seats.indices.compactMap { index -> Path? in
                let seat = Self.seat(index)
                guard seen.insert(seat.radius).inserted else { return nil }
                return CharacterSky.path(96) { t in Self.projected(seat, angle: t * 2 * .pi).point }
            }
            let radius = count == 0 ? 140 : occupied.radius + programReach
            return Computer(id: id, name: id == "home" ? homeName : observed?.name ?? all.first(where: { Self.computerID($0) == id })?.place?.name ?? "Computer",
                            reachable: inReach && (id == "home" || observed?.inReach == true), tasks: members, programs: roots, ordinary: ordinary, programParts: Set(roots.flatMap { $0.parts.map(\.id) }), seats: seats, rings: rings, radius: radius)
        }
        var left = -computers[0].width / 2, right = computers[0].width / 2
        for i in computers.indices where i > 0 {
            let half = computers[i].width / 2
            if i % 2 == 1 { computers[i].x = right + half; right += half * 2 }
            else { computers[i].x = left - half; left -= half * 2 }
        }
        width = right - left; homeX = -left
        for i in computers.indices { computers[i].x -= left }
        height = max(320, (computers.map(\.radius).max() ?? 140) * 2 + 64)
    }
    static func computerID(_ task: PhoneTask) -> String {
        if let id = task.executionDeviceId { return id }
        // An older home's named remote place is not this computer and its reach is unknown.
        if let place = task.place { return "legacy:" + (place.name ?? place.where) }
        return "home"
    }
    struct Seat { let plane: Int; let slot: Int; let capacity: Int; let radius: Double }
    static func seat(_ index: Int) -> Seat {
        let planes = CharacterCatalog.shared.planes
        var remaining = index
        for (i, plane) in planes.enumerated() {
            if remaining < plane.capacity { return Seat(plane: i, slot: remaining, capacity: plane.capacity, radius: plane.radius) }
            remaining -= plane.capacity
        }
        // Keep readable glyphs as a roster grows; extend the last plane instead of shrinking or hiding work.
        let last = planes.last!, spacing = last.radius - planes[planes.count - 2].radius
        return Seat(plane: planes.count - 1, slot: remaining % last.capacity, capacity: last.capacity,
                    radius: last.radius + Double(remaining / last.capacity + 1) * spacing)
    }
    static func projected(_ seat: Seat, angle: Double) -> (point: CGPoint, depth: Double) {
        let p = CharacterCatalog.shared.planes[seat.plane], incline = p.inclination * .pi / 180
        let u = seat.radius * cos(angle), v = seat.radius * sin(angle) * cos(incline)
        return (CGPoint(x: u * cos(p.node) - v * sin(p.node), y: u * sin(p.node) + v * cos(p.node)), (sin(angle) * sin(incline) + 1) / 2)
    }
    static func working(_ task: PhoneTask) -> Bool {
        if let posture = task.workPosture { return posture.state == "active" }
        return task.activity == "running" || task.activity == "starting"
    }
    static func unknown(_ task: PhoneTask, computer: Computer) -> Bool {
        !computer.reachable || task.workPosture?.state == "unknown"
    }
    static func words(_ task: PhoneTask, computer: Computer) -> String {
        if unknown(task, computer: computer) { return "Activity unknown" }
        if task.workPosture?.reason == "checks" { return "Waiting for checks" }
        return working(task) ? "Working" : task.state
    }
}

/// Native frame-only state. Board changes are settled once, never stored in the shell's display clock.
@MainActor final class PhoneSceneMotion {
    struct Glyph {
        var task: PhoneTask
        var point: CGPoint
        var center: CGPoint
        var depth = 0.5, spin = 0.0, alpha = 1.0, unfold = 1.0, work = 0.0, flicker = 0.0, nudge = 0.0
        var unknown = false, checks = false, programPart = false
        var size: Double { (programPart ? CharacterCatalog.shared.program["crewGapPx"]! : CharacterCatalog.shared.orbit["glyph"]!) * (0.84 + 0.32 * depth) }
    }
    struct Packet { let id: UUID; let taskID: String; let report: Bool; let started: Double }
    struct Mark: Identifiable {
        let task: PhoneTask; let computerID: String; let center: CGPoint; let point: CGPoint; let parts: [String]; let parents: [String: [String]]
        var id: String { computerID + ":" + task.id }
    }
    struct Frame { let glyphs: [Glyph]; let marks: [Mark]; let packets: [(CGPoint, Double)]; let links: [(CGPoint, CGPoint, Bool)] }
    private struct Member {
        var glyph: Glyph
        var arrived: Double
        let spawnDuration: Double
        var left: Double?
        var leaveFrom: CGPoint?
        var dropped = false
        var flickerAt = -Double.infinity, boost = 0.0, failedAt = -Double.infinity
    }
    private var members: [String: Member] = [:]
    private var generation: Int?
    private var rosterReady = false
    private var time = 0.0
    private var last: Double?
    private var computerTime: [String: Double] = [:]
    private var packets: [Packet] = []
    private var home: CGPoint?
    var current = Frame(glyphs: [], marks: [], packets: [], links: [])

    func receive(_ signal: PhoneSceneSignal) {
        guard var member = members[signal.taskID], !member.glyph.unknown, member.left == nil else { return }
        switch signal.kind {
        case .report, .steer: packets.append(Packet(id: UUID(), taskID: signal.taskID, report: signal.kind == .report, started: time))
        case .failed: member.failedAt = time
        case .usage:
            member.boost = max(CharacterFlicker.intensity(signal.tokens), member.boost * CharacterFlicker.envelope(time - member.flickerAt))
            member.flickerAt = time
        }
        members[signal.taskID] = member
    }
    func discardEffects() {
        packets = []
        for id in Array(members.keys) {
            if members[id]?.left != nil { members.removeValue(forKey: id); continue }
            members[id]?.arrived = -.infinity
            members[id]?.glyph.alpha = 1; members[id]?.glyph.unfold = 1
            members[id]?.boost = 0; members[id]?.failedAt = -.infinity
        }
    }

    func frame(roster: PhoneSceneRoster, now: Double, settled: Bool) -> Frame {
        let dt = min(0.05, max(0, now - (last ?? now))); last = now; time = now
        if generation != roster.generation { rosterReady = false }
        let initial = generation != roster.generation || !rosterReady
        if initial { members = [:]; packets = []; computerTime = [:]; generation = roster.generation; home = nil }
        let firstmate = CGPoint(x: roster.homeX, y: roster.height / 2)
        if let home {
            let shift = CGSize(width: firstmate.x - home.x, height: firstmate.y - home.y)
            if shift != .zero {
                for id in Array(members.keys) {
                    members[id]?.glyph.point.x += shift.width; members[id]?.glyph.point.y += shift.height
                    members[id]?.glyph.center.x += shift.width; members[id]?.glyph.center.y += shift.height
                    if let from = members[id]?.leaveFrom { members[id]?.leaveFrom = CGPoint(x: from.x + shift.width, y: from.y + shift.height) }
                }
            }
        }
        home = firstmate
        if roster.sequence >= 0 && roster.inReach { rosterReady = true }
        var target: [String: Glyph] = [:], marks: [Mark] = []
        for computer in roster.computers {
            if computer.reachable && !settled { computerTime[computer.id, default: 0] += dt }
            let localTime = computerTime[computer.id, default: 0], center = CGPoint(x: computer.x, y: roster.height / 2)
            let seats = computer.seats
            var positions: [String: (CGPoint, Double)] = [:]
            for (i, id) in seats.enumerated() {
                let seat = PhoneSceneRoster.seat(i), plane = CharacterCatalog.shared.planes[seat.plane]
                let used = max(1, min(seat.capacity, seats.count - (i - seat.slot)))
                let angle = Double(seat.slot) / Double(used) * 2 * .pi + plane.phase - localTime * .pi / 180 * plane.speedDegPerSec
                let projected = PhoneSceneRoster.projected(seat, angle: angle)
                positions[id] = (CGPoint(x: center.x + projected.point.x, y: center.y + projected.point.y), projected.depth)
            }
            for program in computer.programs {
                guard let root = positions[program.id]?.0 else { continue }
                for branch in program.branches {
                    let angle = atan2(root.y - center.y, root.x - center.x) + branch.angle
                    positions[branch.id] = (CGPoint(x: root.x + cos(angle) * branch.distance, y: root.y + sin(angle) * branch.distance), 0.65)
                }
                marks.append(Mark(task: program.task, computerID: computer.id, center: center, point: root,
                                  parts: program.parts.map(\.id), parents: program.parents))
            }
            for task in computer.tasks {
                guard let (point, depth) = positions[task.id] else { continue }
                let unknown = PhoneSceneRoster.unknown(task, computer: computer)
                target[task.id] = Glyph(task: task, point: point, center: center, depth: depth,
                    spin: localTime * (PhoneSceneRoster.working(task) ? 1.6 : 0.35), work: !unknown && PhoneSceneRoster.working(task) ? 1 : 0,
                    unknown: unknown, checks: !unknown && task.workPosture?.state == "active" && task.workPosture?.reason == "checks", programPart: computer.programParts.contains(task.id))
            }
        }
        let orbit = CharacterCatalog.shared.orbit
        for (id, glyph) in target {
            if members[id] == nil { members[id] = Member(glyph: glyph, arrived: initial || settled || glyph.unknown ? -.infinity : now, spawnDuration: Self.duration(orbit["spawnMs"]!, glyph: glyph, home: firstmate)) }
            guard var member = members[id] else { continue }
            member.left = nil; member.leaveFrom = nil
            var next = glyph
            if glyph.unknown && !initial {
                // Shift by the center's own move, so an unmoved computer leaves the frozen point exact.
                next.point = CGPoint(x: member.glyph.point.x + (glyph.center.x - member.glyph.center.x),
                                     y: member.glyph.point.y + (glyph.center.y - member.glyph.center.y))
                next.spin = member.glyph.spin
            } else if !initial && !settled { next.spin = member.glyph.spin + dt * (glyph.work > 0 ? 1.6 : 0.35) }
            let eased = initial || settled ? 1 : min(1, dt * 6)
            next.work = member.glyph.work + (glyph.work - member.glyph.work) * eased
            let arrive = settled || glyph.unknown ? 1 : clamp01((now - member.arrived) / member.spawnDuration)
            next.unfold = glyph.unknown ? member.glyph.unfold : arrive >= 1 ? 1 : clamp01((arrive - 0.55) / 0.45)
            if arrive < 1 {
                let arc = Self.travel(from: firstmate, to: glyph.point, at: easeInOut(arrive))
                next.point = arc; next.alpha = min(1, arrive * 4)
            } else if !initial && !settled && !glyph.unknown {
                next.point = CGPoint(x: member.glyph.point.x + (glyph.point.x - member.glyph.point.x) * eased,
                                     y: member.glyph.point.y + (glyph.point.y - member.glyph.point.y) * eased)
            }
            next.flicker = settled || glyph.unknown ? 0 : member.boost * CharacterFlicker.envelope(now - member.flickerAt)
            next.nudge = settled || glyph.unknown ? 0 : max(0, 1 - (now - member.failedAt) / 0.6)
            member.glyph = next; members[id] = member
        }
        for id in Array(members.keys) where target[id] == nil {
            guard var member = members[id] else { continue }
            if settled || initial { members.removeValue(forKey: id); continue }
            if member.left == nil { member.left = now; member.leaveFrom = member.glyph.point; member.dropped = roster.allTasks.first { $0.id == id }?.status == "dropped" }
            let duration = member.dropped ? orbit["awayMs"]! / 1000 : Self.duration(orbit["homeMs"]!, glyph: member.glyph, home: firstmate, from: member.leaveFrom)
            let progress = clamp01((now - member.left!) / duration)
            if progress >= 1 { members.removeValue(forKey: id); continue }
            member.glyph.alpha = 1 - progress; member.glyph.unfold = 1 - progress
            let from = member.leaveFrom ?? member.glyph.point
            let destination = member.dropped ? CGPoint(x: from.x, y: from.y - 30) : firstmate
            member.glyph.point = Self.travel(from: from, to: destination, at: easeInOut(progress))
            members[id] = member
        }
        if settled { discardEffects() }
        let glyphs = members.values.map(\.glyph).sorted { $0.depth < $1.depth }
        let byID = Dictionary(uniqueKeysWithValues: glyphs.map { ($0.task.id, $0) })
        let byKey = Dictionary(uniqueKeysWithValues: glyphs.map { ($0.task.key, $0) })
        var links: [(CGPoint, CGPoint, Bool)] = []
        for glyph in glyphs {
            if let review = glyph.task.reviewOf, let builder = byID[review] { links.append((glyph.point, builder.point, true)) }
            for key in glyph.task.blockedBy {
                if let blocker = byKey[key], blocker.task.reviewOf != glyph.task.id, glyph.task.reviewOf != blocker.task.id {
                    links.append((glyph.point, blocker.point, false))
                }
            }
        }
        for mark in marks {
            for id in mark.parts {
                guard let part = byID[id] else { continue }
                let parents = (mark.parents[id] ?? []).compactMap { byID[$0]?.point }
                for start in parents.isEmpty ? [mark.point] : parents { links.append((start, part.point, false)) }
            }
        }
        packets.removeAll { packet in
            guard let glyph = byID[packet.taskID] else { return true }
            return now - packet.started >= Self.duration(orbit["packetMs"]!, glyph: glyph, home: firstmate)
        }
        let flying = packets.compactMap { packet -> (CGPoint, Double)? in
            guard let glyph = byID[packet.taskID], !glyph.unknown else { return nil }
            let progress = clamp01((now - packet.started) / Self.duration(orbit["packetMs"]!, glyph: glyph, home: firstmate))
            return (Self.travel(from: packet.report ? glyph.point : firstmate, to: packet.report ? firstmate : glyph.point, at: easeInOut(progress)), sin(progress * .pi))
        }
        current = Frame(glyphs: glyphs, marks: marks, packets: flying, links: links)
        return current
    }
    private static func duration(_ base: Double, glyph: Glyph, home: CGPoint, from: CGPoint? = nil) -> Double {
        guard PhoneSceneRoster.computerID(glyph.task) != "home" else { return base / 1000 }
        let trip = CharacterCatalog.shared.remoteTrip, at = from ?? glyph.point
        let distance = hypot(at.x - home.x, at.y - home.y)
        let extra = (trip["acrossMs"]! - CharacterCatalog.shared.orbit["spawnMs"]!) * (distance - trip["homeDistancePx"]!) / (trip["acrossPx"]! - trip["homeDistancePx"]!)
        return (base + max(0, extra)) / 1000
    }
    static func travel(from a: CGPoint, to b: CGPoint, at t: Double) -> CGPoint {
        let dx = b.x - a.x, dy = b.y - a.y, q = 1 - t
        let first = CGPoint(x: a.x + (dx * cos(0.8) - dy * sin(0.8)) * 0.38, y: a.y + (dy * cos(0.8) + dx * sin(0.8)) * 0.38)
        let second = CGPoint(x: b.x - dx * 0.22 - dy * 0.1, y: b.y - dy * 0.22 + dx * 0.1)
        return CGPoint(x: q * q * q * a.x + 3 * q * q * t * first.x + 3 * q * t * t * second.x + t * t * t * b.x,
                       y: q * q * q * a.y + 3 * q * q * t * first.y + 3 * q * t * t * second.y + t * t * t * b.y)
    }
}

private extension Array where Element == Int { func max(default value: Int) -> Int { self.max() ?? value } }
