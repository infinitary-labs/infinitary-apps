import Foundation

/// INF-5608 piece 2 (`choice-attachments`, docs/card-authoring.md "The card's one field"): what a card's choice or a
/// note's own button does with the photos and queued notes waiting in the card's field, as the Mac's footer decides it.
public enum PhoneChoiceCarry: Equatable, Sendable {
    /// Only words wait, or nothing: the button sends as it always has.
    case nothing
    /// The computer takes them with a press: the button carries them, and the footer names what goes.
    case carries(line: String)
    /// The computer does not list the change and would refuse them: the buttons wait until they go as a reply, with the
    /// Mac's words, the notes' first, so nothing is lost.
    case holds(notesFirst: Bool)

    public static func reading(photos: Int, notes: Int, homeTakes: Bool) -> Self {
        guard photos > 0 || notes > 0 else { return .nothing }
        guard homeTakes else { return .holds(notesFirst: notes > 0) }
        return .carries(line: line(photos: photos, notes: notes))
    }

    /// The Mac's `carriedWithChoiceWords`: what goes with whichever button is pressed, by kind and count.
    static func line(photos: Int, notes: Int) -> String {
        let items = (photos > 0 ? [PhoneMessages.cardCarriedPictures(count: photos)] : [])
            + (notes > 0 ? [PhoneMessages.cardCarriedNotes(count: notes)] : [])
        return PhoneMessages.cardCarriedWithChoice(count: photos + notes, items: PhoneFormats.list(items))
    }

    /// Whether the buttons wait.
    public var holds: Bool { if case .holds = self { true } else { false } }
}
