import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Watches a finger on a card's or panel's web view and says once when it moves on the screen farther than UIKit lets a
/// press move (docs/ios.md, "Cards on the phone"). Those web views never scroll themselves: the app's own scrollers and
/// swipes move the whole view with the finger, so what the finger went down on stays under it, and WebKit cancels
/// neither the page's pointer nor its touch. Without this word the frame's bridge took such a drag, held from WebKit's
/// press moment up, for a press and clicked what it went down on as the finger lifted (`FRAME_PRESS_SCRIPT`).
///
/// It only watches: it never recognizes, never delays or cancels a touch, and lets every other gesture go on beside it.
/// `down` hears each first finger as it goes down, before WebKit turns the press into the page's click.
final class PressMoveWatch: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private let moved: () -> Void
    private let down: (() -> Void)?
    /// The first finger down, the one the page takes for its primary pointer, and where it went down in the window.
    private weak var finger: UITouch?
    private var start: CGPoint = .zero
    private var told = false
    /// How far UIKit lets a press move and still be one, which WebKit's own press handling keeps too.
    private let tolerance = UILongPressGestureRecognizer().allowableMovement

    init(down: (() -> Void)? = nil, moved: @escaping () -> Void) {
        self.down = down
        self.moved = moved
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard finger == nil, let first = touches.first else { return }
        finger = first
        start = first.location(in: nil)
        told = false
        down?()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard !told, let finger, touches.contains(finger) else { return }
        let at = finger.location(in: nil)
        guard hypot(at.x - start.x, at.y - start.y) > tolerance else { return }
        told = true
        moved()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lifted(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lifted(touches) }

    /// The watched finger is done: the watch fails, as a gesture that never happened, and UIKit resets it for the next.
    private func lifted(_ touches: Set<UITouch>) {
        guard let finger else { state = .failed; return }
        if touches.contains(finger) { state = .failed }
    }

    override func reset() {
        super.reset()
        finger = nil
        told = false
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
