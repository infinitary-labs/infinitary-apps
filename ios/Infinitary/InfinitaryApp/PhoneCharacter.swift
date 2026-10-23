import SwiftUI

/// INF-209's native three-state first mate, moving as the Mac's character does (INF-589 item 18).
/// The conversation owner supplies its real state. Every number below is the Mac character's own, from
/// src/renderer/src/character (Firstmate.tsx, machine.ts, face.ts, replies.ts and glow.ts), so the two stay the same.
struct PhoneCharacter: View {
    enum State: String, CaseIterable { case idle, listening, working }
    var state: State = .idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    @SwiftUI.State private var visible = false
    @SwiftUI.State private var motion = CharacterMotion()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || !visible || phase != .active)) { timeline in
            if reduceMotion {
                drawing(at: 0)
            } else {
                let pose = motion.advance(to: timeline.date.timeIntervalSinceReferenceDate, state: state)
                Canvas { context, size in CharacterPainter.draw(pose, in: &context, size: size) }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your first mate")
        .accessibilityValue(state.rawValue)
        .accessibilityIdentifier("phone-character")
        .onAppear { visible = true; CharacterCues.shown.add(motion) }
        .onDisappear { visible = false; CharacterCues.left(motion) }
    }

    /// The still pose Reduce Motion shows, which the native snapshot test also photographs.
    func drawing(at time: Double) -> some View {
        let pose = CharacterPose.still(state, at: time)
        return Canvas { context, size in CharacterPainter.draw(pose, in: &context, size: size) }
    }
}

/// The Mac's two moments the phone carries (INF-589 question 6): a greeting and the reply nod.
@MainActor enum CharacterCues {
    /// The first character a person sees after the app opens or joins a computer greets once.
    static var greetingPending = true
    /// The characters on screen now; a reaction reaches only these, never one shown later.
    static let shown = NSHashTable<CharacterMotion>.weakObjects()

    static func greetOnNextSight() { greetingPending = true }

    /// A character that leaves mid-greeting, such as the empty stage a join shows before its cards arrive,
    /// hands the greeting on to the next one a person sees.
    static func left(_ motion: CharacterMotion) {
        shown.remove(motion)
        if motion.greeting { greetingPending = true }
    }

    /// The Mac's first mate reacted to a reply; the phone plays only the nod, as the Mac's character does.
    static func reacted(_ emote: String) {
        guard emote == "nod" else { return }
        for motion in shown.allObjects { motion.nodRequested = true }
    }
}

/// The Mac's FirstmateMachine (machine.ts), narrowed to the phone's states and its two emotes.
struct CharacterMachine {
    enum Mode: Equatable { case idle, listening, working, greet, nod }
    enum Emote { case greet, nod }
    /// EMOTE_DURATION_MS greet and REPLY_DURATION_MS nod, in seconds.
    static func seconds(_ mode: Mode) -> Double? { mode == .greet ? 2.1 : mode == .nod ? 1.4 : nil }

    private(set) var mode = Mode.idle
    private var busy = false
    private var enteredAt: Double
    /// A nod asked for during the first mate's own turn, held for that turn's end.
    private var heldNod = false

    init(now: Double) { enteredAt = now }

    private mutating func go(_ to: Mode, _ now: Double) { mode = to; enteredAt = now }

    /// Listening interrupts everything; a starting turn only heats an emote, which plays on to its end;
    /// a turn ending settles home, or into the nod held during it.
    mutating func setInputs(listening: Bool, busy: Bool, now: Double) {
        let fell = !busy && self.busy
        self.busy = busy
        let reply = fell && heldNod
        if fell { heldNod = false }
        if listening {
            if mode != .listening { go(.listening, now) }
            return
        }
        if mode == .listening { return go(busy ? .working : .idle, now) }
        if Self.seconds(mode) != nil { return }
        if reply { return go(.nod, now) }
        if mode == .idle && busy { return go(.working, now) }
        if mode == .working && !busy { go(.idle, now) }
    }

    /// An emote plays from idle or working only and never interrupts another; a nod during a turn waits for its end.
    @discardableResult mutating func request(_ emote: Emote, now: Double) -> Bool {
        if busy && emote == .nod {
            heldNod = true
            return true
        }
        guard mode == .idle || mode == .working else { return false }
        go(emote == .greet ? .greet : .nod, now)
        return true
    }

    /// Advances an emote's clock and returns home when it is done; the progress is 0 to 1.
    mutating func update(now: Double) -> (mode: Mode, progress: Double) {
        if let length = Self.seconds(mode), now - enteredAt >= length { go(busy ? .working : .idle, now) }
        return (mode, Self.seconds(mode).map { min(1, (now - enteredAt) / $0) } ?? 0)
    }
}

/// The Mac's per-state targets (FM_STATES), which the drawing eases toward.
struct CharacterTargets: Sendable {
    var sa, sb, pulse, glow, shimmer, breath, flat, scale, lidBase, eyeScale: Double

    static func of(_ mode: CharacterMachine.Mode) -> Self {
        switch mode {
        case .idle: Self(sa: 0.05, sb: 0.03, pulse: 0.05, glow: 0.35, shimmer: 0, breath: 0, flat: 0, scale: 1, lidBase: 0, eyeScale: 1)
        case .listening: Self(sa: 0.015, sb: 0.01, pulse: 0.5, glow: 1, shimmer: 0, breath: 0.09, flat: 1, scale: 1, lidBase: 0, eyeScale: 1.22)
        case .working: Self(sa: 1.15, sb: 0.78, pulse: 0.9, glow: 1, shimmer: 0.5, breath: 0, flat: 0, scale: 1, lidBase: 0.32, eyeScale: 0.95)
        case .greet: Self(sa: 0.05, sb: 0.04, pulse: 0.1, glow: 0.8, shimmer: 0, breath: 0, flat: 0, scale: 1.06, lidBase: 0, eyeScale: 1.1)
        case .nod: Self(sa: 0.04, sb: 0.03, pulse: 0.1, glow: 0.6, shimmer: 0, breath: 0, flat: 0, scale: 1.02, lidBase: 0, eyeScale: 1.06)
        }
    }

    func eased(toward target: Self, by k: Double) -> Self {
        func ease(_ from: Double, _ to: Double) -> Double { from + (to - from) * k }
        return Self(sa: ease(sa, target.sa), sb: ease(sb, target.sb), pulse: ease(pulse, target.pulse),
                    glow: ease(glow, target.glow), shimmer: ease(shimmer, target.shimmer), breath: ease(breath, target.breath),
                    flat: ease(flat, target.flat), scale: ease(scale, target.scale), lidBase: ease(lidBase, target.lidBase),
                    eyeScale: ease(eyeScale, target.eyeScale))
    }
}

/// Everything one frame draws from, independent of the drawing's size.
struct CharacterPose: Sendable {
    var mode = CharacterMachine.Mode.idle
    var progress = 0.0
    var cur = CharacterTargets.of(.idle)
    var heat = 0.0
    var a = 0.4, b = 0.9, hs = 0.0
    var milliseconds = 0.0
    var eyeX = 0.0, eyeY = 0.0
    var lid = 0.0, wink = 0.0, happy = 0.0

    /// Reduce Motion's still: the state's targets settled, eyes open and on the state's own look.
    static func still(_ state: PhoneCharacter.State, at time: Double) -> Self {
        let mode: CharacterMachine.Mode = state == .listening ? .listening : state == .working ? .working : .idle
        var pose = Self(mode: mode, cur: .of(mode), heat: state == .working ? 1 : 0, milliseconds: time * 1000)
        pose.a += pose.cur.sa * time
        pose.b += pose.cur.sb * time
        pose.hs = 0.5 * time * pose.cur.flat
        if mode == .working { (pose.eyeX, pose.eyeY) = (0.12, 0.4) }
        pose.lid = pose.cur.lidBase
        return pose
    }
}

/// The Mac's soft-light pulse and band (face.ts) and the nod's beat (replies.ts).
private func pulse(_ t: Double, _ at: Double, _ width: Double) -> Double {
    let u = (t - at) / width
    return u <= 0 || u >= 1 ? 0 : sin(u * .pi)
}
private func clamp01(_ x: Double) -> Double { max(0, min(1, x)) }
private func band(_ t: Double, _ a: Double, _ wa: Double, _ b: Double, _ wb: Double) -> Double {
    clamp01((t - a) / wa) * (1 - clamp01((t - b) / wb))
}
private func nodBeat(_ t: Double) -> Double { pulse(t, 0.05, 0.3) + pulse(t, 0.36, 0.24) * 0.6 }

/// The Mac's Spring, Blinker and Gaze (face.ts): blinks every few seconds, a wandering look at rest.
private struct Spring {
    var x = 0.0, v = 0.0
    let freq = 2.2, zeta = 0.9

    mutating func step(_ target: Double, _ dt: Double) {
        let w = 2 * Double.pi * freq, n = max(1, Int((dt * w / 0.5).rounded(.up))), h = dt / Double(n)
        for _ in 0..<n {
            v += (-2 * zeta * w * v - w * w * (x - target)) * h
            x += v * h
        }
    }
}

private struct Blinker {
    var next = 1.5 + Double.random(in: 0..<1) * 3
    var t = -1.0
    var again = false

    mutating func update(_ dt: Double, suppressed: Bool) -> Double {
        if t < 0 {
            if !suppressed {
                next -= dt
                if next <= 0 { t = 0; again = Double.random(in: 0..<1) < 0.22 }
            }
            return 0
        }
        t += dt
        let length = 0.16
        if t >= length {
            if again { again = false; t = 0; return 0 }
            t = -1; next = 2.4 + Double.random(in: 0..<1) * 4.2
            return 0
        }
        return sin(t / length * .pi)
    }
}

private struct Gaze {
    var sx = Spring(), sy = Spring()
    var tx = 0.0, ty = 0.0
    var next = 1 + Double.random(in: 0..<1) * 2

    /// A held look, or nil to wander.
    mutating func update(_ dt: Double, look: (x: Double, y: Double)?) -> (x: Double, y: Double) {
        var target = (x: tx, y: ty)
        if let look { target = look } else {
            next -= dt
            if next <= 0 {
                next = 1.2 + Double.random(in: 0..<1) * 2.6
                let angle = Double.random(in: 0..<1) * 2 * .pi, radius = Double.random(in: 0..<1) * 0.7
                (tx, ty) = Double.random(in: 0..<1) < 0.3 ? (0, 0) : (cos(angle) * radius, sin(angle) * radius * 0.6)
            }
            target = (tx, ty)
        }
        sx.step(target.x, dt); sy.step(target.y, dt)
        return (sx.x, sy.x)
    }
}

/// One character's running motion: the machine, the eased targets, the ember, the turning and the face.
@MainActor final class CharacterMotion {
    private var machine: CharacterMachine?
    private var last: Double?
    private var pose = CharacterPose()
    private var vel = 0.5
    private var blinker = Blinker(), gaze = Gaze()
    fileprivate var nodRequested = false
    var greeting: Bool { machine?.mode == .greet }

    func advance(to time: Double, state: PhoneCharacter.State) -> CharacterPose {
        if machine == nil {
            machine = CharacterMachine(now: time)
            if CharacterCues.greetingPending {
                CharacterCues.greetingPending = false
                machine?.request(.greet, now: time)
            }
        }
        guard var machine else { return pose }
        // Inputs first, then the request: a nod asked for as a turn starts is held for that turn's end.
        machine.setInputs(listening: state == .listening, busy: state == .working, now: time)
        if nodRequested { nodRequested = false; machine.request(.nod, now: time) }
        let (mode, et) = machine.update(now: time)
        self.machine = machine
        let dt = min(max(0, time - (last ?? time)), 0.05)
        last = time
        pose.mode = mode
        pose.progress = et
        pose.cur = pose.cur.eased(toward: .of(mode), by: min(dt * 4, 1))
        pose.heat += ((state == .working ? 1 : 0) - pose.heat) * min(dt * 3, 1)
        vel += (0.5 - vel) * min(dt * 1.5, 1)
        pose.a += pose.cur.sa * dt
        pose.b += pose.cur.sb * dt
        pose.hs += dt * vel * pose.cur.flat
        pose.milliseconds += dt * 1000
        let look: (x: Double, y: Double)? = switch mode {
        case .listening: (0, 0)
        case .working: (0.12, 0.4)
        case .nod: (0, 0.25 + 0.55 * nodBeat(et))
        default: nil
        }
        (pose.eyeX, pose.eyeY) = gaze.update(dt, look: look)
        pose.lid = max(pose.cur.lidBase, blinker.update(dt, suppressed: mode == .listening))
        pose.wink = mode == .greet ? band(et, 0.42, 0.1, 0.68, 0.12) : 0
        pose.happy = mode == .greet ? band(et, 0.12, 0.18, 0.82, 0.18) : mode == .nod ? band(et, 0.1, 0.08, 0.68, 0.1) : 0
        return pose
    }
}

/// The Mac's drawFrame for the phone's states and emotes: the tesseract, its halo, and the two soft-light eyes.
enum CharacterPainter {
    private struct RGB {
        var r, g, b: Double
        init(_ r: Double, _ g: Double, _ b: Double) { (self.r, self.g, self.b) = (r, g, b) }
        init(_ color: Color, in environment: EnvironmentValues) {
            let resolved = color.resolve(in: environment)
            self.init(Double(resolved.red) * 255, Double(resolved.green) * 255, Double(resolved.blue) * 255)
        }
        func mix(_ other: RGB, _ t: Double) -> RGB { RGB(r + (other.r - r) * t, g + (other.g - g) * t, b + (other.b - b) * t) }
        func color(_ opacity: Double) -> Color { Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: opacity) }
    }
    private struct Point { var x, y, depth, w: Double }

    private static let edges: [(Int, Int)] = (0..<16).flatMap { i in
        (i + 1..<16).filter { j in (i ^ j).nonzeroBitCount == 1 }.map { (i, $0) }
    }
    /// The listening form: two counter-rotating hexagons, and the inner square's vertices sinking to the centre.
    private static let rings = [[0, 1, 5, 4, 12, 8], [9, 11, 10, 14, 15, 13], [2, 3, 7, 6]]
    private static let slots: [(ring: Int, k: Int, n: Int)] = (0..<16).map { vertex in
        let ring = rings.firstIndex { $0.contains(vertex) }!
        return (ring, rings[ring].firstIndex(of: vertex)!, rings[ring].count)
    }
    private static let ringEdge = edges.map { p, q in
        let a = slots[p], b = slots[q]
        return a.ring == b.ring && a.ring < 2 && ((a.k + 1) % a.n == b.k || (b.k + 1) % b.n == a.k)
    }

    private struct Primitives {
        var edgeAlpha = [Double](repeating: 0, count: 32), edgeMix = [Double](repeating: 0, count: 32)
        var edgeCore = [Double](repeating: 0, count: 32), edgeSkip = [Bool](repeating: true, count: 32)
        var dotAlpha = [Double](repeating: 0, count: 16), dotMix = [Double](repeating: 0, count: 16)
        var dotR = [Double](repeating: 0, count: 16), dotCore = [Double](repeating: 0, count: 16)
    }

    static func draw(_ p: CharacterPose, in context: inout GraphicsContext, size: CGSize) {
        let s = min(size.width, size.height), c = s / 2
        context.translateBy(x: (size.width - s) / 2, y: (size.height - s) / 2)
        let environment = context.environment
        let acc = RGB(PhoneTheme.wire, in: environment), dim = RGB(PhoneTheme.wireDim, in: environment)
        let hot = RGB(PhoneTheme.wireHot, in: environment), bg = RGB(PhoneTheme.background, in: environment)
        let boost = PhoneTheme.wireBoost(environment.colorScheme), haloBoost = PhoneTheme.haloBoost(environment.colorScheme)
        let cur = p.cur, heat = p.heat, now = p.milliseconds, et = p.progress
        let bright = acc.mix(hot, heat), dimUse = dim.mix(RGB(hot.r * 0.55, hot.g * 0.5, hot.b * 0.45), heat)
        let breathe = 1 + cur.breath * sin(now / 650)
        let R = s * 0.27 * breathe * cur.scale

        // The greeting's bow and the nod's pitch and dip, baked into the projected points.
        var rotation = 0.0, ty = 0.0, sx = 1.0, sy = 1.0, pitch = 0.0, replyGlow = 0.0
        if p.mode == .greet {
            let bow = sin(min(1, et / 0.55) * .pi) * 0.14
            rotation = bow * 0.5; ty = bow * s * 0.12
        } else if p.mode == .nod {
            let n = nodBeat(et)
            pitch = -0.5 * n; ty = 0.045 * n * s; sx = 1 + 0.02 * n; sy = 1 - 0.04 * n
            replyGlow = pulse(et, 0.05, 0.3) * 0.8
        }
        let poseCos = cos(rotation), poseSin = sin(rotation)
        func posed(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
            let dx = (x - c) * sx, dy = (y - c) * sy
            return (c + dx * poseCos - dy * poseSin, c + ty + dx * poseSin + dy * poseCos)
        }

        // The ambient glow, breathing while listening.
        let glowA = haloBoost * cur.glow * (0.1 + heat * 0.16 + cur.breath * 0.6 * (0.5 + 0.5 * sin(now / 650))) + replyGlow * 0.18
        context.fill(Path(CGRect(x: 0, y: 0, width: s, height: s)), with: .radialGradient(
            Gradient(colors: [bright.color(glowA), bright.color(0)]), center: CGPoint(x: c, y: c), startRadius: 0, endRadius: s / 2))

        // Rotate xw and yz, then project 4D to 3D to 2D.
        let ca = cos(p.a), sa = sin(p.a), cb = cos(p.b + pitch), sb = sin(p.b + pitch)
        var points = (0..<16).map { i -> Point in
            let x: Double = i & 1 != 0 ? 1 : -1, y: Double = i & 2 != 0 ? 1 : -1
            let z: Double = i & 4 != 0 ? 1 : -1, w: Double = i & 8 != 0 ? 1 : -1
            let x1 = x * ca - w * sa, w1 = x * sa + w * ca, y1 = y * cb - z * sb, z1 = y * sb + z * cb
            let k4 = 2.6 / (2.6 - w1 * 0.55), k3 = 3.4 / (3.4 - z1 * k4 * 0.5)
            return Point(x: c + x1 * k4 * k3 * R * 0.5, y: c + y1 * k4 * k3 * R * 0.5, depth: (k4 + k3) / 2, w: w1)
        }
        let f = cur.flat * cur.flat * (3 - 2 * cur.flat)
        if f > 0.001 {
            let rf = s * 0.4 * breathe
            for i in 0..<16 {
                let slot = slots[i]
                if slot.ring == 2 {
                    points[i].x += (c - points[i].x) * f; points[i].y += (c - points[i].y) * f
                    continue
                }
                let angle = (slot.ring == 0 ? 1 : -1) * p.hs + Double(slot.k) / Double(slot.n) * 2 * .pi - .pi / 2
                let radius = (slot.ring == 0 ? 1 : 0.62) * rf
                points[i].x += (c + cos(angle) * radius - points[i].x) * f
                points[i].y += (c + sin(angle) * radius - points[i].y) * f
            }
        }
        for i in 0..<16 { (points[i].x, points[i].y) = posed(points[i].x, points[i].y) }

        // Resolve every edge and dot once; the halo and the crisp pass both replay them.
        let neon = heat
        var prims = Primitives()
        for (i, (p0, q0)) in edges.enumerated() {
            let P = points[p0], Q = points[q0]
            let depth = (P.depth + Q.depth) / 2 - 0.9
            var alpha = max(0.3, min(0.9, 0.35 + depth * 0.5)) * boost
            if cur.shimmer > 0 { alpha *= 1 - cur.shimmer * 0.3 * (0.5 + 0.5 * sin(now / 240 + Double(i) * 2.7)) }
            if !ringEdge[i] {
                alpha *= 1 - f
            } else {
                alpha += (min(1, 0.85 * boost) - alpha) * f
            }
            if alpha < 0.02 { continue }
            let m = max(clamp01(0.5 + (P.w + Q.w) * 0.35), f * 0.9)
            prims.edgeSkip[i] = false
            prims.edgeMix[i] = m
            prims.edgeAlpha[i] = min(1, alpha * (0.85 + 0.15 * m))
            prims.edgeCore[i] = neon > 0.02 && m > 0.5 ? min(1, alpha) * neon * 0.85 : 0
        }
        for i in 0..<16 {
            let P = points[i]
            let fade = slots[i].ring == 2 ? 1 - f : 1
            let pulseK = 1 + cur.pulse * 0.6 * max(0, sin(now / 300 + Double(i) * 0.8))
            let m = max(clamp01(0.5 + P.w * 0.6), f)
            prims.dotMix[i] = m
            prims.dotR[i] = (2.1 + 0.7 * m) * pulseK * (s / 280)
            prims.dotAlpha[i] = min(1, max(0.65, min(1, 0.6 + (P.depth - 0.9) * 0.5)) * boost) * fade
            prims.dotCore[i] = heat > 0.02 && m > 0.4 && fade > 0.5 ? heat * fade : 0
        }

        // The halo: every hot primitive in one tint, accumulated, blurred once and laid under the wires.
        let halo = min(1.6, neon * haloBoost)
        if halo > 0.02 {
            var glow = context
            glow.addFilter(.blur(radius: 7 * halo * (s / 280)))
            glow.opacity = min(1, 0.9 * halo)
            let tint = hot.mix(RGB(255, 236, 200), 0.3)
            glow.drawLayer { mask in
                mask.blendMode = .plusLighter
                paint(prims, points, in: &mask) { _, _ in tint }
            }
        }
        paint(prims, points, in: &context) { kind, mix in
            switch kind {
            case .edge: dimUse.mix(bright, mix)
            case .edgeCore: bright.mix(RGB(255, 244, 224), 0.75)
            case .dot: dimUse.mix(bright, max(mix, 0.35))
            case .dotCore: bright.mix(RGB(255, 248, 235), 0.8)
            }
        }

        // The eyes: two soft lights in the inner cell, with white-hot cores, on the wires' colour family.
        let eyeBase = acc.mix(hot, heat), eyeCol = eyeBase.mix(RGB(255, 246, 230), 0.45)
        let gxo = p.eyeX * R * 0.1, gyo = p.eyeY * R * 0.08
        let pxo = sin(p.a) * R * 0.05 * (1 - f), pyo = sin(p.b * 0.8) * R * 0.04 * (1 - f)
        for side in [-1.0, 1.0] {
            let e = posed(c + side * R * 0.34 + gxo + pxo, c - R * 0.1 + gyo + pyo)
            let lid = max(p.lid, side == 1 ? p.wink : 0)
            let open = (1 - lid) * cur.eyeScale
            let rw = R * 0.085 * cur.eyeScale
            let socket = rw * 3.2
            context.fill(circle(e.x, e.y, socket), with: .radialGradient(Gradient(colors: [bg.color(0.75), bg.color(0)]),
                center: CGPoint(x: e.x, y: e.y), startRadius: 0, endRadius: socket))
            if p.happy > 0.5 {
                var arc = Path()
                for k in 0...16 {
                    let angle = Double.pi * (1.15 + 0.7 * Double(k) / 16)
                    let point = CGPoint(x: e.x + cos(angle) * rw * 1.15, y: e.y + rw * 0.7 + sin(angle) * rw * 1.15)
                    if k == 0 { arc.move(to: point) } else { arc.addLine(to: point) }
                }
                context.stroke(arc, with: .color(eyeCol.color(0.95)), style: StrokeStyle(lineWidth: max(1.4, rw * 0.5), lineCap: .round, lineJoin: .round))
            } else if open < 0.12 {
                var line = Path()
                line.move(to: CGPoint(x: e.x - rw, y: e.y)); line.addLine(to: CGPoint(x: e.x + rw, y: e.y))
                context.stroke(line, with: .color(eyeCol.color(0.8)), style: StrokeStyle(lineWidth: max(1.2, rw * 0.4), lineCap: .round))
            } else {
                let rh = rw * 1.35 * max(0.1, open), glowR = rw * 2.1
                context.fill(circle(e.x, e.y, glowR), with: .radialGradient(
                    Gradient(stops: [.init(color: eyeCol.color(0.95), location: 0), .init(color: eyeBase.color(0.5), location: 0.45),
                                     .init(color: eyeBase.color(0), location: 1)]),
                    center: CGPoint(x: e.x, y: e.y), startRadius: 0, endRadius: glowR))
                // The core leads the light along the gaze by half its offset, the Mac's resting pupil shift.
                let core = CGRect(x: e.x + gxo * 0.5 - rw * 0.62, y: e.y + gyo * 0.5 - rh * 0.62, width: rw * 1.24, height: rh * 1.24)
                context.fill(Path(ellipseIn: core), with: .color(RGB(255, 248, 235).color(0.95)))
            }
        }
    }

    private enum Kind { case edge, edgeCore, dot, dotCore }

    private static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path {
        Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
    }

    /// Replays the resolved edges, their filament cores, the dots and their incandescent cores.
    private static func paint(_ prims: Primitives, _ points: [Point], in context: inout GraphicsContext,
                              color: (Kind, Double) -> RGB) {
        let wire = StrokeStyle(lineWidth: 1.4, lineCap: .round), filament = StrokeStyle(lineWidth: 0.7, lineCap: .round)
        for (i, (p, q)) in edges.enumerated() where !prims.edgeSkip[i] {
            var line = Path()
            line.move(to: CGPoint(x: points[p].x, y: points[p].y)); line.addLine(to: CGPoint(x: points[q].x, y: points[q].y))
            context.stroke(line, with: .color(color(.edge, prims.edgeMix[i]).color(prims.edgeAlpha[i])), style: wire)
            if prims.edgeCore[i] > 0 {
                context.stroke(line, with: .color(color(.edgeCore, 0).color(prims.edgeCore[i])), style: filament)
            }
        }
        for i in 0..<16 where prims.dotAlpha[i] > 0.01 {
            let P = points[i], r = prims.dotR[i]
            context.fill(circle(P.x, P.y, r), with: .color(color(.dot, prims.dotMix[i]).color(prims.dotAlpha[i])))
            if prims.dotCore[i] > 0 {
                context.fill(circle(P.x, P.y, r * 0.45), with: .color(color(.dotCore, 0).color(prims.dotCore[i])))
            }
        }
    }
}
