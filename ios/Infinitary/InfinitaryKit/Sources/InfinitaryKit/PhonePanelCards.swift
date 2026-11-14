import Foundation

/// INF-3830 piece 3: one of a panel's cards on the phone's Home, as the desktop's stack holds one (`PanelCardEntry`,
/// src/renderer/src/app/stack.ts): put up by the panel's `cards.emit` or a header button, drawn by the panel's own card
/// view, held on this phone only and never saved.
public struct PhonePanelCardEntry: Sendable, Equatable, Identifiable {
    public let panel: String
    /// The card's own id inside its panel.
    public let id: String
    public var view: String
    public var title: String
    public var width: String
    /// "content" follows its page's height; "fill" takes the stage's.
    public var height: String
    public var data: PhoneJSON
    /// The times it was put up, from 1, so its view hears each press that names it even with the same data.
    public var revision: Int
    /// Its place, as its page last kept it (`card.keep`), handed to the next page it is born into.
    public var kept: PhoneJSON

    /// The stack entry's id, as the desktop names it (`panelCardEntryId`).
    public var entryID: String { Self.entryID(panel: panel, id: id) }
    public static func entryID(panel: String, id: String) -> String { "panel-card:\(panel)/\(id)" }

    /// What its page hears as view state: its data, revision and kept place (`FramedCard`'s `state.card`).
    public var state: PhoneJSON { .object(["data": data, "kept": kept, "revision": .number(Double(revision))]) }
}

/// The panel cards Home holds, with the desktop's rules (`emitPanelCard` and its siblings in
/// src/renderer/src/app/stackActions.ts): a card the captain asked for comes to the front; one put up otherwise waits
/// behind the card being read, marked new; an open id is revised in place, keeping its place; and a panel may have
/// `PhonePanelWords.openCardsMax` cards open at once.
public struct PhonePanelCards: Sendable, Equatable {
    public private(set) var entries: [PhonePanelCardEntry] = []
    /// The entries put up behind the card being read and not yet shown.
    public private(set) var unread: Set<String> = []

    public init() {}

    public enum Outcome: Sendable, Equatable {
        /// The card is up: show it now, or leave it where it waits.
        case up(id: String, show: Bool)
    }

    /// Puts up one of `panel`'s cards from a `cards.emit` value the parent page already checked against the desktop's
    /// schema and the panel's card views, or revises its open one, and answers its id.
    public mutating func emit(panel: String, _ card: PhoneJSON, front: Bool) throws(PhoneRequestError) -> Outcome {
        guard let view = card["view"].text, let title = card["title"].text else { throw PhoneRequestError(Self.notACard) }
        let open = entries.filter { $0.panel == panel }
        let id = card["id"].text ?? Self.freshID(open)
        let at = entries.firstIndex { $0.panel == panel && $0.id == id }
        if at == nil && open.count >= PhonePanelWords.openCardsMax { throw PhoneRequestError(Self.full) }
        let entry = PhonePanelCardEntry(
            panel: panel, id: id, view: view, title: title,
            width: card["width"].text ?? PhonePanelWords.defaultCardWidth,
            height: card["height"].text ?? PhonePanelWords.defaultCardHeight,
            data: card["data"],
            revision: (at.map { entries[$0].revision } ?? 0) + 1,
            // A revision is the same card: its place stays until Hide.
            kept: at.map { entries[$0].kept } ?? .null)
        if let at { entries[at] = entry } else { entries.append(entry) }
        if front {
            unread.remove(entry.entryID)
            return .up(id: id, show: true)
        }
        if at == nil { unread.insert(entry.entryID) }
        return .up(id: id, show: false)
    }

    /// A card a header button names, put up by the app itself on the captain's tap, so it comes to the front. Its id is
    /// its name, so a second press brings the same card forward; the button's data stands in for the card's own.
    public mutating func emitNamed(_ panel: PhonePanel, name: String, data: PhoneJSON?) -> String? {
        guard let declared = panel.cards?[name], panel.cardViews?.contains(declared.view) == true else { return nil }
        var card: [String: PhoneJSON] = ["id": .string(name), "view": .string(declared.view), "title": .string(declared.title)]
        if let width = declared.width { card["width"] = .string(width) }
        if let height = declared.height { card["height"] = .string(height) }
        if let data = data ?? declared.data { card["data"] = data }
        guard case .up(let id, _)? = try? emit(panel: panel.id, .object(card), front: true) else { return nil }
        return PhonePanelCardEntry.entryID(panel: panel.id, id: id)
    }

    /// Takes one of `panel`'s cards off Home; an id that is not open does nothing.
    public mutating func close(panel: String, id: String) {
        entries.removeAll { $0.panel == panel && $0.id == id }
        unread.remove(PhonePanelCardEntry.entryID(panel: panel, id: id))
    }

    /// Takes every card of the panels not in `kept` off Home: a panel that left the computer's list takes its cards.
    public mutating func keepOnly(panels kept: Set<String>) {
        entries.removeAll { !kept.contains($0.panel) }
        unread = unread.filter { id in entries.contains { $0.entryID == id } }
    }

    /// Keeps the place of one of `panel`'s open cards, until Hide.
    public mutating func keep(panel: String, id: String, _ value: PhoneJSON) {
        guard let at = entries.firstIndex(where: { $0.panel == panel && $0.id == id }) else { return }
        entries[at].kept = value
    }

    /// The card showed on Home: it is no longer new.
    public mutating func seen(_ entryID: String) { unread.remove(entryID) }

    /// `panel`'s open cards, as `cards.open` answers them, newest first, saying which one Home shows.
    public func open(panel: String, shown: String?) -> PhoneJSON {
        .array(entries.filter { $0.panel == panel }.reversed().map { entry in
            .object(["id": .string(entry.id), "view": .string(entry.view), "title": .string(entry.title),
                     "width": .string(entry.width), "height": .string(entry.height), "shown": .bool(entry.entryID == shown)])
        })
    }

    public func entry(_ entryID: String) -> PhonePanelCardEntry? { entries.first { $0.entryID == entryID } }

    /// The desktop's `freshPanelCardId`: `card-<n>`, the first number past the open count that no open card takes.
    static func freshID(_ open: [PhonePanelCardEntry]) -> String {
        let taken = Set(open.map(\.id))
        var n = open.count + 1
        while taken.contains("card-\(n)") { n += 1 }
        return "card-\(n)"
    }

    // i18n-exempt: an author-facing refusal at the panel's call, in the desktop's own words (stackActions.ts)
    static let notACard = "cards.emit: not a card"
    // i18n-exempt: an author-facing refusal at the panel's call, in the desktop's own words (stackActions.ts)
    static var full: String { "this panel already has \(PhonePanelWords.openCardsMax) cards open; close one with cards.close first" }
}
