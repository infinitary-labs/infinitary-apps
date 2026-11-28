import Observation
import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-7097: one Command-Return sends the message box's words once. In phone run 46043315869 a second Command-Return
/// reached the Send button's shortcut before SwiftUI drew the emptied box, and the phone sent an empty message right
/// after the real one. Here the shipped message box, joined to the disposable real-core home, takes Command-Return
/// twice before it draws again, each press run the way UIKit runs a key command, as `PhonePagerKeysTests` presses its
/// chords.
@MainActor final class PhoneComposerSendTests: XCTestCase {
    private func home(_ command: String) async throws -> [String: Any] {
        let control = try XCTUnwrap(ProcessInfo.processInfo.environment["PHONE_TEST_HOME"])
        var request = URLRequest(url: try XCTUnwrap(URL(string: control + "/" + command)))
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func until(_ what: String, _ done: () -> Bool) async throws {
        var deadline = PhoneWaitDeadline(30)
        while !done() {
            if deadline.expired() { throw PhoneError.refused("Never saw: \(what)") }
            try await Task.sleep(for: .seconds(PhoneWaitDeadline.tick))
        }
    }

    /// Every message the session began sending, by the intent it opens before it sends one. That intent stays until a
    /// later answer from the computer settles it, and each change to the intents is read on the main actor's next turn,
    /// before any such answer can run there, so a message that came and went is still counted.
    @MainActor private final class Sends {
        private(set) var words: [Int: String] = [:]
        private let session: ReadOnlySession
        init(_ session: ReadOnlySession) { self.session = session; read(); watch() }
        private func read() {
            for intent in session.ledger.intents { if case let .send(text, _) = intent.kind { words[intent.id] = text } }
        }
        private func watch() {
            withObservationTracking { _ = session.ledger } onChange: { [weak self] in
                Task { @MainActor in self?.read(); self?.watch() }
            }
        }
    }

    func testASecondCommandReturnBeforeTheBoxRedrawsSendsNothing() async throws {
        #if !targetEnvironment(simulator)
        throw PhoneError.refused("This check requires a disposable simulator.")
        #endif
        _ = try await home("remove")
        let invitation = try await home("link")
        let link = try JoinLink(XCTUnwrap(invitation["link"] as? String))
        let phone = try PhoneIdentity.loadOrCreate()
        let transport = PinnedTransport(pin: link.pin, phone: phone, purpose: .pairing)
        let mac = try await transport.pair(link, name: "Composer send test phone")
        transport.close()
        let session = ReadOnlySession(mac: mac, phone: phone)
        session.start()
        defer { session.stop() }
        try await until("the computer in reach with changes on") { session.canChange }

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; window.rootViewController = nil }
        let context = PhoneMessageContext()
        window.rootViewController = UIHostingController(rootView: MessageComposer(session: session).environment(context))
        window.makeKeyAndVisible()
        func box() -> UITextView? {
            var waiting: [UIView] = [window]
            while let view = waiting.popLast() {
                if let text = view as? UITextView, text.isEditable { return text }
                waiting += view.subviews
            }
            return nil
        }

        // A card's draft button fills the box and focuses it, as typing would; the box drawing the words is the same
        // draw that turns Send, and its shortcut, on.
        let words = "Count the harbour lights before the tide turns."
        context.draft = words
        try await until("the box holding the words, focused") { box()?.text == words && box()?.isFirstResponder == true }
        // UIKit runs a key press as the first command for its chord up the responder chain from the first responder.
        func commandReturn() -> (UIKeyCommand, Selector, Any)? {
            var responder: UIResponder? = box()
            while let current = responder {
                if let command = current.keyCommands?.first(where: { $0.input == "\r" && $0.modifierFlags == .command }),
                   let action = command.action, let target = current.target(forAction: action, withSender: command) {
                    return (command, action, target)
                }
                responder = current.next
            }
            return nil
        }
        try await until("Command-Return offered") { commandReturn() != nil }
        let earlier = session.lastTurn?.askId
        let sends = Sends(session)
        XCTAssertEqual(sends.words, [:], "Nothing was sending before the presses")

        // Both presses run before the main actor turns, so SwiftUI draws nothing between them.
        let (command, action, target) = try XCTUnwrap(commandReturn())
        XCTAssertTrue(UIApplication.shared.sendAction(action, to: target, from: command, for: nil))
        XCTAssertTrue(UIApplication.shared.sendAction(action, to: target, from: command, for: nil))
        // The message's turn ends with the first mate's reply on it, so the home is idle for the tests after this one.
        try await until("the first mate's reply to the message") {
            session.lastTurn?.askId != earlier && session.lastTurn?.you == words && session.lastTurn?.reply != nil
        }
        try await until("the first mate idle") { !session.firstmateBusy }
        XCTAssertEqual(Array(sends.words.values), [words], "Two presses before the box redraws send the words once, and no empty message")
        XCTAssertEqual(box()?.text, "", "The send emptied the box")
    }
}
