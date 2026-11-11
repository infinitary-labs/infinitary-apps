import Foundation

/// Fixed stars (INF-3634), as the desktop places them (src/renderer/src/character/crew/fixedStars.ts): a crewmate whose
/// task the Tasks list shows under Pinned leaves its orbit for a fixed place in the sky - a loose zigzag grown both ways
/// from the upper-left diagonal, then the lower right, the upper right and the lower left - joined by a hairline in pin
/// order within each corner. The numbers come from the desktop owner through PhoneSceneData.generated.json; the places
/// are in desktop scene pixels, which the scene draws at its ring scale.
enum PhoneFixedStars {
    /// One occupied orbit as the stars see it: its plane and the radius its idle crew sit at.
    struct Orbit: Equatable { let plane: Int; let radius: Double }
    /// The places for `count` stars in pin order, and index pairs of the neighbours joined within one corner.
    struct Places { var points: [CGPoint] = []; var joins: [(Int, Int)] = [] }

    static var tuning: CharacterCatalog.FixedStars { CharacterCatalog.shared.fixedStars }

    /// The occupied orbits of a computer's crew, as the desktop's orbit hands them to the stars: each orbit with crew,
    /// at its desktop radius lifted by the idle offset. A star keeps its orbit membership, so `counts` holds it too.
    static func orbits(counts: [Int]) -> [Orbit] {
        let lift = 1 + CharacterCatalog.shared.orbit["idleOffset"]!
        return counts.indices.filter { counts[$0] > 0 }.map { Orbit(plane: $0, radius: PhoneSceneRoster.desktopRadius($0, counts: counts) * lift) }
    }

    /// JavaScript's Math.round: halves go up, never away from zero.
    private static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    /// How far orbit `plane` of `radius` reaches from the center in screen direction `theta`.
    private static func reach(_ plane: Int, theta: Double, radius: Double) -> Double {
        let planes = CharacterCatalog.shared.planes
        guard planes.indices.contains(plane) else { return 0 }
        let p = planes[plane], d = theta - p.node, b = radius * cos(p.inclination * .pi / 180)
        return radius * b / hypot(b * cos(d), radius * sin(d))
    }

    /// The constellation's places for `count` stars over `orbits`, in desktop scene pixels from the first mate's
    /// center (screen axes, y down): the desktop's `skyPlaces`, step for step.
    static func places(_ count: Int, orbits: [Orbit]) -> Places {
        guard count > 0 else { return Places() }
        let t = tuning, deg = Double.pi / 180
        func inner(_ theta: Double) -> Double { orbits.reduce(0) { max($0, reach($1.plane, theta: theta, radius: $1.radius)) } + t.clearOfOrbitPx }
        func outer(_ theta: Double) -> Double { t.edgePx / max(abs(cos(theta)), abs(sin(theta))) }
        func room(_ d: Double) -> Double { outer(d * deg) - inner(d * deg) }
        // A place: a direction and a share of the room there; where the room runs out, it slides toward its corner's diagonal.
        func sky(_ start: Double, _ rho: Double) -> CGPoint {
            var d = start
            let diag = jsRound((d - 45) / 90) * 90 + 45
            var theta = d * deg, lo = inner(theta), hi = outer(theta)
            for _ in 0..<14 {
                theta = d * deg; lo = inner(theta); hi = outer(theta)
                if hi - lo >= 10 { break }
                d += (diag - d) * 0.25
            }
            let r = lo + rho * max(0, hi - lo)
            return CGPoint(x: cos(theta) * r, y: sin(theta) * r)
        }
        func span(_ c: Double, from: Double, to: Double) -> (Double, Double) {
            var lo = c, hi = c
            while lo - 2 >= from && room(lo - 2) >= t.roomPx { lo -= 2 }
            while hi + 2 <= to && room(hi + 2) >= t.roomPx { hi += 2 }
            return (lo, hi)
        }
        var spans: [(Double, Double)] = [], takes: [Int] = [], left = count
        for c in t.corners {
            let from = c == -45 && !spans.isEmpty ? min(c, max(c - t.reachDeg, spans[0].1 + 14)) : c - t.reachDeg
            let to = c == -135 ? -44 : c + t.reachDeg
            let s = span(c, from: from, to: to)
            spans.append(s)
            let take = min(left, Int(((s.1 - s.0) / 9).rounded(.down)) + 1)
            takes.append(take); left -= take
        }
        var x = 0
        while left > 0 { takes[x % 2] += 1; x += 1; left -= 1 }
        var result = Places()
        for (ci, c) in t.corners.enumerated() {
            let (lo, hi) = spans[ci], take = takes[ci]
            guard take > 0 else { continue }
            let step = min(t.stepDeg, (hi - lo) / Double(max(1, take - 1)))
            var offs: [Int] = [], l = 0, r = 0
            for j in 0..<take {
                let canR = c + Double(r + 1) * step <= hi + 0.01
                let canL = c - Double(l + 1) * step >= lo - 0.01
                if j == 0 { offs.append(0) } else if (j % 2 == 1 && canR) || !canL { r += 1; offs.append(r) } else { l += 1; offs.append(-l) }
            }
            let base = result.points.count, n = t.rho.count
            for o in offs {
                let i = ((o % n) + n) % n
                result.points.append(sky(c + Double(o) * step + t.jitter[i] * min(1, step / 8), t.rho[i]))
            }
            // The hairline runs across the corner, from one end of its arc to the other.
            let along = offs.indices.sorted { offs[$0] != offs[$1] ? offs[$0] < offs[$1] : $0 < $1 }
            for k in along.indices.dropFirst() { result.joins.append((base + along[k - 1], base + along[k])) }
        }
        return result
    }

    /// The glint's twinkle, -twinkle...twinkle, of a star with `seed` at `now` seconds; zero on a settled frame.
    static func twinkle(seed: Double, now: Double, settled: Bool) -> Double {
        settled ? 0 : tuning.twinkle * sin(now * tuning.twinkleRate + seed * 11)
    }
    /// A crewmate's own steady seed, 0..<1, from its task id: the desktop draws one at random when it spawns, and the
    /// phone has none, so this keeps each star's breath its own across launches.
    static func seed(_ id: String) -> Double {
        var hash: UInt32 = 2_166_136_261
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return Double(hash) / 4_294_967_296
    }
}
