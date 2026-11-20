import Foundation
import Testing
@testable import InfinitaryKit

/// INF-3830 piece 3 (done when: "A panel's title-row buttons draw beside its fold and work" and "A card a panel puts up
/// shows on Home"): the phone keeps the desktop's rules for a panel's header buttons and its cards
/// (src/renderer/src/plugins/PanelHeaderButtons.tsx, src/renderer/src/app/stackActions.ts `emitPanelCard`).
struct PhonePanelCardsTests {
    /// A panel as the computer lists it (`inf:plugins:personal:list`), with the manifest keys a desk panel declares.
    private func desk() throws -> PhonePanel {
        let snapshot = try PhoneJSON.read([
            "extensions": [[
                "id": "desk", "source": "personal", "by": NSNull(), "title": "Desk",
                "placement": ["x": "right", "y": "top"], "order": 100, "size": "content", "present": true, "ownPresence": false,
                "moves": false, "running": false, "reads": ["tasks.board"], "sql": [], "panel": NSNull(),
                "frame": ["version": "0123456789abcdef"], "cardViews": ["note"],
                "cards": ["today": ["view": "note", "title": "Today", "data": ["day": "today"]],
                          "stray": ["view": "missing", "title": "Stray"]],
                "header": [["id": "today", "icon": "note", "label": "Open today", "emits": "today"],
                           ["id": "find", "icon": "search", "label": "Find"]],
                "commands": [], "server": NSNull(), "error": NSNull(),
            ]],
        ] as [String: Any])
        return try #require(PhonePanelList.decode(snapshot).first)
    }

    private func card(_ fields: [String: Any]) throws -> PhoneJSON { try PhoneJSON.read(fields) }

    @Test func aButtonThatAsksShowsOnlyWhileThePanelShowsItsBody() throws {
        let panel = try desk()
        #expect(panel.headerButtons(folded: false).map(\.id) == ["today", "find"])
        #expect(panel.headerButtons(folded: true).map(\.id) == ["today"])
    }

    @Test func everyHeaderIconTheDesktopOffersHasASymbol() {
        for icon in PhonePanelWords.headerIcons { #expect(PhonePanelHeaderButton.symbols[icon] != nil, "\(icon)") }
    }

    @Test func aHeaderButtonPutsUpItsNamedCardAtTheFrontOnce() throws {
        let panel = try desk()
        var cards = PhonePanelCards()
        let first = cards.emitNamed(panel, name: "today", data: nil)
        #expect(first == "panel-card:desk/today")
        #expect(cards.entries.first?.data == .object(["day": .string("today")]))
        #expect(cards.unread.isEmpty)
        // A second press brings the same card forward, heard as one more time it was put up.
        _ = cards.emitNamed(panel, name: "today", data: .string("again"))
        #expect(cards.entries.count == 1)
        #expect(cards.entries.first?.revision == 2)
        #expect(cards.entries.first?.data == .string("again"))
        // A name whose view the panel does not have puts up nothing.
        #expect(cards.emitNamed(panel, name: "stray", data: nil) == nil)
    }

    @Test func aCardPutUpWithoutTheCaptainsTapWaitsMarkedNew() throws {
        var cards = PhonePanelCards()
        let asked = try cards.emit(panel: "desk", card(["view": "note", "title": "Asked"]), front: true)
        #expect(asked == .up(id: "card-1", show: true))
        let behind = try cards.emit(panel: "desk", card(["view": "note", "title": "Behind"]), front: false)
        #expect(behind == .up(id: "card-2", show: false))
        #expect(cards.unread == ["panel-card:desk/card-2"])
        cards.seen("panel-card:desk/card-2")
        #expect(cards.unread.isEmpty)
    }

    @Test func aRevisionKeepsItsPlaceAndCountsAnotherTimeUp() throws {
        var cards = PhonePanelCards()
        _ = try cards.emit(panel: "desk", card(["id": "a", "view": "note", "title": "A"]), front: true)
        _ = try cards.emit(panel: "desk", card(["id": "b", "view": "note", "title": "B"]), front: true)
        cards.keep(panel: "desk", id: "a", .object(["scroll": .number(120)]))
        _ = try cards.emit(panel: "desk", card(["id": "a", "view": "note", "title": "A again", "data": ["n": 2]]), front: false)
        #expect(cards.entries.map(\.id) == ["a", "b"])
        let revised = try #require(cards.entries.first)
        #expect(revised.revision == 2 && revised.title == "A again")
        #expect(revised.kept == .object(["scroll": .number(120)]))
        #expect(revised.state == .object(["data": .object(["n": .number(2)]), "kept": .object(["scroll": .number(120)]),
                                          "revision": .number(2)]))
        // A revision behind the card being read is not new again.
        #expect(cards.unread.isEmpty)
        #expect(cards.open(panel: "desk", shown: "panel-card:desk/b").list.map { $0["id"].text } == ["b", "a"])
        #expect(cards.open(panel: "desk", shown: "panel-card:desk/b").list.first?["shown"] == .bool(true))
    }

    @Test func aPanelHasAtMostTheDesktopsOpenCards() throws {
        var cards = PhonePanelCards()
        for _ in 0..<PhonePanelWords.openCardsMax { _ = try cards.emit(panel: "desk", card(["view": "note", "title": "N"]), front: false) }
        #expect(throws: PhoneRequestError.self) { try cards.emit(panel: "desk", card(["view": "note", "title": "One more"]), front: false) }
        // Another panel, and a revision of an open card, are still allowed.
        _ = try cards.emit(panel: "other", card(["view": "note", "title": "Other"]), front: false)
        _ = try cards.emit(panel: "desk", card(["id": "card-1", "view": "note", "title": "Revised"]), front: false)
    }

    @Test func closingAndAPanelLeavingTakeItsCards() throws {
        var cards = PhonePanelCards()
        _ = try cards.emit(panel: "desk", card(["id": "a", "view": "note", "title": "A"]), front: false)
        _ = try cards.emit(panel: "desk", card(["id": "b", "view": "note", "title": "B"]), front: false)
        _ = try cards.emit(panel: "gone", card(["id": "c", "view": "note", "title": "C"]), front: false)
        cards.close(panel: "desk", id: "a")
        #expect(cards.entries.map(\.entryID) == ["panel-card:desk/b", "panel-card:gone/c"])
        cards.keepOnly(panels: ["desk"])
        #expect(cards.entries.map(\.entryID) == ["panel-card:desk/b"])
        #expect(cards.unread == ["panel-card:desk/b"])
    }
}
