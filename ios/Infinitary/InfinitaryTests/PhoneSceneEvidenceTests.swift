import CoreFoundation
import SwiftUI
import XCTest
@testable import Infinitary

/// INF-1066: the captain asked for smooth native motion and CI before/after frame timing.
/// Observe the actual PhoneCharacter in a visible host window on each disposable simulator.
/// Timing is evidence, not a wall-clock pass/fail budget on a shared CI computer.
@MainActor final class PhoneSceneEvidenceTests: XCTestCase {
    /// INF-1066: photographs of every approved native form, using the same painter as the running scene.
    func testEveryNativeFormHasAVisibleDrawing() throws {
        let modes = CharacterMachine.Mode.allCases.filter { $0 != .fidget }
        let forms: [(CharacterMachine.Mode, CharacterMachine.Fidget?)] = modes.map { ($0, nil) }
            + CharacterMachine.Fidget.allCases.map { (.fidget, $0) }
        for theme in [ColorScheme.dark, .light] {
            var drawings = Set<Data>()
            for (mode, variant) in forms {
                var pose = CharacterPose(mode: mode, progress: 0.4, variant: variant, cur: .of(mode), heat: mode == .working ? 1 : 0, milliseconds: 2200)
                pose.lid = pose.cur.lidBase
                let reply = CharacterReply.frame(mode, pose.progress)
                pose.happy = reply.happy; pose.lid = max(pose.lid, reply.lid)
                let frame = pose
                let renderer = ImageRenderer(content: Canvas { context, size in CharacterPainter.draw(frame, in: &context, size: size) }
                    .frame(width: 280, height: 280).padding(16).background(PhoneTheme.background).environment(\.colorScheme, theme))
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage), png = try XCTUnwrap(image.pngData())
                drawings.insert(png)
                let picture = XCTAttachment(image: image)
                picture.name = "native-scene-\(variant?.rawValue ?? mode.rawValue)-\(theme == .dark ? "dark" : "light")"
                picture.lifetime = .keepAlways; add(picture)
            }
            XCTAssertEqual(drawings.count, forms.count, "Every approved form has its own rendered geometry")
        }
    }

    /// INF-1066: a full-scene timing sample must not count its nested first-mate draw twice.
    func testFrameSamplesKeepTheirDrawingScopeAndSource() {
        let metrics = CharacterFrameMetrics()
        let pose = CharacterPose.still(.idle, at: 0)
        func record(_ drawing: CharacterFrameMetrics.Drawing, source: String = "visible-scene") {
            metrics.record(start: ProcessInfo.processInfo.systemUptime, source: source,
                           mode: pose.mode.rawValue, heat: pose.heat, rotation: pose.a, drawing: drawing)
        }
        metrics.start(source: "visible-scene", drawing: .scene)
        record(.character); record(.scene); record(.scene, source: "another-window")
        XCTAssertEqual(metrics.finish().count, 1, "Only the complete drawing from the selected scene enters its sample")
        metrics.start(source: "visible-scene")
        record(.scene); record(.character)
        XCTAssertEqual(metrics.finish().count, 1, "The isolated first-mate sample still selects its own painter")
    }

    /// INF-1143 asks for evidence of main-thread progress, not an assumption from missing display ticks.
    func testWarmupTraceRecordsActualMainRunLoopProgress() async {
        let trace = NativeSceneRunLoopTrace()
        let serviced = XCTestExpectation(description: "The main run loop reaches its source phase")
        guard let witness = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeSources.rawValue, false, 1, { _, _ in serviced.fulfill() }) else {
            _ = trace.finish()
            XCTFail("The test could not observe the main run loop")
            return
        }
        // Observe that phase after the trace's order-zero observer, rather than assuming which turn
        // services a queued block. The completion witness is the actual run-loop event.
        CFRunLoopAddObserver(CFRunLoopGetMain(), witness, .commonModes)
        defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), witness, .commonModes) }
        let result = await XCTWaiter.fulfillment(of: [serviced], timeout: 5)
        let entries = trace.finish()
        XCTAssertEqual(result, .completed)
        XCTAssertEqual(entries.first?.event, "warmup-start")
        XCTAssertEqual(entries.last?.event, "warmup-end")
        XCTAssertTrue(entries.contains { $0.event == "before-sources" })
        XCTAssertTrue(entries.allSatisfy(\.mainThread))
        XCTAssertEqual(entries.map(\.uptime), entries.map(\.uptime).sorted())
    }

    func testNativeSceneCadenceEvidence() async throws {
        #if targetEnvironment(simulator)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; window.rootViewController = nil }
        var pictures = Set<Data>()
        for state in [PhoneCharacter.State.idle, .working] {
            CharacterCues.greetingPending = false
            window.rootViewController = UIHostingController(rootView: PhoneCharacter(state: state)
                .frame(width: 200, height: 200).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(PhoneTheme.background).environment(\.colorScheme, .dark)
                .environment(\.scenePhase, .active).environment(\.characterEvidenceSource, state.rawValue).id(state.rawValue))
            window.makeKeyAndVisible()
            pictures.insert(try await recordNativeSceneCadence(window: window, state: state, source: state.rawValue))
        }
        XCTAssertEqual(pictures.count, 2, "Idle and working captures must show different target states")
        #else
        throw XCTSkip("This evidence uses only a disposable simulator")
        #endif
    }
}

@MainActor extension XCTestCase {
    /// The same display-tick sample observes the isolated first mate and the production crowded scene.
    func recordNativeSceneCadence(window: UIWindow, state: PhoneCharacter.State, source: String,
                                  drawing: CharacterFrameMetrics.Drawing = .character,
                                  reaction: (CharacterMotion, CharacterMachine.Emote)? = nil) async throws -> Data {
        // Warmup and sample end on display callbacks, not a sleeping guess about when drawing starts.
        // A static waiter does not send this shared XCTestCase extension's non-Sendable self.
        let runLoop = NativeSceneRunLoopTrace()
        let warmup = DisplaySample(ticks: 60)
        let warmupResult = await XCTWaiter.fulfillment(of: [warmup.finished], timeout: 20)
        XCTAssertEqual(warmupResult, .completed, "The display completes the warmup callbacks")
        warmup.stop()
        let heartbeat = runLoop.finish()
        CharacterFrameMetrics.shared.start(source: source, drawing: drawing)
        if let (character, emote) = reaction { character.request(emote) }
        let sample = DisplaySample(ticks: 240)
        let sampleResult = await XCTWaiter.fulfillment(of: [sample.finished], timeout: 20)
        XCTAssertEqual(sampleResult, .completed, "The display completes the sampled callbacks")
        sample.stop()
        let frames = CharacterFrameMetrics.shared.finish()
        XCTAssertGreaterThan(frames.count, 1, "The visible native character actually draws")
        let expectedModes = Set([state.rawValue] + (reaction.map { [$0.1.rawValue] } ?? []))
        XCTAssertTrue(frames.allSatisfy { expectedModes.contains($0.mode) }, "Only the named target Canvas's expected states enter the sample")
        if let (_, emote) = reaction {
            XCTAssertTrue(frames.contains { $0.mode == emote.rawValue }, "The native drawing must actually play the requested emote")
        }
        if state == .working { XCTAssertTrue(frames.allSatisfy { $0.heat > 0.8 }, "Working proof includes its warmed ember, not another window's idle drawing") }
        XCTAssertNotEqual(frames.first?.rotation, frames.last?.rotation, "The sampled target actually advances its pose")
        let intervals = zip(frames.dropFirst(), frames).map { $0.timestamp - $1.timestamp }.sorted()
        let displayIntervals = zip(sample.timestamps.dropFirst(), sample.timestamps).map { $0 - $1 }.sorted()
        let work = frames.map(\.work).sorted()
        let duration = (frames.last?.timestamp ?? 0) - (frames.first?.timestamp ?? 0)
        func p95(_ values: [Double]) -> Double { values.isEmpty ? 0 : values[min(values.count - 1, Int(Double(values.count) * 0.95))] }
        let summary = "source=\(source) state=\(state.rawValue) frames=\(frames.count) fps=\(Double(max(0, frames.count - 1)) / max(duration, 0.001)) interval_p95_ms=\(p95(intervals) * 1000) interval_max_ms=\((intervals.last ?? 0) * 1000) draw_p95_ms=\(p95(work) * 1000) display_p95_ms=\(p95(displayIntervals) * 1000) display_ticks=\(sample.timestamps.count)"
        let minimumHeat = frames.map(\.heat).min().map { String($0) } ?? "unknown"
        let warmupSummary = "source=\(source) ticks=\(warmup.timestamps.count) completed=\(warmupResult == .completed) sample_completed=\(sampleResult == .completed) minimum_heat=\(minimumHeat)"
        print("NATIVE_SCENE_WARMUP \(warmupSummary)")
        let warmupProof = XCTAttachment(string: warmupSummary + "\ntimestamp\n" + warmup.timestamps.map { String($0) }.joined(separator: "\n"))
        warmupProof.name = "native-scene-\(source)-warmup"; warmupProof.lifetime = .keepAlways; add(warmupProof)
        let heartbeatProof = XCTAttachment(string: "uptime,event,main_thread\n" + heartbeat.map { "\($0.uptime),\($0.event),\($0.mainThread)" }.joined(separator: "\n"))
        heartbeatProof.name = "native-scene-\(source)-main-run-loop"; heartbeatProof.lifetime = .keepAlways; add(heartbeatProof)
        print("NATIVE_SCENE_RUN_LOOP source=\(source) events=\(heartbeat.count) start=\(heartbeat.first?.uptime ?? 0) end=\(heartbeat.last?.uptime ?? 0)")
        print("NATIVE_SCENE_TIMING \(summary)")
        let csv = summary + "\ntimestamp,draw_seconds,mode,heat,rotation\n" + frames.map { "\($0.timestamp),\($0.work),\($0.mode),\($0.heat),\($0.rotation)" }.joined(separator: "\n")
        let attachment = XCTAttachment(string: csv)
        attachment.name = "native-scene-\(source)-timing"; attachment.lifetime = .keepAlways; add(attachment)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let png = try XCTUnwrap(image.pngData())
        let picture = XCTAttachment(image: image)
        picture.name = "native-scene-\(source)"; picture.lifetime = .keepAlways; add(picture)
        return png
    }
}

@MainActor private final class DisplaySample: NSObject {
    let finished = XCTestExpectation(description: "Display sample complete")
    private var remaining: Int
    private var link: CADisplayLink?
    private(set) var timestamps: [Double] = []
    init(ticks: Int) {
        remaining = ticks
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        self.link = link
        link.add(to: .main, forMode: .common)
    }
    @objc private func tick(_ link: CADisplayLink) {
        timestamps.append(link.timestamp); remaining -= 1
        if remaining == 0 { stop(); finished.fulfill() }
    }
    func stop() { link?.invalidate(); link = nil }
}
