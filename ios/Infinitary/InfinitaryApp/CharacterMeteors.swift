import SwiftUI

/// The meteor fidgets of character/meteors.ts and crew/meteors.ts on the Mac: a sky of stars comes out round the first
/// mate and meteors cross it. The shower runs from one point of the sky and its brightest meteor ends in a wish; the
/// storm's streaks fall in three depths while the frame fades where it stands and its points rain home; the fireball
/// crosses slowly, flaring and throwing pieces, and the first mate turns to follow it. A meteor passing a crewmate
/// circling the first mate lights it. No outline, ring or filled edge anywhere. The settings, the schedule and every
/// meteor, piece, star and grain of dust come generated from the desktop owner; the shapes are ported here.
enum CharacterMeteors {
    struct Data: Decodable, Sendable {
        struct Shower: Decodable, Sendable { let durationMs, meteors, trail: Double; let wish: Bool }
        struct Storm: Decodable, Sendable { let durationMs, meteors, trail: Double }
        struct Fireball: Decodable, Sendable { let durationMs, fragments, trail: Double }
        struct Path: Decodable, Sendable { let x0, y0, len, ux, uy: Double }
        let shower: Shower, storm: Storm, fireball: Fireball
        let stars, crewLight, reachPx, releaseMs: Double
        let schedule: [String: Double]
        /// Where along the fireball's crossing it flares, and how hard.
        let flares: [[Double]]
        let stormDir: [Double]
        /// The fireball's path, from its start, px.
        let path: Path
        /// Each meteor: start x, y, heading x, y, length, start, life (s), life as a share of the fidget, magnitude,
        /// width, flare, linger (s), and near (1) for the storm's nearest streaks.
        let showerMeteors, stormMeteors, heralds: [[Double]]
        /// Each piece: share of the crossing, speed share, drag, side drift, life (s), width, alpha, turn (rad).
        let fragments, burst: [[Double]]
        /// Each star: x, y, brightness.
        let skyStars: [[Double]]
        /// Each grain of the fireball's wake: drift, whiteness, brightness and size.
        let dust: [[Double]]
    }
    static var data: Data { CharacterCatalog.shared.meteors }
    typealias RGB = CharacterPainter.RGB
    typealias Variant = CharacterMachine.Fidget
    private static func at(_ key: String) -> Double { data.schedule[key]! }
    private static var reach: Double { data.reachPx }
    /// The storm's points start this far up the stream, beyond the sky's edge.
    private static var landFar: Double { data.reachPx * 1.2 }
    /// The first mate's radius at its own 280-point size: the storm points' home is kept at that size.
    static let homeR = 280 * 0.27

    static func isMeteor(_ v: Variant?) -> Bool { v == .shower || v == .storm || v == .fireball }
    static func seconds(_ v: Variant) -> Double {
        (v == .shower ? data.shower.durationMs : v == .storm ? data.storm.durationMs : data.fireball.durationMs) / 1000
    }
    private static func trail(_ v: Variant) -> Double {
        v == .shower ? data.shower.trail : v == .storm ? data.storm.trail : data.fireball.trail
    }

    struct Meteor: Sendable {
        let x0, y0, ux, uy, L, t0, life, lifeF, mag, w, flare, linger: Double
        let near: Bool
        init(_ v: [Double]) {
            (x0, y0, ux, uy, L, t0, life, lifeF) = (v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7])
            (mag, w, flare, linger, near) = (v[8], v[9], v[10], v[11], v[12] > 0)
        }
    }
    struct Fragment: Sendable {
        let u, v, drag, side, life, w, a, turn: Double
        init(_ x: [Double]) { (u, v, drag, side, life, w, a, turn) = (x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7]) }
    }
    private static let showerMeteors = data.showerMeteors.map(Meteor.init)
    private static let stormMeteors = data.stormMeteors.map(Meteor.init)
    private static let heralds = data.heralds.map(Meteor.init)
    private static let pieces = (data.fragments + data.burst).map(Fragment.init)

    // MARK: the curves

    /// The hush: 0 at rest, 1 while the sky is out.
    static func hush(_ et: Double) -> Double { band(et, at("skyIn"), at("skyInFor"), at("skyOut"), at("skyOutFor")) }
    /// The sky fades with no edge toward its reach.
    static func edge(_ x: Double, _ y: Double) -> Double { 1 - easeInOut(clamp01((hypot(x, y) / reach - 0.72) / 0.28)) }

    /// Where a meteor is this frame: its head, its light and its progress, or nil before it starts.
    static func place(_ m: Meteor, _ et: Double, _ secs: Double) -> (x: Double, y: Double, lum: Double, u: Double, life: Double)? {
        let life = m.lifeF > 0 ? m.lifeF * secs : m.life
        let u = (et - m.t0) * secs / life
        guard u > 0 else { return nil }
        let d = u < 1 ? m.L * u * (1.12 - 0.12 * u) : m.L
        let lum = u < 1
            ? clamp01(u / 0.1) * (0.8 + 0.2 * sin(u * .pi)) * (1 - clamp01((u - 0.88) / 0.12)) + m.flare * pulse(u, 0.66, 0.3)
            : 0
        return (m.x0 + m.ux * d, m.y0 + m.uy * d, lum, u, life)
    }

    /// How far along its path the fireball's head is at crossing progress `u`: a touch slower at the end.
    static func run(_ u: Double) -> Double { data.path.len * u * (1.1 - 0.1 * u) }
    static func flare(_ u: Double) -> Double { data.flares.reduce(0) { $0 + $1[1] * pulse(u, $1[0] - 0.035, 0.09) } }
    static func lum(_ u: Double) -> Double {
        u <= 0 || u >= 1 ? 0 : clamp01(u / 0.07) * (0.94 + 0.8 * flare(u)) * (1 - clamp01((u - 0.9) / 0.1))
    }
    static func cross(_ et: Double) -> Double { (et - at("crossAt")) / at("crossFor") }

    /// When the storm's point of winding rank `rank` starts home, and how far it has come.
    static func landing(_ rank: Int, _ et: Double) -> (tl: Double, dn: Double) {
        let tl = at("landAt") + Double(rank) / 15 * at("landSpread")
        return (tl, (et - tl) / at("landFor"))
    }

    /// A storm point raining home: which, where (px from the center) and how far it has come.
    struct Flight { var i: Int; var x, y, dn: Double }
    /// The storm's points still falling home, from where each lands (`home`: x, y pairs from the center, px): fast,
    /// then braking onto its place.
    static func flights(_ et: Double, rank: [Int], home: [Double]) -> [Flight] {
        var out: [Flight] = []
        for i in 0..<16 {
            let dn = landing(rank[i], et).dn
            guard dn > 0, dn < 1 else { continue }
            let gone = pow(1 - dn, 1.6)
            out.append(Flight(i: i, x: home[2 * i] - data.stormDir[0] * landFar * gone, y: home[2 * i + 1] - data.stormDir[1] * landFar * gone, dn: dn))
        }
        return out
    }

    /// A light a meteor casts this frame: where, how strong, and how far it reaches, px.
    struct Light { var x = 0.0, y = 0.0, v = 0.0, r = 0.0 }
    /// What the meteors light this frame, and the brightest for the eyes to follow; the first mate and the crew read
    /// the same lights.
    static func lights(_ variant: Variant, _ et: Double, flights: [Flight] = []) -> (lights: [Light], watch: Light) {
        var lights: [Light] = [], watch = Light()
        func light(_ x: Double, _ y: Double, _ v: Double, _ r: Double) {
            if v > 0.05 { lights.append(Light(x: x, y: y, v: v, r: r)) }
            if v > watch.v { watch = Light(x: x, y: y, v: v, r: r) }
        }
        let secs = seconds(variant)
        if variant == .fireball {
            let u = cross(et), p = data.path
            if u > 0 && u < 1 {
                let x = p.x0 + p.ux * run(u), y = p.y0 + p.uy * run(u)
                light(x, y, min(1.6, lum(u)) * edge(x, y), 230)
            }
            return (lights, watch)
        }
        for m in variant == .shower ? showerMeteors : stormMeteors where m.mag > 0.8 {
            guard let here = place(m, et, secs), here.u < 1 else { continue }
            light(here.x, here.y, min(1.4, m.mag * here.lum * edge(here.x, here.y)) * (m.lifeF > 0 ? 1 : 0.5), m.lifeF > 0 ? 150 : 46)
        }
        for f in flights { light(f.x, f.y, 0.6 * edge(f.x, f.y), 60) }
        return (lights, watch)
    }
    /// How much the lights light a point, 0 and up.
    static func lit(_ lights: [Light], _ x: Double, _ y: Double) -> Double {
        lights.reduce(0) { max($0, $1.v * pow(clamp01(1 - hypot(x - $1.x, y - $1.y) / $1.r), 2)) }
    }

    // MARK: the first mate

    /// The carriage: the hush slows its turn; the fireball turns the frame to follow the crossing (back to 0 by the
    /// end); the shower's wish is one small bow.
    struct Body { var hush = 0.0, spin = 1.0, follow = 0.0, wish = 0.0 }
    static func body(_ variant: Variant, _ et: Double) -> Body {
        let hush = Self.hush(et), u = clamp01(cross(et))
        return Body(hush: hush, spin: 1 - 0.44 * hush,
                    follow: variant == .fireball ? (2 * easeInOut(u) - 1) * band(et, at("crossAt") - 0.08, 0.1, 0.74, 0.16) : 0,
                    wish: variant == .shower && data.shower.wish ? pulse(et, at("wishAt"), at("wishFor")) : 0)
    }
    static func body(of pose: CharacterPose) -> Body? {
        guard pose.mode == .fidget, let v = pose.variant, isMeteor(v) else { return nil }
        return body(v, pose.progress)
    }

    /// The eyes: up at the sky, then on the brightest meteor, on each storm point as it lands, after the fireball as
    /// it goes, shut in happy arcs for the wish, and home with a blink before the end. `landed` is px from the center.
    struct Eyes { var look = (x: 0.0, y: 0.0), lid = 0.0, wide = 1.0, happy = 0.0 }
    static func eyes(_ variant: Variant, _ et: Double, watch: Light, landed: (x: Double, y: Double)?, r: Double) -> Eyes {
        let hush = Self.hush(et), dir = data.stormDir
        let up = variant == .storm ? (-dir[0] * 0.95, -dir[1] * 0.9) : variant == .shower ? (0.55, -0.72) : (-0.7, -0.5)
        func clamp(_ v: Double) -> Double { max(-1, min(1, v)) }
        var eyes = Eyes(look: (up.0 * clamp01(et / 0.08), up.1 * clamp01(et / 0.08)), wide: 1 + 0.14 * hush)
        if watch.v > 0.45 {
            eyes.look = (clamp(watch.x / (reach * 0.62)), clamp(watch.y / (reach * 0.62)))
            eyes.wide += 0.16 * clamp01(watch.v)
        }
        if variant == .storm, let landed, et > at("landAt") { eyes.look = (clamp(landed.x / r), clamp(landed.y / r)) }
        if variant == .fireball && cross(et) >= 1 && et < 0.78 { eyes.look = (0.75, 0.22) }
        let wish = body(variant, et).wish
        eyes.happy = wish > 0 ? clamp01(wish * 3) : 0
        if wish > 0 { eyes.look = (0, 0.3) }
        if et > 0.9 { eyes.look = (0, 0) }
        eyes.lid = pulse(et, at("blinkAt"), 0.05)
        return eyes
    }
    /// The eyes as the pose plays them, from the storm's points where they were last drawn (`home`, at 280 points).
    static func eyes(of pose: CharacterPose, home: [Double]) -> Eyes? {
        guard pose.mode == .fidget, let v = pose.variant, isMeteor(v) else { return nil }
        let et = pose.progress, rank = CharacterSky.windingRank
        let sky = lights(v, et, flights: v == .storm ? flights(et, rank: rank, home: home) : [])
        return eyes(v, et, watch: sky.watch, landed: v == .storm ? landed(et, rank: rank, home: home) : nil, r: homeR)
    }

    /// The last storm point to land, within a moment of its landing, px from the center, or nil.
    static func landed(_ et: Double, rank: [Int], home: [Double]) -> (x: Double, y: Double)? {
        var landed: (x: Double, y: Double)?, landedAt = -1.0
        for i in 0..<16 {
            let (tl, dn) = landing(rank[i], et)
            if dn >= 1 && et < tl + 0.12 && tl > landedAt { landedAt = tl; landed = (home[2 * i], home[2 * i + 1]) }
        }
        return landed
    }

    /// One storm point this frame: how far it has left the frame (a wire fades by the farther of its two ends, so it
    /// knits again only once both are home), its dot's size, white and fade, and its landing glint's age, 0..1.
    struct Vertex { var progress = 0.0, scale = 1.0, white = 0.0, fade = 1.0; var glint: Double? }
    static func stormVertex(rank: Int, et: Double) -> Vertex {
        let (tl, dn) = landing(rank, et)
        var v = Vertex()
        if dn <= 0 {
            let gone = easeInOut(clamp01((et - at("fadeAt")) / at("fadeFor")))
            v.progress = gone; v.fade = 1 - gone
        } else if dn < 1 {
            v.progress = 1; v.fade = 0
        } else {
            let q = (et - tl - at("landFor")) / 0.05, glow = 1 - clamp01(q)
            v.progress = 1 - clamp01(q / 0.8)
            v.scale = 1 + 0.5 * glow; v.white = glow; v.fade = max(glow, 1 - v.progress)
            if q < 1 { v.glint = q }
        }
        return v
    }

    // MARK: drawing

    private struct Ink {
        let wire, bg: RGB
        let boost: Double
        func blaze(_ k: Double) -> RGB { CharacterSupernova.blaze(wire, background: bg, k) }
    }
    private static func circle(_ p: CGPoint, _ r: Double) -> Path { Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)) }

    /// A tapered streak with no outline, bright at its head and gone at its tail.
    private static func streak(_ ink: Ink, _ tip: CGPoint, _ ux: Double, _ uy: Double, _ len: Double, _ w: Double, _ a: Double, _ k: Double,
                               in pen: inout ScenePen) {
        guard a >= 0.012, len >= 0.8 else { return }
        let tail = CGPoint(x: tip.x - ux * len, y: tip.y - uy * len), nx = -uy * w * 0.5, ny = ux * w * 0.5
        let shape = Path { p in
            p.move(to: CGPoint(x: tip.x + nx, y: tip.y + ny)); p.addLine(to: tail)
            p.addLine(to: CGPoint(x: tip.x - nx, y: tip.y - ny)); p.closeSubpath()
        }
        pen.fill(shape, with: .linearGradient(PenGradient(stops: [
            .init(color: ink.blaze(k).color(min(1, a)), location: 0), .init(color: ink.blaze(k * 0.45).color(min(1, a * 0.58)), location: 0.3),
            .init(color: ink.wire.color(0), location: 1),
        ]), startPoint: tip, endPoint: tail))
    }
    /// A four-point glint: two hairlines, each fading to nothing at its tips, turned by `angle`.
    private static func glint(_ ink: Ink, _ spot: CGPoint, _ arm: Double, _ a: Double, angle: Double = 0, in pen: inout ScenePen) {
        guard a >= 0.012 else { return }
        for turn in [angle, angle + .pi / 2] {
            let dx = cos(turn) * arm, dy = sin(turn) * arm
            let from = CGPoint(x: spot.x - dx, y: spot.y - dy), to = CGPoint(x: spot.x + dx, y: spot.y + dy)
            pen.stroke(Path { $0.move(to: from); $0.addLine(to: to) }, with: .linearGradient(PenGradient(stops: [
                .init(color: ink.wire.color(0), location: 0), .init(color: ink.blaze(0.8).color(min(1, a)), location: 0.5),
                .init(color: ink.wire.color(0), location: 1),
            ]), startPoint: from, endPoint: to), lineWidth: 1)
        }
    }
    /// A meteor's head: soft light with no edge, a bright core, and a glint on the bright ones.
    private static func head(_ ink: Ink, _ spot: CGPoint, _ w: Double, _ a: Double, glinting: Bool, in pen: inout ScenePen) {
        guard a >= 0.012 else { return }
        let r = w * 3.6
        pen.fill(circle(spot, r), with: .radialGradient(PenGradient(stops: [
            .init(color: ink.blaze(0.6).color(min(1, a * 0.55)), location: 0), .init(color: ink.wire.color(min(1, a * 0.16)), location: 0.4),
            .init(color: ink.wire.color(0), location: 1),
        ]), center: spot, startRadius: 0, endRadius: r))
        pen.fill(circle(spot, w * 0.55), with: .color(ink.blaze(0.9).color(min(1, a))))
        if glinting { glint(ink, spot, w * 3.2, a * 0.75, in: &pen) }
    }

    /// One meteor: its streak while it runs, then its train while it lingers. `k` is the phone's share of the desktop.
    private static func draw(_ m: Meteor, _ ink: Ink, et: Double, secs: Double, trail: Double, center c: CGPoint, k: Double, in pen: inout ScenePen) {
        guard let at = place(m, et, secs) else { return }
        let reachLen = m.L * (m.lifeF > 0 ? 0.85 : 0.66) * trail
        let spot = CGPoint(x: c.x + at.x * k, y: c.y + at.y * k)
        if at.u < 1 {
            let a = min(1, m.mag * at.lum * edge(at.x, at.y) * ink.boost)
            let len = min(m.L * at.u * (1.12 - 0.12 * at.u), reachLen) * k
            if m.mag > 0.7 { streak(ink, spot, m.ux, m.uy, len * 0.7, m.w * 2.6 * k, a * 0.2, 0.2, in: &pen) }
            streak(ink, spot, m.ux, m.uy, len, m.w * k, a, 0.5 + 0.4 * at.lum, in: &pen)
            let flare = pulse(at.u, 0.66, 0.3)
            head(ink, spot, m.w * k * (m.lifeF > 0 ? 1 + 0.5 * flare : 1), a, glinting: m.mag > 0.75, in: &pen)
            if m.lifeF > 0 { glint(ink, spot, (16 + 50 * flare) * k, a * 0.85, in: &pen) }
        } else if m.linger > 0 {
            let v = (at.u - 1) * at.life / m.linger
            guard v < 1 else { return }
            let a = m.mag * 0.34 * pow(1 - v, 2) * edge(at.x, at.y) * ink.boost
            streak(ink, spot, m.ux, m.uy, min(m.L, reachLen) * k, m.w * (1 - 0.5 * v) * k, a, 0, in: &pen)
        }
    }

    /// The stars that come out with the hush, each twinkling, the brightest with a small glint.
    private static func drawStars(_ ink: Ink, et: Double, t: Double, center c: CGPoint, k: Double, in pen: inout ScenePen) {
        let hush = Self.hush(et)
        guard hush >= 0.01 else { return }
        for (i, s) in data.skyStars.enumerated() {
            let al = hush * (0.42 + 0.58 * s[2]) * (0.72 + 0.28 * CharacterSky.twinkle(t * 2.2 + Double(i) * 1.9)) * edge(s[0], s[1]) * ink.boost
            let star = CGPoint(x: c.x + s[0] * k, y: c.y + s[1] * k)
            pen.fill(circle(star, (0.8 + 0.9 * s[2]) * k), with: .color(ink.blaze(0.3 + 0.5 * s[2]).color(min(1, al))))
            if s[2] > 0.6 { glint(ink, star, (3 + 4 * s[2]) * k, al * 0.6, in: &pen) }
        }
    }

    /// The fireball: its wake of dust, its fragments and the burst's pieces, then its head.
    private static func drawFireball(_ ink: Ink, et: Double, t: Double, center c: CGPoint, k: Double, in pen: inout ScenePen) {
        let u = cross(et)
        guard u > 0 else { return }
        let p = data.path, crossS = at("crossFor") * seconds(.fireball), trail = data.fireball.trail
        let speed = p.len / crossS, run = Self.run(min(u, 1)), trainS = at("trainS")
        func spot(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: c.x + x * k, y: c.y + y * k) }
        // The wake: dust left along the path, each grain twinkling, drifting off the line and sinking a little as it
        // fades, brighter where it flared.
        var s = 0.0
        for (i, grain) in data.dust.enumerated() {
            if s > run { break }
            defer { s += 1.5 }
            // When the head passed this point, by inverting run(_:).
            let us = (1.1 - (1.21 - 0.4 * s / p.len).squareRoot()) / 0.2
            let age = (u - us) * crossS, fade = exp(-age / trainS)
            guard fade >= 0.03 else { continue }
            let knot = data.flares.reduce(0.0) { max($0, $1[1] * clamp01(1 - abs(us - $1[0]) / 0.06)) }
            let off = grain[0] * (1.2 + (7 + 9 * knot) * (1 - exp(-age * 1.1)))
            let rx = p.x0 + p.ux * s - p.uy * off, ry = p.y0 + p.uy * s + p.ux * off + age * age * 1.4
            let a = min(1, fade * (0.55 + 0.45 * CharacterSky.twinkle(t * 8 + Double(i) * 2.1)) * (0.45 + 0.75 * grain[2]) * (1.2 + 1.2 * knot)
                * edge(rx, ry) * ink.boost * clamp01(us / 0.04))
            guard a >= 0.02 else { continue }
            pen.fill(circle(spot(rx, ry), (0.6 + 0.95 * grain[3]) * (1 + 0.5 * knot) * k), with: .color(ink.blaze(0.5 * grain[1]).color(a)))
        }
        // The fragments, each behind the head on its own slowing line.
        for f in pieces {
            let tau = (u - f.u) * crossS
            guard tau > 0, tau < f.life else { continue }
            let ux = p.ux * cos(f.turn) - p.uy * sin(f.turn), uy = p.ux * sin(f.turn) + p.uy * cos(f.turn)
            let life = 1 - tau / f.life, v0 = speed * f.v, s0 = Self.run(min(f.u, 1))
            let along = v0 * (1 - exp(-tau * f.drag)) / f.drag, vel = v0 * exp(-tau * f.drag)
            let side = f.side * (1 - exp(-tau * 1.4))
            let rx = p.x0 + p.ux * s0 + ux * along - uy * side, ry = p.y0 + p.uy * s0 + uy * along + ux * side + 7 * tau * tau
            let a = f.a * pow(life, 1.2) * (0.75 + 0.25 * CharacterSky.twinkle(t * 9 + f.w * 30)) * edge(rx, ry) * ink.boost
            streak(ink, spot(rx, ry), ux, uy, max(5.3, vel * 0.16) * trail * k, f.w * k, a, 0.5, in: &pen)
            head(ink, spot(rx, ry), f.w * 0.85 * k, a, glinting: f.w > 2.2 && life > 0.5, in: &pen)
        }
        guard u < 1 else { return }
        // The head: a white core, light with no edge, and a glint that grows with each flare.
        let rx = p.x0 + p.ux * run, ry = p.y0 + p.uy * run, here = spot(rx, ry)
        let fl = flare(u), a = min(1, lum(u) * edge(rx, ry) * ink.boost)
        let tail = min(run, reach * 1.05 * trail) * k
        streak(ink, here, p.ux, p.uy, tail * 0.5, 30 * k, a * 0.13, 0.1, in: &pen)
        streak(ink, here, p.ux, p.uy, tail * 0.8, 12 * k, a * 0.42, 0.3, in: &pen)
        streak(ink, here, p.ux, p.uy, tail, 5 * k, a, 0.85, in: &pen)
        let br = (34 + 40 * fl) * k
        pen.fill(circle(here, br), with: .radialGradient(PenGradient(stops: [
            .init(color: ink.blaze(0.8).color(a * 0.8), location: 0), .init(color: ink.blaze(0.3).color(a * 0.26), location: 0.25),
            .init(color: ink.wire.color(0), location: 1),
        ]), center: here, startRadius: 0, endRadius: br))
        pen.fill(circle(here, (3 + 2 * fl) * k), with: .color(ink.blaze(0.95).color(a)))
        glint(ink, here, (40 + 74 * fl) * k, a * 0.9, in: &pen)
        glint(ink, here, (13 + 26 * fl) * k, a * 0.6, angle: .pi / 4, in: &pen)
    }

    /// The storm's landing glints on the first mate's own drawing, over its wires; `k` is its size over 280.
    static func drawGlints(_ glints: [(point: CGPoint, q: Double)], wire: RGB, background: RGB, boost: Double, k: Double, in pen: inout ScenePen) {
        let ink = Ink(wire: wire, bg: background, boost: boost)
        for g in glints { glint(ink, g.point, (9 + 9 * (1 - g.q)) * k, pow(1 - g.q, 1.5) * boost, in: &pen) }
    }

    // MARK: the sky and the crew

    /// One meteor fidget on the crew's stage this frame, as the Mac's MeteorFrame. `home` holds the storm's 16 points
    /// where the first mate last drew them, x, y pairs from its center at 280 points.
    struct Frame {
        var variant: Variant
        var et, t, release, coreR, heat: Double
        var home: [Double]
    }
    static func frame(_ pose: CharacterPose, coreR: Double, home: [Double]) -> Frame? {
        guard pose.mode == .fidget, let v = pose.variant, isMeteor(v) else { return nil }
        return Frame(variant: v, et: pose.progress, t: pose.milliseconds / 1000, release: 1, coreR: coreR, heat: pose.heat, home: home)
    }

    /// The crew's side (the Mac's CrewMeteors): a fidget cut short holds where it stopped while its sky fades.
    struct Ride {
        private var last: Frame?
        private var cutAt: Double?
        mutating func resolve(_ frame: Frame?, now: Double) -> Frame? {
            if let frame { last = frame; cutAt = nil; return frame }
            guard var held = last, held.et < 1 else { last = nil; return nil }
            let at = cutAt ?? now
            cutAt = at
            held.release = 1 - easeInOut(clamp01((now - at) * 1000 / data.releaseMs))
            if held.release <= 0 { last = nil; cutAt = nil; return nil }
            held.t += now - at
            return held
        }
    }

    /// The lights a frame casts on the crew, desktop px from the first mate's center, its points drawn at `scale`.
    static func crewLights(_ f: Frame, scale: Double) -> [Light] {
        let home = f.home.map { $0 / scale }
        return lights(f.variant, f.et, flights: f.variant == .storm ? flights(f.et, rank: CharacterSky.windingRank, home: home) : []).lights
    }
    /// Light one home crewmate by the meteors passing it; nothing moves it. The desktop's pixels are drawn at `scale`.
    static func light(_ g: inout PhoneSceneMotion.Glyph, around center: CGPoint, f: Frame, lights: [Light], scale: Double) {
        guard data.crewLight > 0 else { return }
        let x = (g.point.x - center.x) / scale, y = (g.point.y - center.y) / scale
        g.flash = max(g.flash, min(1, lit(lights, x, y) * data.crewLight * 1.5) * f.release)
    }

    /// The sky round the first mate. Behind the crew (`near` false): the stars, every meteor, the fireball and the
    /// storm's points falling home; in front of the crew and the first mate: only the storm's nearest streaks.
    /// `scale` is the phone's share of the desktop's orbits.
    static func drawSky(_ f: Frame, at center: CGPoint, scale k: Double, palette: CharacterPainter.Palette, near: Bool, in pen: inout ScenePen) {
        let ink = Ink(wire: palette.acc.mix(palette.hot, f.heat), bg: palette.bg, boost: palette.boost * f.release)
        guard ink.boost > 0.004 else { return }
        let et = f.et, secs = seconds(f.variant)
        if !near { drawStars(ink, et: et, t: f.t, center: center, k: k, in: &pen) }
        switch f.variant {
        case .shower:
            guard !near else { return }
            for m in showerMeteors { draw(m, ink, et: et, secs: secs, trail: data.shower.trail, center: center, k: k, in: &pen) }
        case .storm:
            for m in stormMeteors where m.near == near { draw(m, ink, et: et, secs: secs, trail: data.storm.trail, center: center, k: k, in: &pen) }
            guard !near else { return }
            // The first mate's own points, raining home down the stream. They land where it drew them, unscaled.
            let dir = data.stormDir
            for p in flights(et, rank: CharacterSky.windingRank, home: f.home.map { $0 / k }) {
                let e = edge(p.x, p.y), here = CGPoint(x: center.x + p.x * k, y: center.y + p.y * k)
                let len = f.coreR * (0.5 + 2.6 * (1 - p.dn)) * data.storm.trail * k
                streak(ink, here, dir[0], dir[1], len, 2.6 * k, e * ink.boost, 0.7, in: &pen)
                head(ink, here, 2.4 * k, min(1, e * ink.boost), glinting: false, in: &pen)
            }
        default:
            guard !near else { return }
            for m in heralds { draw(m, ink, et: et, secs: secs, trail: trail(.fireball), center: center, k: k, in: &pen) }
            drawFireball(ink, et: et, t: f.t, center: center, k: k, in: &pen)
        }
    }
}
