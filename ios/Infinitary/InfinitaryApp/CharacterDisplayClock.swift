import Observation
import QuartzCore
import SwiftUI
import UIKit

/// INF-1066: display-synchronized elapsed time. Only the scene observes this clock, not the shell.
/// A stopped clock consumes no callbacks and excludes time spent behind cards or in the background.
@MainActor @Observable final class CharacterDisplayClock {
    private(set) var now = 0.0
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var last: Double?
    @ObservationIgnored private let target = DisplayTarget()

    var running: Bool { link != nil }
    /// INF-1208's direction A: the scene of the window the character is in. iPhone Duo has two displays, and the main
    /// screen is the outer one even while the inner one is lit, so the clock ticks with its window's own display.
    @ObservationIgnored private weak var scene: UIWindowScene?

    /// Ticks with the display of the character's window from now on, and moves a running clock there at once, as when a
    /// Duo folds and its window moves to the other display.
    func show(in scene: UIWindowScene) {
        self.scene = scene
        guard running, scene.screen !== tickingScreen else { return }
        setRunning(false); setRunning(true)
    }

    func setRunning(_ running: Bool) {
        guard running != self.running else { return }
        if !running { link?.invalidate(); link = nil; last = nil; return }
        target.owner = self
        let link = displayLink()
        tickingScreen = scene?.screen
        // The captain selected the permitted display rate, up to 120. iOS retains power/thermal control, and clamps the
        // range to what the display can do while the window's display is not yet known.
        let maximum = Float(min(120, scene?.screen.maximumFramesPerSecond ?? 120))
        // Core Animation requires a positive minimum for a nondefault range; zero raises an exception.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 1, maximum: maximum, preferred: maximum)
        self.link = link
        link.add(to: .main, forMode: .common)
    }
    @ObservationIgnored private weak var tickingScreen: UIScreen?

    private func displayLink() -> CADisplayLink {
        let selector = #selector(DisplayTarget.tick(_:))
        if #available(iOS 27, *), let scene, let link = scene.displayLink(target: target, selector: selector) { return link }
        if let link = scene?.screen.displayLink(withTarget: target, selector: selector) { return link }
        return CADisplayLink(target: target, selector: selector)
    }
    func advance(timestamp: Double) {
        if let last { now += max(0, timestamp - last) }
        last = timestamp
    }
    @MainActor private final class DisplayTarget: NSObject {
        weak var owner: CharacterDisplayClock?
        @objc func tick(_ link: CADisplayLink) { owner?.advance(timestamp: link.timestamp) }
    }
}

/// INF-1208's direction A: reports the window scene a view is in each time it lands in a window or that window changes
/// size, as a Duo's does when it folds or opens and its window moves to the other display.
struct PhoneWindowSceneReader: UIViewRepresentable {
    let found: (UIWindowScene) -> Void
    func makeUIView(context: Context) -> Reader { Reader(found: found) }
    func updateUIView(_ reader: Reader, context: Context) { reader.found = found }

    final class Reader: UIView {
        var found: (UIWindowScene) -> Void
        init(found: @escaping (UIWindowScene) -> Void) {
            self.found = found
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); report() }
        override func layoutSubviews() { super.layoutSubviews(); report() }
        private func report() { if let scene = window?.windowScene { found(scene) } }
    }
}
