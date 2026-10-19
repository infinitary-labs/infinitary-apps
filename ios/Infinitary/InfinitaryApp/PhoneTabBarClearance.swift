import SwiftUI
import UIKit

/// The growing footer stays mounted above the real native bar, not a guessed bar height.
/// Both iOS 18 and iOS 26 use the same measured placement.
struct PhoneTabBarClearance: UIViewRepresentable {
    let changed: (CGFloat) -> Void

    func makeUIView(context: Context) -> Probe { Probe(changed: changed) }
    func updateUIView(_ view: Probe, context: Context) {
        view.changed = changed
        view.setNeedsLayout()
    }

    final class Probe: UIView {
        var changed: (CGFloat) -> Void
        private var reported: CGFloat = -1

        init(changed: @escaping (CGFloat) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layoutSubviews() {
            super.layoutSubviews()
            let bar = tabBar(in: window?.rootViewController)
            var clearance: CGFloat = 0
            // iPad's top tabs leave a detached legacy UITabBar with a stale frame.
            // Converting that frame invents bottom clearance and lifts the footer over the pager.
            if let bar, let window, bar.window === window, !bar.isHidden, bar.alpha > 0 {
                let frame = convert(bar.bounds, from: bar)
                // An iPad's native tabs may be at the top; only a bottom bar reserves footer space.
                if frame.midY > bounds.midY {
                    clearance = max(0, bounds.maxY - safeAreaInsets.bottom - frame.minY)
                }
            }
            guard clearance != reported else { return }
            reported = clearance
            // A measurement must not mutate SwiftUI state during its layout pass.
            let measured = clearance
            DispatchQueue.main.async { [weak self] in self?.changed(measured) }
        }

        private func tabBar(in controller: UIViewController?) -> UITabBar? {
            guard let controller else { return nil }
            if let tabs = controller as? UITabBarController { return tabs.tabBar }
            for child in controller.children {
                if let bar = tabBar(in: child) { return bar }
            }
            return nil
        }
    }
}
