import Metal
import simd

/// INF-3851 piece 2: draws a `PenBatch` on the graphics chip (`ScenePenShaders`). Each blurred layer is drawn into a
/// small texture, blurred with three box passes each way and laid over its target; the frame itself is drawn
/// straight into the target texture, cleared by the pass, in the order the painters drew.
/// Colours stay sRGB-encoded and premultiplied, as the Core Graphics pen paints them, so the two pens blend alike.
final class ScenePenGPU {
    let device: MTLDevice
    private let shapes: [PenBatch.Blend: MTLRenderPipelineState]
    private let layers: MTLRenderPipelineState
    private let blur: MTLRenderPipelineState
    static let pixelFormat = MTLPixelFormat.bgra8Unorm

    /// What one frame in flight holds until the graphics chip is done with it.
    final class Slot {
        fileprivate var instances: MTLBuffer?
        fileprivate var points: MTLBuffer?
        /// Two textures per layer: the layer, and the scratch its blur passes alternate with.
        fileprivate var textures: [(MTLTexture, MTLTexture)] = []
    }

    /// The shaders compile once per process, on the thread that first needs them, never the main thread's.
    private static let compiled = NSLock()
    nonisolated(unsafe) private static var library: (device: MTLDevice, library: MTLLibrary)?

    init?(device: MTLDevice) {
        let library = Self.compiled.withLock { () -> MTLLibrary? in
            if let held = Self.library, held.device === device { return held.library }
            guard let made = try? device.makeLibrary(source: ScenePenShaders.source, options: nil) else { return nil }
            Self.library = (device, made)
            return made
        }
        guard let library, let vertex = library.makeFunction(name: "penVertex"), let fragment = library.makeFunction(name: "penFragment"),
              let layerFragment = library.makeFunction(name: "penLayerFragment"),
              let blurVertex = library.makeFunction(name: "penBlurVertex"), let blurFragment = library.makeFunction(name: "penBlurFragment")
        else { return nil }
        func pipeline(_ vertex: MTLFunction, _ fragment: MTLFunction, blend: PenBatch.Blend?) -> MTLRenderPipelineState? {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = vertex; descriptor.fragmentFunction = fragment
            let attachment = descriptor.colorAttachments[0]!
            attachment.pixelFormat = ScenePenGPU.pixelFormat
            if let blend {
                // Premultiplied source over, or plus lighter's sum; an 8-bit target clamps the sum at white as Core Graphics does.
                attachment.isBlendingEnabled = true
                attachment.rgbBlendOperation = .add; attachment.alphaBlendOperation = .add
                attachment.sourceRGBBlendFactor = .one; attachment.sourceAlphaBlendFactor = .one
                let destination: MTLBlendFactor = blend == .normal ? .oneMinusSourceAlpha : .one
                attachment.destinationRGBBlendFactor = destination; attachment.destinationAlphaBlendFactor = destination
            }
            return try? device.makeRenderPipelineState(descriptor: descriptor)
        }
        guard let normal = pipeline(vertex, fragment, blend: .normal), let additive = pipeline(vertex, fragment, blend: .additive),
              let layers = pipeline(vertex, layerFragment, blend: .normal), let blur = pipeline(blurVertex, blurFragment, blend: nil)
        else { return nil }
        self.device = device
        shapes = [.normal: normal, .additive: additive]
        self.layers = layers; self.blur = blur
    }

    /// Encodes `batch` into `target`, whose size is the batch's frame, using `slot`'s buffers.
    func encode(_ batch: PenBatch, into target: MTLTexture, slot: Slot, commands: MTLCommandBuffer) {
        // Every target's instances go in one buffer; each target's draws start at its own offset.
        var offsets: [Int] = [], total = 0
        for index in 0..<batch.targetCount {
            offsets.append(total)
            total += batch.targets[index].instances.count
        }
        let step = MemoryLayout<PenInstance>.stride
        guard let instances = buffer(&slot.instances, bytes: max(1, total) * step),
              let points = buffer(&slot.points, bytes: max(1, batch.points.count) * MemoryLayout<SIMD2<Float>>.stride) else { return }
        for index in 0..<batch.targetCount where !batch.targets[index].instances.isEmpty {
            batch.targets[index].instances.withUnsafeBytes { bytes in
                instances.contents().advanced(by: offsets[index] * step).copyMemory(from: bytes.baseAddress!, byteCount: bytes.count)
            }
        }
        batch.points.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress { points.contents().copyMemory(from: base, byteCount: bytes.count) }
        }
        var textures: [Int: (MTLTexture, MTLTexture)] = [:]
        for index in 1..<max(1, batch.targetCount) {
            guard let pair = texture(slot, index - 1, width: batch.targets[index].width, height: batch.targets[index].height) else { return }
            textures[index] = pair
        }
        // Each layer's quad reads only the part of its texture the layer drew.
        let records = instances.contents().bindMemory(to: PenInstance.self, capacity: max(1, total))
        for index in 0..<batch.targetCount {
            for run in batch.targets[index].runs where batch.targets[index].instances[run.start].kind == .layer {
                let record = records + offsets[index] + run.start, layer = Int(record.pointee.geo0.z)
                guard let texture = textures[layer]?.0 else { continue }
                record.pointee.geo0.x = Float(batch.targets[layer].width) / Float(texture.width)
                record.pointee.geo0.y = Float(batch.targets[layer].height) / Float(texture.height)
            }
        }
        // Layers are drawn before whatever lays them, and a layer only ever lays one made after it.
        for index in stride(from: batch.targetCount - 1, through: 1, by: -1) {
            let layer = batch.targets[index]
            guard let pair = textures[index] else { return }
            draw(layer, offset: offsets[index], into: pair.0, width: layer.width, height: layer.height,
                 instances: instances, points: points, textures: textures, commands: commands)
            guard layer.blurHalf > 0 else { continue }
            for pass in 0..<6 {
                // Horizontal then vertical, three times: vImage's three square box passes, ending in the layer's own texture.
                let horizontal = pass % 2 == 0, (from, to) = horizontal ? (pair.0, pair.1) : (pair.1, pair.0)
                let descriptor = MTLRenderPassDescriptor()
                descriptor.colorAttachments[0].texture = to
                descriptor.colorAttachments[0].loadAction = .dontCare
                descriptor.colorAttachments[0].storeAction = .store
                guard let encoder = commands.makeRenderCommandEncoder(descriptor: descriptor) else { return }
                encoder.setRenderPipelineState(blur)
                encoder.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(layer.width), height: Double(layer.height), znear: 0, zfar: 1))
                encoder.setScissorRect(MTLScissorRect(x: 0, y: 0, width: layer.width, height: layer.height))
                encoder.setFragmentTexture(from, index: 0)
                var parameters = [SIMD4<Int32>(Int32(layer.width), Int32(layer.height), horizontal ? 1 : 0, horizontal ? 0 : 1),
                                  SIMD4<Int32>(Int32(layer.blurHalf), 0, 0, 0)]
                encoder.setFragmentBytes(&parameters, length: MemoryLayout<SIMD4<Int32>>.stride * 2, index: 0)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                encoder.endEncoding()
            }
        }
        draw(batch.targets[0], offset: 0, into: target, width: batch.targets[0].width, height: batch.targets[0].height,
             instances: instances, points: points, textures: textures, commands: commands)
    }

    private func draw(_ target: PenBatch.Target, offset: Int, into texture: MTLTexture, width: Int, height: Int,
                      instances: MTLBuffer, points: MTLBuffer, textures: [Int: (MTLTexture, MTLTexture)], commands: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(width), height: Double(height), znear: 0, zfar: 1))
        encoder.setScissorRect(MTLScissorRect(x: 0, y: 0, width: min(width, texture.width), height: min(height, texture.height)))
        var viewport = SIMD2<Float>(Float(width), Float(height))
        encoder.setVertexBytes(&viewport, length: MemoryLayout.size(ofValue: viewport), index: 1)
        encoder.setVertexBuffer(instances, offset: 0, index: 0)
        encoder.setFragmentBuffer(instances, offset: 0, index: 0)
        encoder.setFragmentBuffer(points, offset: 0, index: 1)
        let step = MemoryLayout<PenInstance>.stride
        for (number, run) in target.runs.enumerated() {
            let end = number + 1 < target.runs.count ? target.runs[number + 1].start : target.instances.count
            guard end > run.start else { continue }
            if target.instances[run.start].kind == .layer {
                guard let layer = textures[Int(target.instances[run.start].geo0.z)] else { continue }
                encoder.setRenderPipelineState(layers)
                encoder.setFragmentTexture(layer.0, index: 0)
                encoder.setVertexBufferOffset((offset + run.start) * step, index: 0)
                encoder.setFragmentBufferOffset((offset + run.start) * step, index: 0)
                encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: 1)
                continue
            }
            encoder.setRenderPipelineState(shapes[run.blend]!)
            encoder.setVertexBufferOffset((offset + run.start) * step, index: 0)
            encoder.setFragmentBufferOffset((offset + run.start) * step, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: end - run.start)
        }
        encoder.endEncoding()
    }

    private func buffer(_ held: inout MTLBuffer?, bytes: Int) -> MTLBuffer? {
        if let held, held.length >= bytes { return held }
        // Grows by half again, so a crowd that keeps growing reallocates rarely.
        held = device.makeBuffer(length: bytes * 3 / 2, options: .storageModeShared)
        return held
    }

    /// A layer's textures, at least its size. A halo's layer changes size with its heat, so a texture is kept while the
    /// layer fits, and a new one is rounded up to whole 64-pixel steps; the blur and the quad read only the layer's part.
    private func texture(_ slot: Slot, _ index: Int, width: Int, height: Int) -> (MTLTexture, MTLTexture)? {
        if index < slot.textures.count, slot.textures[index].0.width >= width, slot.textures[index].0.height >= height {
            return slot.textures[index]
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: ScenePenGPU.pixelFormat, width: (width + 63) / 64 * 64,
                                                                  height: (height + 63) / 64 * 64, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        guard let a = device.makeTexture(descriptor: descriptor), let b = device.makeTexture(descriptor: descriptor) else { return nil }
        while slot.textures.count <= index { slot.textures.append((a, b)) }
        slot.textures[index] = (a, b)
        return (a, b)
    }
}
