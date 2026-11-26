import Foundation
import Observation
import XCTest
@testable import InfinitaryKit

/// INF-2773, the captain's pick "keep what they showed, then change once when the catch-up is read": a reopen that
/// replays what the phone missed reads every missed update into its own copy and changes the screens once. A reaction
/// from while the phone was away stays silent (docs/ios.md, the crew scene), and a live one after the catch-up plays.
/// Runs against the disposable real-core home, as `PhoneReopenTests` does.
@MainActor final class PhoneCatchUpTests: XCTestCase {
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

    /// Each change the screens are told of: every assignment of the shown board or cards, as SwiftUI observes them.
    /// The session changes them on the main actor, which calls `onChange` inside the assignment, so each is counted
    /// and watched again there. A count left to a Task queued after the assignment trailed the board and cards the
    /// wait already saw, and missed a second assignment made before that Task ran.
    @MainActor private final class Shown {
        private(set) var boards = 0
        private(set) var cards = 0
        private let session: ReadOnlySession
        init(_ session: ReadOnlySession) { self.session = session; watchBoard(); watchCards() }
        private func watchBoard() {
            withObservationTracking { _ = session.board } onChange: { [weak self] in
                MainActor.assumeIsolated { self?.boards += 1; self?.watchBoard() }
            }
        }
        private func watchCards() {
            withObservationTracking { _ = session.cards } onChange: { [weak self] in
                MainActor.assumeIsolated { self?.cards += 1; self?.watchCards() }
            }
        }
    }

    func testACatchUpChangesTheScreensOnceAndPlaysNoReactionFromWhileAway() async throws {
        #if !targetEnvironment(simulator)
        throw PhoneError.refused("This check requires a disposable simulator.")
        #endif
        _ = try await home("remove")
        // The home replays only what weighs less than reading again, which a light board this short would not.
        _ = try await home("catch-up-board")
        let invitation = try await home("link")
        let link = try JoinLink(XCTUnwrap(invitation["link"] as? String))
        let phone = try PhoneIdentity.loadOrCreate()
        let transport = PinnedTransport(pin: link.pin, phone: phone, purpose: .pairing)
        let mac = try await transport.pair(link, name: "Catch-up test phone")
        transport.close()
        let session = ReadOnlySession(mac: mac, phone: phone)
        var emotes: [String] = []
        session.onEmote = { emotes.append($0) }
        session.start()
        defer { session.stop() }
        // The harmless read waits for In reach, which comes before the board's first read (INF-3750); once the board is
        // read too, every first read has answered, so the next welcome replays rather than reading again.
        _ = try await session.read(.past, [.string("no-such-catch-up-card")])
        XCTAssertEqual(session.contact, "in-reach")
        try await until("the first board") { session.board != nil }

        // Away: the connection is closed while the computer adds six tasks, one board update each, two cards, one card
        // list each, and a reaction. One at a time, the screens would change six times and twice.
        session.stop()
        let away = try await home("away-traffic")
        let added = try XCTUnwrap(away["ids"] as? [String])
        let cards = try XCTUnwrap(away["cards"] as? [String])
        XCTAssertEqual(cards.count, 2)
        let shown = Shown(session)
        // INF-6817 piece 2: the panels' pages hear what they missed too, every update in order, handed over once the
        // replay is read rather than one call an update.
        var panelCalls: [[PhonePanelPush]] = []
        session.onPanelPush = { panelCalls.append($0) }
        session.start()
        try await until("the board and cards from while away") {
            let ids = Set(session.board?.tasks.map(\.id) ?? [])
            let shownCards = Set(session.cards.map(\.id))
            return added.allSatisfy(ids.contains) && cards.allSatisfy(shownCards.contains)
        }
        XCTAssertEqual(shown.boards, 1, "The catch-up of six board updates changed the shown board once")
        XCTAssertEqual(shown.cards, 1, "The catch-up of two card lists changed the shown cards once")
        let replayed = try XCTUnwrap(panelCalls.first, "The panels heard the catch-up")
        let boardUpdates = replayed.filter { $0.channel == "inf:tasks:delta" }
            .flatMap { $0.payload["upserts"].list.compactMap { $0["id"].text } }
        XCTAssertEqual(boardUpdates.filter(added.contains), added, "The panels heard each board update from while away, in order, in one call")
        // A replay sends only the newest card list whole (docs/connection.md, "Catching up"), which holds both cards.
        let cardLists = replayed.filter { $0.channel == "inf:cards" }
        XCTAssertEqual(cardLists.count, 1)
        XCTAssertEqual(Set(cardLists.last?.payload.list.compactMap { $0["id"].text } ?? []).intersection(cards), Set(cards),
                       "The panels heard the newest card list in the same call")
        XCTAssertEqual(emotes, [], "A reaction from while the phone was away did not play")

        // The board read into the held copy is the one the computer reads fresh, read the way the session holds it.
        // INF-3764 (docs/task-retention.md, "A view's first board read"): until Tasks shows Done or a search, the
        // session reads the board without its closed rows, naming the Done rows left out, and a delta keeps it so;
        // a whole board pushed brings every row. The computer answers in the order asked, so once the lighter read
        // answers, every board read the session sent before it has landed.
        let lighter = try await session.request(.board, args: [["closed": false]], as: PhoneBoard.self)
        try await until("the board at the fresh read's version") { (session.board?.seq ?? -1) >= lighter.seq }
        var fresh = lighter
        if session.board?.closedLeftOut == nil { fresh = try await session.request(.board, as: PhoneBoard.self) }
        XCTAssertEqual(session.board?.seq, fresh.seq)
        XCTAssertEqual(session.board?.tasks.map(\.id), fresh.tasks.map(\.id))
        XCTAssertEqual(session.board?.tasks.map(\.status), fresh.tasks.map(\.status))
        XCTAssertEqual(session.board?.closedLeftOut?.done, fresh.closedLeftOut?.done)

        _ = try await home("emote")
        try await until("the live reaction") { emotes == ["ponder"] }
        _ = try await home("away-cleanup")
        _ = try await home("remove")
    }

    /// INF-3750, the captain: "after i don't use the ios app for a while and come back to it, it takes quite a while for
    /// it to finish connection". On a large record the task board outweighs every other first read together, and the
    /// computer answers in the order asked. The phone asks for the board last and says In reach once the small reads
    /// answer, so the computer holding the board's answer leaves the phone in reach with no board, until it arrives.
    func testInReachDoesNotWaitForTheTaskBoard() async throws {
        #if !targetEnvironment(simulator)
        throw PhoneError.refused("This check requires a disposable simulator.")
        #endif
        _ = try await home("remove")
        let invitation = try await home("link")
        let link = try JoinLink(XCTUnwrap(invitation["link"] as? String))
        let phone = try PhoneIdentity.loadOrCreate()
        let transport = PinnedTransport(pin: link.pin, phone: phone, purpose: .pairing)
        let mac = try await transport.pair(link, name: "Board-last test phone")
        transport.close()
        _ = try await home("hold-board-read")
        // The held answer goes out even when this check fails, so it holds nothing up for the checks after it.
        addTeardownBlock {
            guard let control = ProcessInfo.processInfo.environment["PHONE_TEST_HOME"],
                  let url = URL(string: control + "/release-board-read") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            _ = try? await URLSession.shared.data(for: request)
        }
        let session = ReadOnlySession(mac: mac, phone: phone)
        session.start()
        defer { session.stop() }
        _ = try await home("board-read-held")
        try await until("in reach while the board's answer is held") { session.contact == "in-reach" }
        XCTAssertNil(session.board, "In reach came before the board")
        _ = try await home("release-board-read")
        try await until("the board once its answer is sent") { session.board != nil }
        XCTAssertEqual(session.contact, "in-reach")
        _ = try await home("remove")
    }
}
