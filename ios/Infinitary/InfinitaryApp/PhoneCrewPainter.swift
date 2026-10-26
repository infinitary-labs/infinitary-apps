import SwiftUI

/// Native solids share desktop vertices, edges, depth projection, heat and banked checks appearance.
enum PhoneCrewPainter {
    static func circle(_ at: CGPoint, _ r: Double) -> Path {
        Path(ellipseIn: CGRect(x: at.x - r, y: at.y - r, width: r * 2, height: r * 2))
    }
    static func draw(_ frame: PhoneSceneMotion.Frame, roster: PhoneSceneRoster, now: Double, still: Bool,
                     in context: inout GraphicsContext, palette: CharacterPainter.Palette) {
        // As on the desktop, no orbit is outlined and another computer's group has no ring at its center.
        for (from, to, review) in frame.links {
            var path = Path(); path.move(to: from); path.addLine(to: to)
            let angle = atan2(to.y - from.y, to.x - from.x), at = CGPoint(x: to.x - cos(angle) * 20, y: to.y - sin(angle) * 20)
            path.move(to: CGPoint(x: at.x - cos(angle - 0.5) * 6, y: at.y - sin(angle - 0.5) * 6))
            path.addLine(to: at); path.addLine(to: CGPoint(x: at.x - cos(angle + 0.5) * 6, y: at.y - sin(angle + 0.5) * 6))
            context.stroke(path, with: .color((review ? palette.hot : palette.dim).color(0.5)), style: StrokeStyle(lineWidth: 1, dash: review ? [] : [3, 4]))
        }
        for mark in frame.marks {
            context.stroke(circle(mark.point, CharacterCatalog.shared.program["rootMarkPx"]!), with: .color(palette.acc.color(0.8)), lineWidth: 1.2)
        }
        for glyph in frame.glyphs { draw(glyph, now: now, still: still, in: &context, palette: palette) }
        for (point, strength) in frame.packets {
            context.fill(circle(point, 5), with: .radialGradient(Gradient(colors: [palette.acc.color(0.6 * strength), palette.acc.color(0)]), center: point, startRadius: 0, endRadius: 5))
            context.fill(circle(point, 2), with: .color(palette.acc.color(strength)))
        }
    }
    private static func draw(_ glyph: PhoneSceneMotion.Glyph, now: Double, still: Bool, in context: inout GraphicsContext, palette: CharacterPainter.Palette) {
        let solid = CharacterCatalog.shared.solids[glyph.task.tier ?? "low"] ?? CharacterCatalog.shared.solids["low"]!
        let work = glyph.unknown ? 0 : glyph.work
        let color = palette.acc.mix(palette.hot, max(work, glyph.checks ? 1 : 0))
        let strength = (glyph.checks ? 0.6 : 0.55 + 0.45 * work) * glyph.alpha * (glyph.unknown ? 0.45 : 1) * palette.boost
        let jitter = glyph.nudge * 3
        let at = CGPoint(x: glyph.point.x + CharacterSky.twinkle(now * 14) * jitter, y: glyph.point.y + CharacterSky.twinkle(now * 13) * jitter)
        let radius = glyph.size * 0.4, angle = glyph.spin
        let points: [(CGPoint, Double)] = solid.v.map { v in
            let x = v[0] * cos(angle) - v[2] * sin(angle), z = v[0] * sin(angle) + v[2] * cos(angle)
            let y = v[1] * cos(angle * 0.6) - z * sin(angle * 0.6), z2 = v[1] * sin(angle * 0.6) + z * cos(angle * 0.6)
            let depth = 3 / (3 - z2)
            return (CGPoint(x: at.x + x * depth * radius * glyph.unfold, y: at.y + y * depth * radius * glyph.unfold), depth)
        }
        let spill = glyph.flicker * CharacterCatalog.shared.flicker["glowSpill"]!
        if work > 0 || spill > 0 {
            let halo = glyph.size * (0.95 + 0.2 * spill), alpha = (0.14 * work + 0.5 * spill) * glyph.alpha * glyph.unfold
            context.fill(circle(at, halo), with: .radialGradient(Gradient(colors: [color.color(alpha), color.color(0)]), center: at, startRadius: 0, endRadius: halo))
        }
        if glyph.unfold < 1 { context.fill(circle(at, 2.8 * (1 - glyph.unfold)), with: .color(palette.acc.color(glyph.alpha))) }
        if glyph.checks {
            context.stroke(circle(at, glyph.size * 0.8), with: .color(palette.acc.color(still ? 0.6 : 0.22)), lineWidth: 1)
            if !still {
                let arc = CharacterSky.path(20) { t in
                    let angle = now * 1.6 + t * 1.1
                    return CGPoint(x: at.x + cos(angle) * glyph.size * 0.8, y: at.y + sin(angle) * glyph.size * 0.8)
                }
                context.stroke(arc, with: .color(palette.acc.color(0.9)), lineWidth: 1.4)
            }
        }
        let width = max(1, min(1.6, 1.4 * glyph.size / 30)) * solid.ink[1]
        for (index, edge) in solid.e.enumerated() {
            let a = points[edge[0]], b = points[edge[1]], flicker = glyph.flicker * CharacterFlicker.wire(index, now * 1000)
            let alpha = max(0.35, min(0.9, 0.4 + ((a.1 + b.1) / 2 - 0.85) * 0.9)) * strength * solid.ink[0]
            context.stroke(Path { $0.move(to: a.0); $0.addLine(to: b.0) }, with: .color(color.mix(CharacterPainter.RGB(255, 246, 230), min(1, flicker * 0.7)).color(min(1, alpha * (1 + 0.9 * flicker)))), style: StrokeStyle(lineWidth: width, lineCap: .round))
        }
        if work > 0.05 && glyph.unfold > 0.9 && !still {
            let cycle = now / 0.9, fraction = cycle - floor(cycle)
            if fraction < 0.3 {
                let edge = solid.e[Int(cycle) % solid.e.count]
                context.stroke(Path { $0.move(to: points[edge[0]].0); $0.addLine(to: points[edge[1]].0) }, with: .color(color.mix(CharacterPainter.RGB(255, 246, 230), 0.75).color(sin(fraction / 0.3 * .pi) * work * glyph.alpha)), lineWidth: width * 0.6)
            }
        }
        for index in 0..<(solid.nodes ?? points.count) {
            let point = points[index], pulse = 1 + 0.5 * work * max(0, sin(now / 0.3 + Double(index) * 1.3))
            let radius = 1.2 * glyph.size / 28 * pulse * (0.4 + 0.6 * glyph.unfold) * solid.ink[2]
            context.fill(circle(point.0, radius), with: .color(color.color(max(0.5, min(1, 0.5 + (point.1 - 0.85) * 0.8)) * strength * solid.ink[0])))
        }
    }
}
