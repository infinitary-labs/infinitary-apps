import SwiftUI

/// The supernova fidget of character/supernova.ts and crew/supernova.ts on the Mac: the first mate collapses, goes
/// dark for a beat, bursts into a flash of straight rays, a shell of sparks and the broken pieces of its frame, and
/// falls back together, while the blast's front kicks each home crewmate out and lets it swing back to its seat.
/// The blast has no outline, ring or filled edge anywhere. The settings, the schedule and every spark, ray, shard and
/// flight come generated from the desktop owner; the shapes are ported here.
enum CharacterSupernova {
    struct Data: Decodable, Sendable {
        let durationMs, flash, crewKickPx, reachPx, streakMs, kickMs, releaseMs: Double
        let pulsar: Bool
        let schedule: [String: Double]
        /// Each spark: direction, share of the front, nearness, radius, alpha, bright (1), glints (1).
        let sparks: [[Double]]
        /// Each ray, the four spikes first: direction, length share, alpha, width.
        let rays: [[Double]]
        /// Each shard: direction, share of the front, tumble rate, first angle, half length in radii, alpha.
        let shards: [[Double]]
        /// Each vertex's flight: how far out in radii, and its head start.
        let fling: [[Double]]
    }
    static var data: Data { CharacterCatalog.shared.supernova }
    typealias RGB = CharacterPainter.RGB
    private static let white = RGB(255, 246, 230)
    private static func at(_ key: String) -> Double { data.schedule[key]! }
    private static func easeOut3(_ t: Double) -> Double { 1 - pow(1 - t, 3) }

    // MARK: the curves

    /// How far the frame has fallen in, 0..1, on a cubic curve.
    static func collapse(_ et: Double) -> Double { pow(clamp01((et - at("collapseAt")) / (at("holdAt") - at("collapseAt"))), 3) }
    /// How far the front has run, as a share of its reach: fast at once, slowing on a quartic, then a 2% drift.
    static func front(_ et: Double) -> Double {
        let bounce = at("bounceAt"), length = at("frontFor"), u = clamp01((et - bounce) / length)
        return 1 - pow(1 - u, 4) + 0.02 * clamp01((et - bounce - length) / 0.3)
    }
    /// When the front reaches `share` of its reach, as a fraction of the fidget.
    static func frontAt(_ share: Double) -> Double { at("bounceAt") + at("frontFor") * (1 - pow(1 - clamp01(share), 0.25)) }
    /// The blast's light: 1 until the sparks start to fade, 0 once they are gone.
    static func fade(_ et: Double) -> Double { et < at("bounceAt") ? 0 : 1 - easeInOut(clamp01((et - at("fadeAt")) / at("fadeFor"))) }
    /// The flash, brightest in its first frame.
    static func flash(_ et: Double) -> Double {
        let u = (et - at("bounceAt")) / at("flashFor")
        return u < 0 || u >= 1 ? 0 : pow(1 - u, 2) * data.flash
    }
    /// The pulsar's strength: it rises after the blast and is gone before the vertices return.
    static func pulsar(_ et: Double) -> Double { data.pulsar ? band(et, at("pulsarAt"), 0.06, at("returnAt") - 0.05, 0.08) : 0 }
    /// The body's size through the collapse: a small swell, then a fall to under a tenth.
    static func size(_ et: Double) -> Double { et >= at("bounceAt") ? 1 : 1 + 0.08 * pulse(et, 0.03, 0.12) - 0.92 * collapse(et) }

    /// `squeeze` runs the wires white as the frame falls in, `spin` is its extra turn (rad/s), `glow` the ambient light.
    struct Body { var squeeze = 0.0, spin = 0.0, glow = 1.0 }
    static func body(_ et: Double) -> Body {
        let ck = collapse(et), after = et >= at("bounceAt")
        let hush = after ? 0 : clamp01((et - at("holdAt") + 0.012) / 0.014)
        let curve = after ? 3 * exp(-(et - at("bounceAt")) * 10) : 0.9 * ck
        return Body(squeeze: after ? 0 : ck, spin: after ? 0 : 2.4 * ck, glow: (1 + curve * data.flash) * (1 - 0.9 * hush))
    }
    static func body(of pose: CharacterPose) -> Body? {
        pose.mode == .fidget && pose.variant == .supernova ? body(pose.progress) : nil
    }

    /// The eyes: braced shut and drawn in for the collapse, then wide open, looking left, right and down, and a blink.
    struct Eyes { var look = (x: 0.0, y: 0.1), lid = 0.0, wide = 1.0, gather = 1.0 }
    static func eyes(_ et: Double) -> Eyes {
        var eyes = Eyes(), lid: Double
        let bounce = at("bounceAt")
        if et < bounce {
            lid = easeInOut(clamp01((et - 0.07) / 0.1))
            eyes.gather = 1 - 0.8 * collapse(et)
        } else {
            let open = easeOut3(clamp01((et - bounce - 0.05) / 0.05))
            lid = 1 - open
            eyes.gather = 0.2 + 0.8 * open
            eyes.wide = 1 + 0.3 * band(et, bounce + 0.05, 0.04, 0.62, 0.12)
            eyes.look = et < 0.46 ? (-0.85, -0.35) : et < 0.62 ? (0.85, 0.1) : et < at("returnAt") ? (0, 0.55) : (0, 0)
        }
        eyes.lid = max(lid, pulse(et, 0.925, 0.05))
        return eyes
    }

    // MARK: the vertices

    /// One vertex this frame: where it is, how far it has left the frame (its wires fade by it), its dot's size and
    /// white-hot core, and, while it flies out, the direction and strength of its tail of light.
    struct Vertex {
        var point: CGPoint
        var progress = 0.0, scale = 1.0, white = 0.0
        var trail: (angle: Double, k: Double)?
    }
    /// Vertex `index` of winding rank `rank` (inner cell first): through the collapse it falls toward the center,
    /// trembling; after the bounce it flies out along its own ray, slows, and comes home with a small swing.
    static func vertex(_ index: Int, rank: Double, base: CGPoint, et: Double, c: Double, r: Double, time: Double) -> Vertex {
        let bounce = at("bounceAt")
        var v = Vertex(point: base)
        if et < bounce {
            let ck = collapse(et), body = size(et)
            v.point = CGPoint(x: c + (base.x - c) * body, y: c + (base.y - c) * body)
            if ck > 0.01 {
                v.point.x += CharacterSky.twinkle(time * 19 + Double(index) * 3.1) * ck * r * 0.025
                v.point.y += CharacterSky.twinkle(time * 17 + Double(index) * 5.7) * ck * r * 0.025
            }
            v.scale = 0.55 + 0.45 * body
            v.white = 0.7 * ck
            return v
        }
        let gone = clamp01((et - bounce) / 0.02), fling = data.fling[index]
        let o = easeOut3(clamp01((et - bounce - fling[1]) / at("outFor")))
        let b = easeInOut(clamp01((et - at("returnAt") - rank / 15 * 0.05) / (at("returnFor") - 0.05)))
        let angle = rank / 16 * 2 * .pi + 0.5 + 0.3 * sin(Double(index) * 2.4)
        let far = r * (fling[0] + 0.08 * clamp01((et - bounce) / 0.5))
        let dx = cos(angle) * far * o, dy = sin(angle) * far * o, swing = (1 - b) * b * 0.6
        let fx = c + dx * cos(swing) - dy * sin(swing), fy = c + dx * sin(swing) + dy * cos(swing)
        v.point = CGPoint(x: fx + (base.x - fx) * b, y: fy + (base.y - fy) * b)
        v.progress = gone * (1 - b).squareRoot()
        let blown = gone * (1 - b) * (0.4 + 0.6 * (1 - o))
        v.scale = 1 + 0.7 * blown
        v.white = blown
        if o < 0.98 && b <= 0 { v.trail = (angle, pow(1 - o, 1.2)) }
        return v
    }

    // MARK: the first mate's own light

    /// A light run toward white-hot; on a light background white would vanish, so it keeps its own ink.
    static func blaze(_ wire: RGB, background: RGB, _ k: Double) -> RGB {
        background.r + background.g + background.b > 380 ? wire : wire.mix(white, k)
    }
    private static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path { Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)) }

    /// The remnant's soft light behind the eyes, and each flying vertex's tail back toward the center, under the wires.
    static func drawUnder(_ et: Double, trails: [(point: CGPoint, angle: Double, k: Double)], c: Double, r: Double,
                          wire: RGB, background: RGB, boost: Double, in context: inout ScenePen) {
        let k = band(et, at("bounceAt") + 0.04, 0.08, at("returnAt"), 0.14)
        if k > 0.01 {
            context.fill(circle(c, c, r * 0.75), with: .radialGradient(
                PenGradient(colors: [blaze(wire, background: background, 0.5).color(min(1, 0.3 * k * boost)), wire.color(0)]),
                center: CGPoint(x: c, y: c), startRadius: 0, endRadius: r * 0.75))
        }
        let head = blaze(wire, background: background, 0.5)
        for trail in trails {
            let length = r * 0.9 * trail.k
            let end = CGPoint(x: trail.point.x - cos(trail.angle) * length, y: trail.point.y - sin(trail.angle) * length)
            context.stroke(Path { $0.move(to: trail.point); $0.addLine(to: end) },
                           with: .linearGradient(PenGradient(colors: [head.color(min(1, 0.7 * trail.k * boost)), wire.color(0)]), startPoint: trail.point, endPoint: end),
                           style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        }
    }

    // MARK: the blast and the crew

    /// One supernova on the crew's stage this frame, as the Mac's SupernovaFrame.
    struct Frame {
        var et, t, release, coreR, heat: Double
    }
    static func frame(_ pose: CharacterPose, coreR: Double) -> Frame? {
        guard pose.mode == .fidget, pose.variant == .supernova else { return nil }
        return Frame(et: pose.progress, t: pose.milliseconds / 1000, release: 1, coreR: coreR, heat: pose.heat)
    }

    /// The crew's side (the Mac's CrewSupernova): a supernova cut short lets the crew go home over the release.
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

    /// The peak of sin(pi x) e^(-2.4 x) on 0..1, so the swing's peak is the whole kick.
    private static let swingPeak = 0.394
    /// How far the front's kick has a crewmate `d` desktop pixels from the center out: zero before the front reaches
    /// it and once its swing has settled, so every crewmate ends on its own seat.
    static func kick(_ d: Double, _ f: Frame) -> Double {
        let reach = data.reachPx
        guard d < reach, data.crewKickPx > 0 else { return 0 }
        let x = (f.et - frontAt(d / reach)) * data.durationMs / data.kickMs
        guard x > 0, x < 2 else { return 0 }
        return data.crewKickPx * sin(.pi * x) * exp(-2.4 * x) / swingPeak * (1 - 0.5 * d / reach) * f.release
    }
    /// Light and kick one home crewmate after the orbit placed it: the flash brightens it at once, and the passing
    /// front pushes it straight out from the center and lets it swing back. The desktop's pixels are drawn at `scale`.
    static func kick(_ g: inout PhoneSceneMotion.Glyph, around center: CGPoint, f: Frame, scale: Double) {
        let dx = g.point.x - center.x, dy = g.point.y - center.y, distance = hypot(dx, dy)
        var lit = flash(f.et) * 0.7 * f.release
        let push = kick(distance / scale, f)
        if push != 0 && distance > 0 {
            g.point = CGPoint(x: g.point.x + dx / distance * push * scale, y: g.point.y + dy / distance * push * scale)
            lit = max(lit, push / data.crewKickPx)
        }
        g.flash = max(g.flash, min(1, lit))
    }

    /// The blast, under every crewmate and the first mate: the flash's bloom, rays and spikes; the afterglow, a soft
    /// light with no edge; the pulsar's beams; the frame's shards; and the shell of sparks, each streaking while it
    /// is fast and, for the brightest, glinting once it slows. `scale` is the phone's share of the desktop's orbits.
    static func drawBlast(_ f: Frame, at center: CGPoint, scale: Double, palette: CharacterPainter.Palette, in context: inout ScenePen) {
        let et = f.et, bounce = at("bounceAt")
        guard et >= bounce else { return }
        let reach = data.reachPx * scale, front = reach * Self.front(et), boost = palette.boost
        let fading = fade(et) * boost * f.release
        guard fading > 0.004 else { return }
        let cx = center.x, cy = center.y
        let wire = palette.acc.mix(palette.hot, f.heat), background = palette.bg
        let bright = blaze(wire, background: background, 0.6), soft = blaze(wire, background: background, 0.25)
        let fa = flash(et) * f.release
        if fa > 0.01 {
            let fu = (et - bounce) / at("flashFor"), hot = blaze(wire, background: background, 0.9)
            let fr = reach * 0.85 * (0.6 + 0.4 * easeOut3(fu))
            context.fill(circle(cx, cy, fr), with: .radialGradient(PenGradient(stops: [
                .init(color: hot.color(fa), location: 0), .init(color: hot.color(fa), location: 0.13),
                .init(color: blaze(wire, background: background, 0.45).color(0.5 * fa), location: 0.36), .init(color: wire.color(0), location: 1),
            ]), center: center, startRadius: 0, endRadius: fr))
            let rayMax = reach * 1.05
            for ray in data.rays {
                let end = CGPoint(x: cx + cos(ray[0]) * rayMax * ray[1], y: cy + sin(ray[0]) * rayMax * ray[1])
                context.stroke(Path { $0.move(to: center); $0.addLine(to: end) },
                               with: .linearGradient(PenGradient(colors: [hot.color(min(1, fa * ray[2] * boost)), wire.color(0)]), startPoint: center, endPoint: end),
                               style: StrokeStyle(lineWidth: ray[3], lineCap: .round))
            }
        }
        // The afterglow: soft light where the star was, with no edge anywhere.
        let glowR = front * 0.9 + 1, ga = 0.2 * fading * clamp01((et - bounce) / at("flashFor") / 0.3)
        context.fill(circle(cx, cy, glowR), with: .radialGradient(PenGradient(stops: [
            .init(color: wire.color(ga), location: 0), .init(color: wire.color(ga * 0.5), location: 0.3),
            .init(color: wire.color(ga * 0.14), location: 0.62), .init(color: wire.color(0), location: 1),
        ]), center: center, startRadius: 0, endRadius: glowR))
        let seconds = (et - bounce) * data.durationMs / 1000
        drawPulsar(f, center: center, front: front, bright: bright, wire: wire, boost: boost, in: &context)
        // The shards: the frame's wires, broken off and tumbling outward.
        let shardA = fading * clamp01(1 - (et - at("fadeAt") + 0.1) / 0.2)
        if shardA > 0.01 {
            let ink = blaze(wire, background: background, 0.5 * (1 - clamp01(seconds / 0.5)))
            for s in data.shards {
                let r = front * s[1], turn = s[3] + s[2] * (1 - exp(-seconds * 1.4)), half = f.coreR * (0.2 - 0.07 * Self.front(et)) * s[4]
                let x = cx + cos(s[0]) * r, y = cy + sin(s[0]) * r
                context.stroke(Path { p in
                    p.move(to: CGPoint(x: x - cos(turn) * half, y: y - sin(turn) * half)); p.addLine(to: CGPoint(x: x + cos(turn) * half, y: y + sin(turn) * half))
                }, with: .color(ink.color(min(1, shardA * s[5]))), style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
            }
        }
        let before = reach * Self.front(et - data.streakMs / data.durationMs)
        for (k, spark) in data.sparks.enumerated() {
            let r = front * spark[1], tail = (front - before) * spark[1]
            let alpha = min(1, fading * (0.7 + 0.3 * CharacterSky.twinkle(f.t * 6 + Double(k) * 1.7)) * spark[4])
            let ux = cos(spark[0]), uy = sin(spark[0]), spot = CGPoint(x: cx + ux * r, y: cy + uy * r)
            let ink = spark[5] > 0 ? bright : soft
            if tail > 1.5 {
                let end = CGPoint(x: spot.x - ux * tail, y: spot.y - uy * tail)
                context.stroke(Path { $0.move(to: spot); $0.addLine(to: end) },
                               with: .linearGradient(PenGradient(colors: [ink.color(alpha * 0.85), wire.color(0)]), startPoint: spot, endPoint: end),
                               style: StrokeStyle(lineWidth: spark[3] * 1.3, lineCap: .round))
            }
            context.fill(circle(spot.x, spot.y, spark[3]), with: .color(ink.color(alpha)))
            if spark[6] > 0 && tail < 2.5 {
                let arm = spark[3] * (2.4 + 1.6 * CharacterSky.twinkle(f.t * 4 + Double(k)))
                context.stroke(Path { p in
                    p.move(to: CGPoint(x: spot.x - arm, y: spot.y)); p.addLine(to: CGPoint(x: spot.x + arm, y: spot.y))
                    p.move(to: CGPoint(x: spot.x, y: spot.y - arm)); p.addLine(to: CGPoint(x: spot.x, y: spot.y + arm))
                }, with: .color(bright.color(alpha * 0.6)), lineWidth: 0.7)
            }
        }
    }

    /// The pulsar: two beams from what is left of the star, turning with it, the near one brighter.
    private static func drawPulsar(_ f: Frame, center: CGPoint, front: Double, bright: RGB, wire: RGB, boost: Double, in context: inout ScenePen) {
        let k = pulsar(f.et) * f.release
        guard k > 0.01 else { return }
        let a = (f.et - at("pulsarAt")) * data.durationMs / 1000 * 2 * .pi * at("pulsarTurns")
        let bx = cos(a), by = sin(a) * 0.36
        let length = min(front * 0.9, f.coreR * 2.5) * hypot(bx, by), angle = atan2(by, bx) - 0.38
        for side in [1.0, -1.0] {
            let near = side * sin(a) > 0, d = angle + (side < 0 ? .pi : 0)
            let tip = CGPoint(x: center.x + cos(d) * length, y: center.y + sin(d) * length), w = length * 0.07
            let beam = Path { p in
                p.move(to: center)
                p.addLine(to: CGPoint(x: tip.x + cos(d + .pi / 2) * w, y: tip.y + sin(d + .pi / 2) * w))
                p.addLine(to: CGPoint(x: tip.x - cos(d + .pi / 2) * w, y: tip.y - sin(d + .pi / 2) * w))
                p.closeSubpath()
            }
            context.fill(beam, with: .linearGradient(PenGradient(colors: [bright.color(min(1, (near ? 0.5 : 0.28) * k * boost)), wire.color(0)]),
                                                     startPoint: center, endPoint: tip))
        }
    }
}
