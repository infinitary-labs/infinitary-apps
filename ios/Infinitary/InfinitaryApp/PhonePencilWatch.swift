import SwiftUI
import UIKit

/// The captain's Approve and build on comfortable Apple Pencil input: the Pencil itself is the signal, never the kind
/// of device. This marker puts two observers on the window it sits in: one reads each touch's kind as it comes down and
/// at once steps aside, so it never recognizes, cancels or delays a touch, and one reads a Pencil hovering above the
/// glass on an iPad that senses it. An iPhone never sees a Pencil, so nothing on it changes.
struct PhonePencilWatch: UIViewRepresentable {
    /// A Pencil came down or hovered; `onField` when it came down on a text field, where Scribble writes.
    let pencil: (_ onField: Bool) -> Void
    /// Any touch came down, with whether it was the Pencil, so a field's focus knows what gave it.
    let touched: (_ pencil: Bool) -> Void

    func makeUIView(context: Context) -> Marker {
        let view = Marker()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: Marker, context: Context) {
        view.pencil = pencil
        view.touched = touched
    }

    final class Marker: UIView, UIGestureRecognizerDelegate {
        var pencil: (Bool) -> Void = { _ in }
        var touched: (Bool) -> Void = { _ in }
        private lazy var touches = TouchKind { [weak self] touch in self?.saw(touch) }
        private lazy var hover: UIHoverGestureRecognizer = {
            let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
            hover.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
            hover.cancelsTouchesInView = false
            hover.delegate = self
            return hover
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            touches.view?.removeGestureRecognizer(touches)
            hover.view?.removeGestureRecognizer(hover)
            guard let window else { return }
            touches.delegate = self
            window.addGestureRecognizer(touches)
            window.addGestureRecognizer(hover)
        }

        private func saw(_ touch: UITouch) {
            let isPencil = touch.type == .pencil
            touched(isPencil)
            if isPencil { pencil(Self.onField(touch.view)) }
        }

        @objc private func hovered(_ hover: UIHoverGestureRecognizer) {
            if hover.state == .began { pencil(false) }
        }

        /// A text field or text view, or a part inside one; a card's web view is not one, so the palm resting on a card
        /// and the Pencil tapping it still move the box.
        private static func onField(_ view: UIView?) -> Bool {
            var view = view
            while let at = view {
                if at is UITextView || at is UITextField { return true }
                view = at.superview
            }
            return false
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }

    /// Reads a touch's kind as it comes down and fails at once, so every other recognizer and view gets the touch as if
    /// this one were not there.
    final class TouchKind: UIGestureRecognizer {
        private let saw: (UITouch) -> Void

        init(saw: @escaping (UITouch) -> Void) {
            self.saw = saw
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            touches.forEach(saw)
            state = .failed
        }
    }
}

/// iPadOS's own reading that the person will write with a Pencil, read when Infinitary opens or comes back. A simulator
/// has no Pencil, so the iPad's Pencil steps launch one that answers yes (`INFINITARY_PENCIL_SEEN`).
@MainActor func phonePencilExpected() -> Bool {
    #if targetEnvironment(simulator)
    let environment = ProcessInfo.processInfo.environment
    if environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1", environment["INFINITARY_PENCIL_SEEN"] == "1" { return true }
    #endif
    return UIScribbleInteraction.isPencilInputExpected
}
