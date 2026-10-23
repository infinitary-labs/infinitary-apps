import SwiftUI
import UIKit

/// Where the floating footer goes around the native tabs: how far above the stage's foot, and how far in
/// from either side when the tabs leave room beside them.
struct PhoneTabClearance: Equatable {
    var bottom: CGFloat = 0
    var leading: CGFloat = 0
    var trailing: CGFloat = 0
}

/// The growing footer stays mounted above the real native bar, not a guessed bar height.
/// Both iOS 18 and iOS 26 use the same measured placement.
/// On iOS 26 the bar recedes on scroll (INF-944 item 4): its glass shrinks to one round button at the row's edge,
/// so the footer follows it into that row, beside the button, and returns above the bar when it comes back.
struct PhoneTabBarClearance: UIViewRepresentable {
    let changed: (PhoneTabClearance) -> Void

    func makeUIView(context: Context) -> Probe { Probe(changed: changed) }
    func updateUIView(_ view: Probe, context: Context) {
        view.changed = changed
        view.setNeedsLayout()
    }

    final class Probe: UIView {
        var changed: (PhoneTabClearance) -> Void
        private var reported: PhoneTabClearance?
        private var watched: [ObjectIdentifier: [NSKeyValueObservation]] = [:]

        init(changed: @escaping (PhoneTabClearance) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layoutSubviews() {
            super.layoutSubviews()
            measure()
        }

        private func measure() {
            let bar = tabBar(in: window?.rootViewController)
            var clearance = PhoneTabClearance()
            // iPad's top tabs leave a detached legacy UITabBar with a stale frame.
            // Converting that frame invents bottom clearance and lifts the footer over the pager.
            if let bar, let window, bar.window === window, !bar.isHidden, bar.alpha > 0 {
                watch(bar)
                let frame = convert(bar.bounds, from: bar)
                // An iPad's native tabs may be at the top; only a bottom bar reserves footer space.
                if frame.midY > bounds.midY {
                    let glass = drawn(bar) ?? frame
                    let gap = PhoneTheme.space2
                    // A receded bar shows fewer tab buttons than it has tabs, one round button at an edge of its row;
                    // the footer takes the rest of the row. An iPhone on its side keeps a narrow bar with every tab.
                    if receded(bar) {
                        clearance.bottom = max(0, bounds.maxY - safeAreaInsets.bottom - glass.maxY)
                        if glass.midX < bounds.midX { clearance.leading = max(0, glass.maxX + gap - PhoneTheme.space4) }
                        else { clearance.trailing = max(0, bounds.maxX - glass.minX + gap - PhoneTheme.space4) }
                    } else {
                        clearance.bottom = max(0, bounds.maxY - safeAreaInsets.bottom - glass.minY)
                    }
                }
            }
            guard clearance != reported else { return }
            let first = reported == nil
            reported = clearance
            // A measurement must not mutate SwiftUI state during its layout pass.
            let measured = clearance
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if first || UIAccessibility.isReduceMotionEnabled { changed(measured) }
                else { withAnimation(.smooth(duration: 0.3)) { self.changed(measured) } }
            }
        }

        /// The bar's own drawn glass: the union of its visible children, which on iOS 26 shrinks while the bar recedes
        /// although the bar's frame does not. On iOS 18 the bar's background spans it, so this is the bar itself.
        private func drawn(_ bar: UITabBar) -> CGRect? {
            guard #available(iOS 26, *) else { return nil }
            let shown = bar.subviews.filter { !$0.isHidden && $0.alpha > 0.01 && !$0.bounds.isEmpty }
            guard let first = shown.first else { return nil }
            return shown.dropFirst().reduce(convert(first.bounds, from: first)) { $0.union(convert($1.bounds, from: $1)) }
        }

        /// Whether the bar shows fewer of its tab buttons than it has tabs, which only a receded iOS 26 bar does.
        private func receded(_ bar: UITabBar) -> Bool {
            guard #available(iOS 26, *), let tabs = bar.items?.count, tabs > 1 else { return false }
            func shown(_ view: UIView) -> Int {
                guard !view.isHidden, view.alpha > 0.01 else { return 0 }
                return view is UIControl ? 1 : view.subviews.reduce(0) { $0 + shown($1) }
            }
            // The expanded bar draws its row of tabs twice, under and over the selection lens, so each row counts alone.
            let rows = bar.subviews.flatMap { $0.isHidden ? [] : $0.subviews }.map(shown)
            // No visible button at all is a bar this cannot read, which keeps the footer above it.
            return (1..<tabs).contains(rows.max() ?? 0)
        }

        /// The bar moves its children without laying this probe out again, so their frames are watched.
        private func watch(_ bar: UITabBar) {
            guard #available(iOS 26, *) else { return }
            let views = [bar] + bar.subviews
            let live = Set(views.map(ObjectIdentifier.init))
            watched = watched.filter { live.contains($0.key) }
            for view in views where watched[ObjectIdentifier(view)] == nil {
                let remeasure: () -> Void = { [weak self] in DispatchQueue.main.async { self?.measure() } }
                watched[ObjectIdentifier(view)] = [
                    view.layer.observe(\.bounds) { _, _ in remeasure() },
                    view.layer.observe(\.position) { _, _ in remeasure() },
                    view.layer.observe(\.isHidden) { _, _ in remeasure() },
                    view.layer.observe(\.sublayers) { _, _ in remeasure() },
                ]
            }
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
