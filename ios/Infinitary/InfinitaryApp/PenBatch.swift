import CoreGraphics
import SwiftUI
import simd

/// One shape for the graphics chip (`ScenePenShaders`' `PenInstance`, float for float): a quad bounding it in target
/// pixels, its exact geometry and its paint.
struct PenInstance {
    enum Kind: Float { case ellipse = 0, ring = 1, segment = 2, polygon = 3, layer = 4 }
    var quad = SIMD4<Float>.zero
    var quadV = SIMD4<Float>.zero
    var geo0 = SIMD4<Float>.zero
    var geo1 = SIMD4<Float>.zero
    var geo2 = SIMD4<Float>.zero
    var paint = SIMD4<Float>.zero
    var paintGeo = SIMD4<Float>.zero
    var color0 = SIMD4<Float>.zero
    var color1 = SIMD4<Float>.zero
    var color2 = SIMD4<Float>.zero
    var color3 = SIMD4<Float>.zero
    var stops = SIMD4<Float>.zero

    var kind: Kind { Kind(rawValue: quadV.z) ?? .polygon }
}

/// INF-3851 piece 2, the captain's "Our own graphics-chip pen": what `ScenePen` records instead of painting when it
/// draws for the scene's render thread. Each fill and stroke becomes instance records - exact discs, ellipses and
/// rings, line pieces that know their neighbours, convex polygons - in the order the painters drew them, which
/// `ScenePenGPU` draws in one pass. Dashes are cut on the processor; a blurred layer is a target of its own.
final class PenBatch {
    enum Blend { case normal, additive }

    /// One surface the batch draws: the frame itself (target 0), or a blurred layer laid over the target that made it.
    struct Target {
        var width = 0, height = 0
        var instances: [PenInstance] = []
        /// Where each run of one blend starts, in `instances`.
        var runs: [(start: Int, blend: Blend)] = []
        /// A layer's box blur: the half width of each of its three passes, in the layer's pixels; 0 draws it unblurred.
        var blurHalf = 0
    }

    private(set) var targets: [Target] = [Target()]
    private(set) var targetCount = 1
    /// The corners of every polygon, which its instance names by first index and count.
    private(set) var points: [SIMD2<Float>] = []

    /// Device pixels per point of the frame.
    private(set) var scale: CGFloat = 1

    /// Starts a new frame `width` by `height` pixels, keeping every buffer's capacity.
    func reset(width: Int, height: Int, scale: CGFloat) {
        for index in 0..<targetCount {
            targets[index].instances.removeAll(keepingCapacity: true)
            targets[index].runs.removeAll(keepingCapacity: true)
        }
        targetCount = 1
        targets[0].width = width; targets[0].height = height; targets[0].blurHalf = 0
        points.removeAll(keepingCapacity: true)
        self.scale = scale
    }

    /// A new layer `width` by `height` pixels; the pen that made it then lays it over its own target.
    func addLayer(width: Int, height: Int, blurHalf: Int) -> Int {
        if targetCount == targets.count { targets.append(Target()) }
        let index = targetCount
        targetCount += 1
        targets[index].width = width; targets[index].height = height; targets[index].blurHalf = blurHalf
        return index
    }

    private func append(_ instance: PenInstance, to target: Int, blend: Blend) {
        if targets[target].runs.last?.blend != blend || instance.kind == .layer || targets[target].instances.last?.kind == .layer {
            targets[target].runs.append((targets[target].instances.count, blend))
        }
        targets[target].instances.append(instance)
    }

    // MARK: recording

    /// Scratch the recording reuses from shape to shape and frame to frame, so a frame allocates nothing once warm.
    private var elements: [Path.Element] = []
    private var flat = PenOutline.Flattened(), dashes = PenOutline.Flattened()

    private func read(_ path: Path) {
        var read = elements
        elements = []
        read.removeAll(keepingCapacity: true)
        path.forEach { read.append($0) }
        elements = read
    }

    func fill(_ path: Path, with shading: ScenePen.Shading, opacity: Double, blend: Blend, transform m: CGAffineTransform, target: Int) {
        let paint = Paint(shading, opacity: opacity, transform: m)
        guard paint.visible else { return }
        read(path)
        if let ellipse = PenOutline.ellipse(elements) {
            let center = ellipse.center.applying(m), k = PenOutline.scale(m)
            let r = SIMD2<Float>(Float(ellipse.radii.width * k), Float(ellipse.radii.height * k))
            guard r.x > 0, r.y > 0 else { return }
            var instance = paint.instance(kind: .ellipse)
            instance.geo0 = SIMD4(Float(center.x), Float(center.y), r.x, r.y)
            let reach = SIMD2<Float>(r.x + 1, r.y + 1), at = SIMD2<Float>(Float(center.x), Float(center.y))
            Self.box(&instance, from: at - reach, to: at + reach)
            append(instance, to: target, blend: blend)
            return
        }
        PenOutline.flatten(elements, m, tolerance: Self.tolerance, into: &flat)
        for outline in flat.outlines where outline.count >= 3 {
            var instance = paint.instance(kind: .polygon)
            let first = points.count
            var low = flat.points[outline.start], high = low, area: Float = 0
            for index in 0..<outline.count {
                let point = flat.points[outline.start + index], next = flat.points[outline.start + (index + 1) % outline.count]
                points.append(point)
                low = simd_min(low, point); high = simd_max(high, point)
                area += point.x * next.y - next.x * point.y
            }
            guard area != 0 else { points.removeLast(outline.count); continue }
            instance.geo0 = SIMD4(Float(first), Float(outline.count), area > 0 ? 1 : -1, 0)
            Self.box(&instance, from: low - 1, to: high + 1)
            append(instance, to: target, blend: blend)
        }
    }

    func stroke(_ path: Path, with shading: ScenePen.Shading, style: StrokeStyle, opacity: Double, blend: Blend,
                transform m: CGAffineTransform, target: Int) {
        let paint = Paint(shading, opacity: opacity, transform: m)
        guard paint.visible, style.lineWidth > 0 else { return }
        let k = PenOutline.scale(m), half = Float(style.lineWidth * k / 2)
        read(path)
        if style.dash.isEmpty, let ellipse = PenOutline.ellipse(elements), abs(ellipse.radii.width - ellipse.radii.height) <= 1e-6 * ellipse.radii.width {
            let center = ellipse.center.applying(m), radius = Float(ellipse.radii.width * k)
            var instance = paint.instance(kind: .ring)
            instance.geo0 = SIMD4(Float(center.x), Float(center.y), radius, half)
            let reach = SIMD2<Float>(repeating: radius + half + 1), at = SIMD2<Float>(Float(center.x), Float(center.y))
            Self.box(&instance, from: at - reach, to: at + reach)
            append(instance, to: target, blend: blend)
            return
        }
        let cap: Float = switch style.lineCap { case .round: 1; case .square: 2; default: 0 }
        PenOutline.flatten(elements, m, tolerance: Self.tolerance, into: &flat)
        if style.dash.isEmpty {
            for outline in flat.outlines { line(flat.points, outline, half: half, cap: cap, paint: paint, blend: blend, target: target) }
        } else {
            let lengths = style.dash.map { Float($0 * k) }
            dashes.clear()
            for outline in flat.outlines { PenOutline.dash(flat.points, outline, lengths: lengths, phase: Float(style.dashPhase * k), into: &dashes) }
            for outline in dashes.outlines { line(dashes.points, outline, half: half, cap: cap, paint: paint, blend: blend, target: target) }
        }
    }

    /// Lays a layer over `target`, its texture stretched over `rect` in the pen's space, as Core Graphics draws an image.
    func lay(_ layer: Int, over rect: CGRect, opacity: Double, blend: Blend, transform m: CGAffineTransform, target: Int) {
        guard opacity > 0 else { return }
        var instance = PenInstance()
        let origin = CGPoint(x: rect.minX, y: rect.minY).applying(m)
        let right = CGPoint(x: rect.maxX, y: rect.minY).applying(m), down = CGPoint(x: rect.minX, y: rect.maxY).applying(m)
        instance.quad = SIMD4(Float(origin.x), Float(origin.y), Float(right.x - origin.x), Float(right.y - origin.y))
        instance.quadV = SIMD4(Float(down.x - origin.x), Float(down.y - origin.y), PenInstance.Kind.layer.rawValue, 0)
        instance.geo0 = SIMD4(1, 1, Float(layer), 0)
        instance.paint = SIMD4(0, 1, Float(opacity), 0)
        append(instance, to: target, blend: blend)
    }

    /// The flattening tolerance, in target pixels: a tenth of a pixel's error at most, which no reading separates.
    private static let tolerance: Float = 0.1

    /// One line, piece by piece: each piece carries the points before and after it so the shader splits their
    /// joint along the mitre line, and every pixel of a translucent line is painted once.
    private func line(_ all: [SIMD2<Float>], _ outline: PenOutline.Outline, half: Float, cap: Float, paint: Paint, blend: Blend, target: Int) {
        var count = outline.count
        guard count > 0 else { return }
        func p(_ index: Int) -> SIMD2<Float> { all[outline.start + index] }
        if outline.closed, count > 1, simd_distance(p(0), p(count - 1)) < 1e-4 { count -= 1 }
        if count == 1 {
            // A line of no length draws only its round cap, as Core Graphics does.
            guard cap == 1 else { return }
            var instance = paint.instance(kind: .ellipse)
            instance.geo0 = SIMD4(p(0).x, p(0).y, half, half)
            Self.box(&instance, from: p(0) - (half + 1), to: p(0) + (half + 1))
            append(instance, to: target, blend: blend)
            return
        }
        let pieces = outline.closed && count > 2 ? count : count - 1
        guard pieces > 0 else { return }
        for index in 0..<pieces {
            let a = p(index), b = p((index + 1) % count)
            let hasPrev = outline.closed && count > 2 || index > 0
            let hasNext = outline.closed && count > 2 || index < pieces - 1
            let before = p((index - 1 + count) % count), after = p((index + 2) % count)
            var instance = paint.instance(kind: .segment)
            instance.quadV.w = Float((hasPrev ? 1 : 0) | (hasNext ? 2 : 0))
            instance.geo0 = SIMD4(a.x, a.y, b.x, b.y)
            instance.geo1 = SIMD4(before.x, before.y, after.x, after.y)
            instance.geo2 = SIMD4(half, cap, cap, 0)
            let length = simd_distance(a, b)
            let dir = length > 0 ? (b - a) / length : SIMD2<Float>(1, 0), normal = SIMD2<Float>(-dir.y, dir.x)
            // The quad reaches past each end by the width (a round joint or cap) and one pixel for the soft edge.
            let ext = half + 1
            let origin = a - dir * ext - normal * ext
            instance.quad = SIMD4(origin.x, origin.y, dir.x * (length + 2 * ext), dir.y * (length + 2 * ext))
            instance.quadV.x = normal.x * 2 * ext; instance.quadV.y = normal.y * 2 * ext
            append(instance, to: target, blend: blend)
        }
    }

    private static func box(_ instance: inout PenInstance, from low: SIMD2<Float>, to high: SIMD2<Float>) {
        instance.quad = SIMD4(low.x, low.y, high.x - low.x, 0)
        instance.quadV.x = 0; instance.quadV.y = high.y - low.y
    }

    /// A shading in target pixels, with straight sRGB colours and up to four stops, held without allocating.
    private struct Paint {
        var kind: Float = 0
        var colors = (SIMD4<Float>.zero, SIMD4<Float>.zero, SIMD4<Float>.zero, SIMD4<Float>.zero)
        var stops = SIMD4<Float>.zero
        var count = 0
        var geo = SIMD4<Float>.zero
        let opacity: Float
        var visible = false

        init(_ shading: ScenePen.Shading, opacity: Double, transform m: CGAffineTransform) {
            self.opacity = Float(opacity)
            switch shading {
            case .color(let color):
                set(CollectionOfOne((color, CGFloat(0))))
            case .radialGradient(let gradient, let center, let start, let end):
                let k = PenOutline.scale(m), at = center.applying(m)
                kind = 1; geo = SIMD4(Float(at.x), Float(at.y), Float(start * k), Float(end * k))
                set(gradient.stops.lazy.map { ($0.color, $0.location) })
            case .linearGradient(let gradient, let from, let to):
                let a = from.applying(m), b = to.applying(m)
                kind = 2; geo = SIMD4(Float(a.x), Float(a.y), Float(b.x), Float(b.y))
                set(gradient.stops.lazy.map { ($0.color, $0.location) })
            }
        }

        /// The painters use at most three stops; a fourth is the shader's limit, and the last repeats to fill it.
        private mutating func set<S: Sequence>(_ given: S) where S.Element == (PenColor, CGFloat) {
            var shown = false
            for (color, location) in given.prefix(4) {
                let rgba = SIMD4(Float(color.red), Float(color.green), Float(color.blue), Float(max(0, min(1, color.alpha))))
                shown = shown || rgba.w > 0
                for slot in count..<4 {
                    switch slot { case 0: colors.0 = rgba; case 1: colors.1 = rgba; case 2: colors.2 = rgba; default: colors.3 = rgba }
                    stops[slot] = Float(location)
                }
                count += 1
            }
            visible = opacity > 0 && shown
        }

        func instance(kind shape: PenInstance.Kind) -> PenInstance {
            var instance = PenInstance()
            instance.quadV.z = shape.rawValue
            instance.paint = SIMD4(kind, Float(count), opacity, 0)
            instance.paintGeo = geo
            (instance.color0, instance.color1, instance.color2, instance.color3) = colors
            instance.stops = count == 0 ? SIMD4(0, 1, 1, 1) : stops
            return instance
        }
    }
}

/// Reading a SwiftUI path's elements: whether they are exactly an ellipse, as `Path(ellipseIn:)` makes one, and its
/// outlines flattened into points in target pixels.
enum PenOutline {
    /// One subpath's points, `count` of them from `start` in its `Flattened`'s points.
    struct Outline { var start: Int; var count: Int; var closed: Bool }

    /// Every subpath of a path, in one buffer of points kept from shape to shape.
    struct Flattened {
        var points: [SIMD2<Float>] = []
        var outlines: [Outline] = []
        mutating func clear() { points.removeAll(keepingCapacity: true); outlines.removeAll(keepingCapacity: true) }
        fileprivate mutating func begin(_ p: SIMD2<Float>) { outlines.append(Outline(start: points.count, count: 1, closed: false)); points.append(p) }
        fileprivate mutating func add(_ p: SIMD2<Float>) {
            if let last = points.last, simd_distance(last, p) <= 1e-4 { return }
            points.append(p); outlines[outlines.count - 1].count += 1
        }
    }

    /// The scale of a transform that only moves, turns and scales evenly, as every pen transform does.
    static func scale(_ m: CGAffineTransform) -> CGFloat { hypot(m.a, m.b) }

    /// The ellipse `elements` draw, when they are a move, four quarter curves through the ellipse's four ends with every
    /// control point on its bounding box, and a close: the shape `Path(ellipseIn:)` makes.
    static func ellipse(_ elements: [Path.Element]) -> (center: CGPoint, radii: CGSize)? {
        guard elements.count == 6, case .move(let start) = elements[0], case .closeSubpath = elements[5] else { return nil }
        var minX = start.x, maxX = start.x, minY = start.y, maxY = start.y
        for index in 1...4 {
            guard case .curve(let to, _, _) = elements[index] else { return nil }
            minX = min(minX, to.x); maxX = max(maxX, to.x); minY = min(minY, to.y); maxY = max(maxY, to.y)
        }
        guard maxX > minX, maxY > minY else { return nil }
        let center = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
        let epsilon = 1e-6 * max(maxX - minX, maxY - minY)
        func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) <= epsilon }
        func onBox(_ p: CGPoint) -> Bool { near(p.x, minX) || near(p.x, maxX) || near(p.y, minY) || near(p.y, maxY) }
        /// Which of the four axis ends a point is, or nil when it is none of them.
        func axisEnd(_ p: CGPoint) -> Int? {
            if near(p.x, maxX), near(p.y, center.y) { return 0 }
            if near(p.x, center.x), near(p.y, maxY) { return 1 }
            if near(p.x, minX), near(p.y, center.y) { return 2 }
            if near(p.x, center.x), near(p.y, minY) { return 3 }
            return nil
        }
        guard let first = axisEnd(start) else { return nil }
        var seen = 1 << first, end = start
        for index in 1...4 {
            guard case .curve(let to, let c1, let c2) = elements[index], let which = axisEnd(to), onBox(c1), onBox(c2) else { return nil }
            if index < 4 { seen |= 1 << which }
            end = to
        }
        guard seen == 0b1111, near(end.x, start.x), near(end.y, start.y) else { return nil }
        return (center, CGSize(width: (maxX - minX) / 2, height: (maxY - minY) / 2))
    }

    /// Each subpath as points in target pixels, every curve cut into pieces no farther than `tolerance` from it.
    static func flatten(_ elements: [Path.Element], _ m: CGAffineTransform, tolerance: Float, into result: inout Flattened) {
        result.clear()
        var start = SIMD2<Float>.zero, open = false
        func point(_ p: CGPoint) -> SIMD2<Float> { let at = p.applying(m); return SIMD2(Float(at.x), Float(at.y)) }
        for element in elements {
            switch element {
            case .move(let to):
                start = point(to); result.begin(start); open = true
            case .line(let to):
                if !open { result.begin(start); open = true }
                result.add(point(to))
            case .quadCurve(let to, let control):
                if !open { result.begin(start); open = true }
                let p0 = result.points[result.points.count - 1], p1 = point(control), p2 = point(to)
                let n = max(1, Int(ceil(sqrt(0.25 * simd_length(p0 - 2 * p1 + p2) / tolerance))))
                for step in 1...n {
                    let t = Float(step) / Float(n), u = 1 - t
                    result.add(u * u * p0 + 2 * u * t * p1 + t * t * p2)
                }
            case .curve(let to, let control1, let control2):
                if !open { result.begin(start); open = true }
                let p0 = result.points[result.points.count - 1], p1 = point(control1), p2 = point(control2), p3 = point(to)
                let bend = max(simd_length(p0 - 2 * p1 + p2), simd_length(p1 - 2 * p2 + p3))
                let n = max(1, min(256, Int(ceil(sqrt(0.75 * bend / tolerance)))))
                for step in 1...n {
                    let t = Float(step) / Float(n), u = 1 - t
                    result.add(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3)
                }
            case .closeSubpath:
                if open { result.outlines[result.outlines.count - 1].closed = true }
                open = false
            }
        }
    }

    /// The dashes of one outline, cut by length as Core Graphics cuts them: the pattern starts again on each subpath.
    static func dash(_ all: [SIMD2<Float>], _ outline: Outline, lengths: [Float], phase: Float, into result: inout Flattened) {
        let pattern = lengths.map { max(0, $0) }, total = pattern.reduce(0, +)
        func copyWhole() {
            result.begin(all[outline.start])
            for index in 1..<max(1, outline.count) { result.add(all[outline.start + index]) }
            if outline.closed { result.outlines[result.outlines.count - 1].closed = true }
        }
        guard total > 0, outline.count > 1 else { if outline.count > 0 { copyWhole() }; return }
        let count = outline.closed ? outline.count + 1 : outline.count
        func p(_ index: Int) -> SIMD2<Float> { all[outline.start + index % outline.count] }
        var index = 0, left = pattern[0], on = true
        var offset = phase.truncatingRemainder(dividingBy: total)
        if offset < 0 { offset += total }
        while offset > 0 {
            if offset >= left { offset -= left; index = (index + 1) % pattern.count; left = pattern[index]; on.toggle() }
            else { left -= offset; offset = 0 }
        }
        /// Points of the dash being cut, kept out of `result` until it has two.
        var pending = on ? 1 : 0, first = p(0)
        func put(_ q: SIMD2<Float>) {
            if pending == 1 { result.begin(first); pending = 2 }
            if pending == 2 { result.add(q) }
        }
        for k in 1..<count {
            var from = p(k - 1)
            let to = p(k)
            var remaining = simd_distance(from, to)
            while remaining > 0 {
                if left >= remaining {
                    left -= remaining; remaining = 0
                    if on { put(to) }
                } else {
                    let cut = from + (to - from) * (left / remaining)
                    remaining -= left; from = cut
                    if on { put(cut); pending = 0 }
                    else { first = cut; pending = 1 }
                    on.toggle(); index = (index + 1) % pattern.count; left = pattern[index]
                }
            }
        }
    }
}
