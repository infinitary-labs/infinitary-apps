import SwiftUI

/// INF-209's native three-state first mate. The conversation owner supplies its real state.
struct PhoneCharacter: View {
    enum State: String, CaseIterable { case idle, listening, working }
    var state: State = .idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    @SwiftUI.State private var visible = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || !visible || phase != .active)) { timeline in
            drawing(at: reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your first mate")
        .accessibilityValue(state.rawValue)
        .accessibilityIdentifier("phone-character")
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }

    /// Also lets the native snapshot test photograph the exact still pose used by Reduce Motion.
    func drawing(at time: Double) -> some View {
        Canvas { context, size in draw(in: &context, size: size, time: time) }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, time: Double) {
        let side = min(size.width, size.height)
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let color = state == .working ? PhoneTheme.wireHot : PhoneTheme.wire
        let glow = Path(ellipseIn: CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side))
        context.fill(glow, with: .radialGradient(Gradient(colors: [color.opacity(0.12), color.opacity(0)]),
            center: center, startRadius: 0, endRadius: side / 2))
        if state == .listening {
            for ring in 0..<2 {
                let rotation = time * (ring == 0 ? 0.25 : -0.25) + Double(ring) * .pi / 6
                let radius = side * (ring == 0 ? 0.32 : 0.25)
                var path = Path()
                for index in 0..<6 {
                    let angle = Double(index) * .pi / 3 + rotation
                    let point = CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius)
                    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                }
                path.closeSubpath()
                context.stroke(path, with: .color(ring == 0 ? color : PhoneTheme.wireDim), lineWidth: 1.5)
            }
        } else {
            let speed = state == .working ? 0.65 : 0.035
            let a = 0.62 + time * speed, b = 0.34 + time * speed * 0.61
            var points: [(point: CGPoint, depth: Double)] = []
            for index in 0..<16 {
                let x = index & 1 == 0 ? -1.0 : 1.0, y = index & 2 == 0 ? -1.0 : 1.0
                let z = index & 4 == 0 ? -1.0 : 1.0, w = index & 8 == 0 ? -1.0 : 1.0
                let rx = x * cos(a) - w * sin(a), rw = x * sin(a) + w * cos(a)
                let ry = y * cos(b) - z * sin(b), rz = y * sin(b) + z * cos(b)
                let k = 2.4 / (3.6 - rw), perspective = 3.2 / (4.6 - rz * k)
                points.append((CGPoint(x: center.x + rx * k * perspective * side * 0.24,
                                       y: center.y + ry * k * perspective * side * 0.24), (rw + 2) / 4))
            }
            for index in 0..<16 {
                for bit in 0..<4 {
                    let other = index ^ (1 << bit)
                    guard other > index else { continue }
                    let depth = (points[index].depth + points[other].depth) / 2
                    var edge = Path(); edge.move(to: points[index].point); edge.addLine(to: points[other].point)
                    context.stroke(edge, with: .color((depth > 0.5 ? color : PhoneTheme.wireDim).opacity(0.45 + depth * 0.55)),
                                   lineWidth: 0.8 + depth)
                }
                let point = points[index]
                let pulse = state == .working ? 0.8 + 0.2 * sin(time * 3 + Double(index)) : 1
                let radius = (1.2 + point.depth) * pulse
                context.fill(Path(ellipseIn: CGRect(x: point.point.x - radius, y: point.point.y - radius,
                                                   width: radius * 2, height: radius * 2)), with: .color(color))
            }
        }
        for direction in [-1.0, 1.0] {
            let eye = CGPoint(x: center.x + direction * side * 0.065, y: center.y)
            context.fill(Path(ellipseIn: CGRect(x: eye.x - side * 0.045, y: eye.y - side * 0.045,
                                               width: side * 0.09, height: side * 0.09)),
                         with: .radialGradient(Gradient(colors: [color.opacity(0.55), color.opacity(0)]),
                                               center: eye, startRadius: 0, endRadius: side * 0.045))
            context.fill(Path(ellipseIn: CGRect(x: eye.x - side * 0.014, y: eye.y - side * 0.022,
                                               width: side * 0.028, height: side * 0.044)), with: .color(color))
        }
    }
}
