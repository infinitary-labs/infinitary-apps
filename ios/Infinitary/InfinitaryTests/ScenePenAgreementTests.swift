import Metal
import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-3851 piece 2, the captain's "Our own graphics-chip pen": the scene's render thread draws through the graphics
/// chip's batch instead of Core Graphics, so the phone stops painting every pixel on the processor, and the picture
/// must not change. Each frame here is drawn by the production painters through both pens and compared pixel by
/// pixel: at least 99.5% of pixels agree within 4/255 on every channel (the plan's done spec, item 4).
@MainActor final class ScenePenAgreementTests: XCTestCase {
    /// The plan's starting tolerance, recorded on its card: the share of pixels, and the difference each may have.
    private static let agreeing = 0.995, within = 4
    /// The iPhone 17 Pro's screen: 402 by 874 points at three pixels per point.
    private static let scale: CGFloat = 3, window = CGSize(width: 402, height: 874)

    private var gpu: ScenePenGPU!
    private var queue: MTLCommandQueue!

    override func setUpWithError() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice(), "The simulator offers no graphics chip")
        gpu = try XCTUnwrap(ScenePenGPU(device: device), "The pen's shaders did not build")
        queue = try XCTUnwrap(device.makeCommandQueue())
    }

    /// The first mate in each of its three states, every reaction and every fidget, warps included, and the busy
    /// first mate whose halo is a blurred layer, in both themes.
    func testTheFirstMateDrawsTheSameThroughBothPens() throws {
        let modes = CharacterMachine.Mode.allCases.filter { $0 != .fidget }
        let forms: [(CharacterMachine.Mode, CharacterMachine.Fidget?)] = modes.map { ($0, nil) }
            + CharacterMachine.Fidget.allCases.map { (.fidget, $0) }
        for theme in [ColorScheme.dark, .light] {
            let palette = CharacterPainter.Palette(theme), cache = CharacterPainter.Cache()
            for (mode, variant) in forms {
                var pose = CharacterPose(mode: mode, progress: 0.4, variant: variant, cur: .of(mode), heat: mode == .working ? 1 : 0, milliseconds: 2200)
                pose.lid = pose.cur.lidBase
                let reply = CharacterReply.frame(mode, pose.progress)
                pose.happy = reply.happy; pose.lid = max(pose.lid, reply.lid)
                let frame = pose
                try agree("\(variant?.rawValue ?? mode.rawValue)-\(theme)", size: CGSize(width: 312, height: 312)) { pen in
                    pen.translateBy(x: 16, y: 16)
                    CharacterPainter.draw(frame, in: &pen, size: CGSize(width: 280, height: 280), cache: cache, palette: palette, source: "")
                }
            }
        }
    }

    /// The whole window as the render thread draws it: about twenty crewmates on two computers around the first mate,
    /// resting and busy, with keyboard browsing's outline and a summary's brackets, and each warp under way.
    func testTheCrowdedSceneDrawsTheSameThroughBothPens() throws {
        let roster = try Self.roster(home: 12, remote: 8)
        let selected = try XCTUnwrap(roster.computers.first?.tasks.first)
        for theme in [ColorScheme.dark, .light] {
            let palette = CharacterPainter.Palette(theme)
            for state in [PhoneCharacter.State.idle, .working] {
                let motion = PhoneSceneMotion()
                var frame = motion.frame(roster: roster, now: 0, settled: false)
                for step in 1...150 { frame = motion.frame(roster: roster, now: Double(step) / 60, settled: false) }
                let mode: CharacterMachine.Mode = state == .working ? .working : .idle
                let pose = CharacterPose(mode: mode, cur: .of(mode), heat: state == .working ? 1 : 0, milliseconds: 2500)
                try agree("crowd-\(state)-\(theme)", size: Self.window) { pen in
                    Self.paint(frame, motion: motion, pose: pose, roster: roster, now: 2.5, palette: palette, selection: selected.id,
                               bracketed: (selected.id, PhoneSceneRoster.computerID(selected)), in: &pen)
                }
            }
            for variant in [CharacterMachine.Fidget.tunnel, .sphere, .corkscrew] {
                let motion = PhoneSceneMotion(), seconds = CharacterCatalog.shared.fidgets[variant.rawValue]! / 1000
                var frame = motion.frame(roster: roster, now: 0, settled: false), pose = CharacterPose.still(.idle, at: 0)
                for step in 0...Int(seconds * 0.45 * 60) {
                    let now = Double(step) / 60
                    pose = CharacterPose(mode: .fidget, progress: now / seconds, variant: variant, milliseconds: now * 1000)
                    frame = motion.frame(roster: roster, now: now, settled: false, warp: CharacterWarp.frame(pose, coreR: 280 * 0.27))
                }
                XCTAssertNotNil(motion.warp, "\(variant) is under way at the frame drawn")
                let drawn = pose
                try agree("warp-\(variant)-\(theme)", size: Self.window) { pen in
                    Self.paint(frame, motion: motion, pose: drawn, roster: roster, now: drawn.milliseconds / 1000, palette: palette,
                               selection: nil, bracketed: nil, in: &pen)
                }
            }
        }
    }

    // MARK: drawing both ways

    /// `PhoneSceneRenderer.paint`'s order, from a frame and pose the test holds still.
    private static func paint(_ frame: PhoneSceneMotion.Frame, motion: PhoneSceneMotion, pose: CharacterPose, roster: PhoneSceneRoster, now: Double,
                              palette: CharacterPainter.Palette, selection: String?, bracketed: (task: String, computer: String)?, in pen: inout ScenePen) {
        if let warp = motion.warp {
            CharacterWarp.drawBackdrop(warp, at: CGPoint(x: roster.homeX, y: roster.height / 2), riders: motion.riders,
                                       scale: PhoneSceneRoster.ringScale, palette: palette, in: &pen)
        }
        PhoneCrewPainter.draw(frame, roster: roster, now: now, still: false, in: &pen, palette: palette)
        var firstmate = pen
        firstmate.translateBy(x: roster.homeX - 140, y: roster.height / 2 - 140)
        CharacterPainter.draw(pose, in: &firstmate, size: CGSize(width: 280, height: 280), cache: CharacterPainter.Cache(), palette: palette, source: "")
        PhoneCrewPainter.drawMarks(frame, selection: selection, bracketed: bracketed, in: &pen, palette: palette)
    }

    /// Draws `body` through the Core Graphics pen, as the render thread did, and through the graphics chip's batch, as
    /// it does now, and compares the two pictures.
    private func agree(_ name: String, size: CGSize, _ body: (inout ScenePen) -> Void) throws {
        let width = Int(size.width * Self.scale), height = Int(size.height * Self.scale)
        let cg = try XCTUnwrap(ScenePen.bitmap(width: width, height: height))
        cg.translateBy(x: 0, y: CGFloat(height)); cg.scaleBy(x: Self.scale, y: -Self.scale)
        var processor = ScenePen(cg)
        body(&processor)
        let data = try XCTUnwrap(cg.data)
        var expected = [UInt8](repeating: 0, count: width * height * 4)
        for row in 0..<height {
            expected.withUnsafeMutableBytes { $0.baseAddress!.advanced(by: row * width * 4).copyMemory(from: data.advanced(by: row * cg.bytesPerRow), byteCount: width * 4) }
        }

        let batch = PenBatch()
        batch.reset(width: width, height: height, scale: Self.scale)
        var chip = ScenePen(batch)
        body(&chip)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: ScenePenGPU.pixelFormat, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]; descriptor.storageMode = .shared
        let texture = try XCTUnwrap(gpu.device.makeTexture(descriptor: descriptor))
        let commands = try XCTUnwrap(queue.makeCommandBuffer())
        gpu.encode(batch, into: texture, slot: ScenePenGPU.Slot(), commands: commands)
        commands.commit(); commands.waitUntilCompleted()
        XCTAssertNil(commands.error, "\(name): the graphics chip failed the frame")
        var drawn = [UInt8](repeating: 0, count: width * height * 4)
        texture.getBytes(&drawn, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)

        var agreeing = 0, worst = 0, painted = 0
        for pixel in 0..<(width * height) {
            var difference = 0
            for channel in 0..<4 { difference = max(difference, abs(Int(expected[pixel * 4 + channel]) - Int(drawn[pixel * 4 + channel]))) }
            if difference <= Self.within { agreeing += 1 }
            worst = max(worst, difference)
            if expected[pixel * 4 + 3] > 0 { painted += 1 }
        }
        let share = Double(agreeing) / Double(width * height)
        print("PEN_AGREEMENT \(name) agreeing=\(String(format: "%.5f", share)) worst=\(worst) painted=\(painted) instances=\(batch.targets[0].instances.count)")
        XCTAssertGreaterThan(painted, 0, "\(name): the frame drew something to compare")
        if share < Self.agreeing {
            for (label, bytes) in [("core-graphics", expected), ("graphics-chip", drawn)] {
                let picture = XCTAttachment(image: Self.image(bytes, width: width, height: height))
                picture.name = "pen-\(name)-\(label)"; picture.lifetime = .keepAlways; add(picture)
            }
        }
        XCTAssertGreaterThanOrEqual(share, Self.agreeing, "\(name): \(agreeing) of \(width * height) pixels agree within \(Self.within)/255; worst \(worst)/255")
    }

    private static func image(_ bytes: [UInt8], width: Int, height: Int) -> UIImage {
        var copy = bytes
        let cg = copy.withUnsafeMutableBytes { ScenePen.bitmap(width: width, height: height, data: $0.baseAddress, bytesPerRow: width * 4)!.makeImage()! }
        return UIImage(cgImage: cg)
    }

    /// A board of `home` crewmates on the joined computer and `remote` on another, as INF-3842's crowded test home.
    private static func roster(home: Int, remote: Int) throws -> PhoneSceneRoster {
        func task(_ id: String, device: String?, tier: String, activity: String) -> [String: Any] {
            var task: [String: Any] = ["id": id, "key": id, "projectId": "p", "kind": "work", "title": id, "status": "active",
                                       "createdAt": 0.0, "blockedBy": [String](), "activity": activity, "tier": tier]
            if let device { task["executionDeviceId"] = device }
            return task
        }
        let tiers = ["low", "medium", "high"], activities = ["running", "running", "idle"]
        let tasks = (1...home).map { task("home-\($0)", device: nil, tier: tiers[$0 % 3], activity: activities[$0 % 3]) }
            + (1...remote).map { task("studio-\($0)", device: "studio", tier: tiers[$0 % 3], activity: activities[($0 + 1) % 3]) }
        let json: [String: Any] = ["seq": 1, "tasks": tasks, "projects": [["id": "p", "name": "Infinitary"]], "links": [[String: Any]]()]
        let board = try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: json))
        let presence = try JSONDecoder().decode([PhoneComputerPresence].self, from: Data(#"[{"id":"studio","name":"Studio","inReach":true}]"#.utf8))
        return PhoneSceneRoster.Cache().read(board: board, presence: presence, homeName: "Mac", inReach: true, generation: 1, revision: 1)
    }
}
