import Accelerate
import CoreGraphics
import SwiftUI

/// INF-2566 (approved B): the scene's painters draw through this pen, so the same drawing runs in a SwiftUI Canvas
/// (through `withCGContext`) and on the scene's own render thread, which SwiftUI's `GraphicsContext` cannot reach.
/// It keeps `GraphicsContext`'s value semantics: a copy carries its own transform, opacity and blend mode.
/// It has two surfaces (INF-3851 piece 2, the captain's "Our own graphics-chip pen"): a Core Graphics context, where
/// every operation applies them to the shared context and puts it back, for a Canvas, the first screen and the tests'
/// pictures; and a `PenBatch`, which records each operation for the graphics chip, for the scene's render thread.
struct ScenePen {
    enum Shading {
        case color(PenColor)
        case radialGradient(PenGradient, center: CGPoint, startRadius: CGFloat, endRadius: CGFloat)
        case linearGradient(PenGradient, startPoint: CGPoint, endPoint: CGPoint)
    }

    private enum Surface {
        case cg(CGContext)
        /// The batch, the target it records into and that target's pixels per pen unit.
        case batch(PenBatch, target: Int, device: CGAffineTransform)
    }
    private let surface: Surface
    var opacity = 1.0
    var blendMode = CGBlendMode.normal
    private(set) var transform = CGAffineTransform.identity
    /// Device pixels per point, which only the blurred layer reads to choose its own resolution.
    let scale: CGFloat

    init(_ cg: CGContext) {
        surface = .cg(cg)
        let device = cg.userSpaceToDeviceSpaceTransform
        scale = max(1, hypot(device.a, device.b))
    }

    /// A pen that records into `batch`'s frame, drawing top down in points at the batch's scale.
    init(_ batch: PenBatch) {
        self.init(batch, target: 0, device: CGAffineTransform(scaleX: batch.scale, y: batch.scale))
    }

    private init(_ batch: PenBatch, target: Int, device: CGAffineTransform) {
        surface = .batch(batch, target: target, device: device)
        scale = max(1, hypot(device.a, device.b))
    }

    /// Only the two blends the painters use reach the graphics chip; plus lighter adds, as the halo does.
    private var blend: PenBatch.Blend { blendMode == .plusLighter ? .additive : .normal }

    mutating func translateBy(x: CGFloat, y: CGFloat) { transform = transform.translatedBy(x: x, y: y) }

    func fill(_ path: Path, with shading: Shading) {
        guard opacity > 0 else { return }
        if case .batch(let batch, let target, let device) = surface {
            batch.fill(path, with: shading, opacity: opacity, blend: blend, transform: transform.concatenating(device), target: target)
            return
        }
        apply { cg in
            switch shading {
            case .color(let color):
                cg.setFillColor(color.cg)
                cg.addPath(path.cgPath); cg.fillPath()
            case .radialGradient(let gradient, let center, let start, let end):
                cg.addPath(path.cgPath); cg.clip()
                cg.drawRadialGradient(gradient.cg, startCenter: center, startRadius: start, endCenter: center, endRadius: end,
                                      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            case .linearGradient(let gradient, let from, let to):
                cg.addPath(path.cgPath); cg.clip()
                cg.drawLinearGradient(gradient.cg, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
        }
    }

    func stroke(_ path: Path, with shading: Shading, lineWidth: CGFloat = 1) {
        stroke(path, with: shading, style: StrokeStyle(lineWidth: lineWidth))
    }

    func stroke(_ path: Path, with shading: Shading, style: StrokeStyle) {
        guard opacity > 0 else { return }
        if case .batch(let batch, let target, let device) = surface {
            batch.stroke(path, with: shading, style: style, opacity: opacity, blend: blend, transform: transform.concatenating(device), target: target)
            return
        }
        apply { cg in
            cg.setLineWidth(style.lineWidth); cg.setLineCap(style.lineCap); cg.setLineJoin(style.lineJoin)
            cg.setMiterLimit(style.miterLimit)
            if !style.dash.isEmpty { cg.setLineDash(phase: style.dashPhase, lengths: style.dash) }
            cg.addPath(path.cgPath)
            switch shading {
            case .color(let color):
                cg.setStrokeColor(color.cg); cg.strokePath()
            case .radialGradient(let gradient, let center, let start, let end):
                cg.replacePathWithStrokedPath(); cg.clip()
                cg.drawRadialGradient(gradient.cg, startCenter: center, startRadius: start, endCenter: center, endRadius: end,
                                      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            case .linearGradient(let gradient, let from, let to):
                cg.replacePathWithStrokedPath(); cg.clip()
                cg.drawLinearGradient(gradient.cg, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
        }
    }

    /// `GraphicsContext`'s blurred layer: `draw` paints into its own transparent layer over `bounds` (in this pen's
    /// space), which is blurred as SwiftUI's `.blur(radius:)` blurs (a Gaussian whose deviation is half the radius)
    /// and laid over this context at `opacity`.
    func blurredLayer(bounds: CGRect, radius: CGFloat, opacity layerOpacity: Double, draw: (inout ScenePen) -> Void) {
        guard opacity * layerOpacity > 0, radius > 0 else { return }
        let sigma = radius / 2, outer = bounds.insetBy(dx: -3 * sigma, dy: -3 * sigma)
        // A wide blur needs no more pixels than one point each; a narrow one keeps the screen's resolution.
        let resolution = min(scale, max(1, 3 / sigma))
        let width = Int((outer.width * resolution).rounded(.up)), height = Int((outer.height * resolution).rounded(.up))
        // Three box passes approximate the Gaussian: each pass's variance is (w² - 1) / 12.
        var box = Int((sqrt(4 * sigma * resolution * sigma * resolution + 1)).rounded())
        if box % 2 == 0 { box += 1 }
        guard width > 0, height > 0 else { return }
        if case .batch(let batch, let target, let device) = surface {
            // The graphics chip draws the layer into a texture of its own, blurs it with the same three box passes and
            // lays it over this target, stretched over the same rectangle.
            let layer = batch.addLayer(width: width, height: height, blurHalf: box > 1 ? box / 2 : 0)
            var inner = ScenePen(batch, target: layer,
                                 device: CGAffineTransform(translationX: -outer.minX, y: -outer.minY).concatenating(CGAffineTransform(scaleX: resolution, y: resolution)))
            draw(&inner)
            batch.lay(layer, over: outer, opacity: opacity * layerOpacity, blend: blend, transform: transform.concatenating(device), target: target)
            return
        }
        guard let layer = ScenePen.bitmap(width: width, height: height) else { return }
        layer.translateBy(x: 0, y: CGFloat(height)); layer.scaleBy(x: resolution, y: -resolution)
        layer.translateBy(x: -outer.minX, y: -outer.minY)
        var inner = ScenePen(layer)
        draw(&inner)
        guard let data = layer.data else { return }
        var source = vImage_Buffer(data: data, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: layer.bytesPerRow)
        guard let scratch = malloc(layer.bytesPerRow * height) else { return }
        defer { free(scratch) }
        var target = vImage_Buffer(data: scratch, height: source.height, width: source.width, rowBytes: layer.bytesPerRow)
        if box > 1 {
            for pass in 0..<3 {
                let (from, to) = pass % 2 == 0 ? (source, target) : (target, source)
                var input = from, output = to
                vImageBoxConvolve_ARGB8888(&input, &output, nil, 0, 0, UInt32(box), UInt32(box), nil, vImage_Flags(kvImageEdgeExtend))
            }
            // Three passes leave the result in the scratch buffer; copy it back to the layer's own memory.
            vImageCopyBuffer(&target, &source, 4, vImage_Flags(kvImageNoFlags))
        }
        guard let image = layer.makeImage() else { return }
        var over = self
        over.opacity *= layerOpacity
        // Both a Canvas and the render surface draw top down, so the image is flipped back upright over its rectangle.
        over.apply { cg in
            cg.translateBy(x: 0, y: outer.minY + outer.maxY); cg.scaleBy(x: 1, y: -1)
            cg.draw(image, in: outer)
        }
    }

    private func apply(_ body: (CGContext) -> Void) {
        guard case .cg(let cg) = surface else { return }
        cg.saveGState()
        cg.concatenate(transform)
        cg.setAlpha(opacity)
        cg.setBlendMode(blendMode)
        body(cg)
        cg.restoreGState()
    }

    /// A transparent premultiplied sRGB bitmap, the layout the render surface and the blurred layer share.
    static func bitmap(width: Int, height: Int, data: UnsafeMutableRawPointer? = nil, bytesPerRow: Int = 0) -> CGContext? {
        CGContext(data: data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: PenColor.space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    }
}

/// An sRGB color a render thread can use, since a SwiftUI `Color` resolves only through its environment.
struct PenColor: Sendable, Equatable {
    static let space = CGColorSpace(name: CGColorSpace.sRGB)!
    var red, green, blue, alpha: Double
    init(red: Double, green: Double, blue: Double, alpha: Double = 1) { (self.red, self.green, self.blue, self.alpha) = (red, green, blue, alpha) }
    init(_ color: Color, in environment: EnvironmentValues) {
        let resolved = color.resolve(in: environment)
        self.init(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue), alpha: Double(resolved.opacity))
    }
    func opacity(_ value: Double) -> PenColor { PenColor(red: red, green: green, blue: blue, alpha: alpha * value) }
    var cg: CGColor { CGColor(colorSpace: PenColor.space, components: [red, green, blue, max(0, min(1, alpha))])! }
}

struct PenGradient {
    struct Stop { var color: PenColor; var location: Double }
    var stops: [Stop]
    init(colors: [PenColor]) {
        stops = colors.enumerated().map { Stop(color: $1, location: colors.count > 1 ? Double($0) / Double(colors.count - 1) : 0) }
    }
    init(stops: [Stop]) { self.stops = stops }
    var cg: CGGradient {
        CGGradient(colorsSpace: PenColor.space, colors: stops.map(\.color.cg) as CFArray, locations: stops.map { CGFloat($0.location) })!
    }
}
