import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-5183: the card-first layout's two narrow cases, which no device's own screen reaches at the default text size,
/// drawn from the shipped views in a window held to a constrained width. A wide window with no fold, an iPad's, folds
/// its sidebar once the stage beside it cannot fit the card, and the message box stays; an open Duo's folded foot stacks
/// the pager over the message box once the two cannot share a row. Each reads what UIKit draws: where a control stands
/// and whether a touch at its middle reaches it.
/// Runs against the disposable real-core home, as `PhoneTasksHiddenTests` does, for the card its stage opens with.
@MainActor final class PhoneNarrowLayoutTests: XCTestCase {
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

    /// A session joined to the disposable home, once it has read the card the home's stage opens with.
    private func joined(_ name: String) async throws -> ReadOnlySession {
        #if !targetEnvironment(simulator)
        throw PhoneError.refused("This check requires a disposable simulator.")
        #endif
        _ = try await home("remove")
        let invitation = try await home("link")
        let link = try JoinLink(XCTUnwrap(invitation["link"] as? String))
        let phone = try PhoneIdentity.loadOrCreate()
        let transport = PinnedTransport(pin: link.pin, phone: phone, purpose: .pairing)
        let mac = try await transport.pair(link, name: name)
        transport.close()
        let session = ReadOnlySession(mac: mac, phone: phone)
        session.start()
        do {
            try await until("the home's card on the stage") { !session.stack.isEmpty }
        } catch {
            session.stop()
            throw error
        }
        return session
    }

    /// A window of its own at `size`, regular both ways as an iPad's and an open Duo's are, drawing `view`.
    private func host(_ view: some View, size: CGSize) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.traitOverrides.horizontalSizeClass = .regular
        window.traitOverrides.verticalSizeClass = .regular
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        return window
    }

    private func views(in window: UIWindow) -> [UIView] {
        var found: [UIView] = [], waiting: [UIView] = [window]
        while let view = waiting.popLast() { found.append(view); waiting += view.subviews }
        return found
    }

    private func frame(_ view: UIView, in window: UIWindow) -> CGRect { view.convert(view.bounds, to: window) }

    /// The pager's count, the part of the pager UIKit draws (`PhoneCardPagerButton`).
    private func pager(in window: UIWindow) -> UIButton? {
        views(in: window).lazy.compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "card-pager" }
    }

    /// The message box: the lowest text view drawn, under the card and any reply field of the card's own.
    private func box(in window: UIWindow) -> UITextView? {
        views(in: window).compactMap { $0 as? UITextView }.filter { $0.isEditable && !frame($0, in: window).isEmpty }
            .max { frame($0, in: window).minY < frame($1, in: window).minY }
    }

    /// The sidebar's choice of Tasks or Activity. The strip in the top bar is a segmented control too, inside the bar.
    private func rail(in window: UIWindow) -> UISegmentedControl? {
        views(in: window).lazy.compactMap { $0 as? UISegmentedControl }.first { control in
            !sequence(first: control as UIView, next: \.superview).contains { $0 is UINavigationBar }
        }
    }

    /// Whether a touch at a control's middle reaches it: drawn at a size, whole inside the window, and under nothing
    /// else, neither hidden nor kept from touches.
    private func takesTouch(_ view: UIView?, in window: UIWindow) -> Bool {
        guard let view, view.window === window else { return false }
        let drawn = frame(view, in: window)
        guard !drawn.isEmpty, window.bounds.contains(drawn),
              let hit = window.hitTest(CGPoint(x: drawn.midX, y: drawn.midY), with: nil) else { return false }
        return hit.isDescendant(of: view)
    }

    /// What the message box holds after it takes the focus and `words`, an empty input view in the system keyboard's
    /// place so the check raises none; nil when it refuses the focus.
    private func typed(_ words: String, into box: UITextView) -> String? {
        box.inputView = UIView()
        guard box.becomeFirstResponder() else { return nil }
        defer { box.resignFirstResponder() }
        box.insertText(words)
        return box.text
    }

    /// An iPad on its side folds the sidebar only when the stage beside it cannot fit the card (`docs/ios.md`). No iPad
    /// is that narrow full screen, so the shipped workspace is drawn in a window resized as an iPad's can be: roomy
    /// first, then narrow, then roomy again.
    func testANarrowWindowFoldsItsSidebarForTheCardAndKeepsTheMessageBox() async throws {
        let session = try await joined("Narrow window test phone")
        defer { session.stop() }
        // Wider than tall at each width, so the sidebar's layout holds throughout. Beside a 320-point sidebar the roomy
        // stage fits a card of any width; beside the narrow window's 275 points it is 584 wide, under the 560 a card
        // needs inside its two 16-point gutters.
        let roomy: CGFloat = 1180, narrow: CGFloat = 860
        let shown = try host(NavigationStack {
            PhoneWorkspace(session: session, tasks: PhoneTasks(session: session), composer: MessageComposer(session: session))
        }, size: CGSize(width: roomy, height: 700))
        defer { shown.isHidden = true; shown.rootViewController = nil }

        try await until("the card beside the sidebar") {
            takesTouch(rail(in: shown), in: shown) && takesTouch(pager(in: shown), in: shown) && takesTouch(box(in: shown), in: shown)
        }
        var sidebar = frame(try XCTUnwrap(rail(in: shown)), in: shown)
        var field = try XCTUnwrap(box(in: shown))
        XCTAssertGreaterThan(frame(field, in: shown).minX, sidebar.maxX,
                             "With room for both, the message box stands beside the sidebar")

        shown.frame.size.width = narrow
        try await until("the sidebar folded away for the card") {
            !takesTouch(rail(in: shown), in: shown) && takesTouch(box(in: shown), in: shown)
        }
        XCTAssertTrue(takesTouch(pager(in: shown), in: shown), "The card and its pager stay on the stage")
        field = try XCTUnwrap(box(in: shown))
        XCTAssertLessThan(frame(field, in: shown).minX, PhoneLayout.sidebarWidth(width: narrow, folds: []),
                          "The message box takes the room the folded sidebar left")
        XCTAssertEqual(typed("north", into: field), "north", "The message box takes the focus and typing")

        shown.frame.size.width = roomy
        try await until("the sidebar back beside the card") {
            takesTouch(rail(in: shown), in: shown) && takesTouch(box(in: shown), in: shown)
        }
        sidebar = frame(try XCTUnwrap(rail(in: shown)), in: shown)
        field = try XCTUnwrap(box(in: shown))
        XCTAssertGreaterThan(frame(field, in: shown).minX, sidebar.maxX,
                             "With room again, the sidebar comes back beside the message box")
        _ = try await home("remove")
    }

    /// On the open Duo the folded foot is one row, the pager beside the message box, while both fit; when they do not,
    /// the pager stacks over the same message box (`docs/ios.md`). At the default text size both fit in either pose,
    /// so the Duo's folded Home is drawn at the width of the Duo on its side and then narrower than any pose.
    func testAFoldedDuoFootStacksThePagerOverTheMessageBoxWhenTheRowIsTooNarrow() async throws {
        let session = try await joined("Duo foot test phone")
        defer { session.stop() }
        // A second card, so the pager has another card to show. It is closed again below, whatever the checks find,
        // for the checks that share this home.
        let change = try await home("change")
        let title = try XCTUnwrap(change["title"] as? String)
        try await until("a second card on the stack") { session.stack.contains { $0.title == title } }
        let added = try XCTUnwrap(session.stack.first { $0.title == title })
        var failure: Error?
        do { try await stackedFoot(session) } catch { failure = error }
        try await session.change(.close(card: added.id, lifecycle: added.lifecycleID, offer: added.offerID), .noteDone,
                                 [.string(added.id), added.submission()])
        try await until("the added card closed") { !session.stack.contains { $0.id == added.id } }
        _ = try await home("remove")
        if let failure { throw failure }
    }

    private func stackedFoot(_ session: ReadOnlySession) async throws {
        // The pager is never under 148 points wide, two 44-point chevrons round a 44-point count 8 points apart, and
        // the row needs it, a 12-point gap and half a reading column inside its gutters: 472 points at the least.
        let onItsSide: CGFloat = 669, narrow: CGFloat = 440
        let shown = try host(FoldedDuoHome(session: session), size: CGSize(width: onItsSide, height: 951))
        defer { shown.isHidden = true; shown.rootViewController = nil }

        try await until("the pager and the message box at the foot") {
            takesTouch(pager(in: shown), in: shown) && takesTouch(box(in: shown), in: shown)
        }
        var count = frame(try XCTUnwrap(pager(in: shown)), in: shown)
        var field = frame(try XCTUnwrap(box(in: shown)), in: shown)
        XCTAssertTrue(count.minY < field.maxY && field.minY < count.maxY,
                      "At the Duo's width the pager \(count) and the message box \(field) share a row")
        XCTAssertLessThanOrEqual(count.maxX, field.minX, "In the row the pager stands before the message box")

        shown.frame.size.width = narrow
        try await until("the pager stacked over the message box") {
            guard let pager = pager(in: shown), let box = box(in: shown) else { return false }
            return frame(pager, in: shown).maxY <= frame(box, in: shown).minY
        }
        count = frame(try XCTUnwrap(pager(in: shown)), in: shown)
        field = frame(try XCTUnwrap(box(in: shown)), in: shown)
        XCTAssertTrue(shown.bounds.contains(count) && shown.bounds.contains(field),
                      "Stacked, the pager \(count) and the message box \(field) stay whole inside the window")
        XCTAssertTrue(takesTouch(pager(in: shown), in: shown), "Stacked, a touch reaches the pager")
        XCTAssertTrue(takesTouch(box(in: shown), in: shown), "Stacked, a touch reaches the message box")

        // The count's own menu names the stack's cards; each pick moves the stage to that card, so one of the two picks
        // is a move whichever card stood there first.
        let picks = try XCTUnwrap(pager(in: shown)?.menu?.children.compactMap { $0 as? UIAction })
        XCTAssertEqual(picks.count, 2, "Stacked, the pager names both cards")
        for (place, pick) in picks.enumerated().reversed() {
            pick.performWithSender(pager(in: shown), target: nil)
            let words = PhoneMessages.phoneCardsPagerPosition(position: String(place + 1), total: String(picks.count))
            try await until("the stacked pager at card \(place + 1)") { pager(in: shown)?.configuration?.title == words }
        }
        XCTAssertTrue(takesTouch(pager(in: shown), in: shown), "After paging, a touch still reaches the stacked pager")
        let stacked = try XCTUnwrap(box(in: shown))
        XCTAssertEqual(typed("north", into: stacked), "north", "Stacked, the message box takes the focus and typing")
    }
}

/// Home on an open Duo whose panel is folded for a card, composed as `PhoneWorkspace` hands it to the pages layout
/// (`homePages`): the cards' stage and pager, and the message box, over a fold that runs across the window. Only a Duo
/// reads a fold of its own, so the fold and the Duo's choices are given here.
private struct FoldedDuoHome: View {
    let session: ReadOnlySession
    @State private var context: PhoneMessageContext = {
        let context = PhoneMessageContext()
        context.cardFirst = true
        return context
    }()
    private let fold = CGRect(x: 0, y: 455, width: 669, height: 40)

    var body: some View {
        PhoneCards(session: session, sharedFoot: true) { stage, pager in
            PhonePagesLayout(pages: .panelAbove(fold), folds: [fold], panelsFolded: true, openDuo: true) {
                PhoneTheme.panel.layoutValue(key: PhonePagesRole.self, value: .panel)
                stage.frame(maxWidth: .infinity, maxHeight: .infinity).layoutValue(key: PhonePagesRole.self, value: .stage)
                pager.layoutValue(key: PhonePagesRole.self, value: .pager)
                MessageComposer(session: session)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
                    .layoutValue(key: PhonePagesRole.self, value: .composer)
            }
        }
        .environment(context)
        .font(PhoneFont.body).tint(PhoneTheme.accent).foregroundStyle(PhoneTheme.text).background(PhoneTheme.background)
    }
}
