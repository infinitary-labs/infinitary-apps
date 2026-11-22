import InfinitaryKit
import SwiftUI

/// INF-5608 piece 2 (`choice-attachments`): the photos and queued notes a press takes from a card's field - a reply's
/// send, a choice or a note's own button - which go in the press's value and come back to the field on a refusal.
struct PhoneCardHeld {
    var photos: [PhonePhoto] = []
    var notes: [PhoneJSON] = []
    var isEmpty: Bool { photos.isEmpty && notes.isEmpty }

    /// Puts them in the press's value beside its answers, as a reply carries them.
    func add(to value: inout [String: PhoneJSON]) {
        if !photos.isEmpty { value["images"] = .array(photos.map { .object($0.wire.mapValues(PhoneJSON.string)) }) }
        if !notes.isEmpty { value["notes"] = .array(notes) }
    }

    /// A press's value: its answers, with them beside.
    func value(answers: [PhoneJSON]) -> [String: PhoneJSON] {
        var value: [String: PhoneJSON] = ["answers": .array(answers)]
        add(to: &value)
        return value
    }

    /// The field's words as a press's anything-else answer.
    static func written(_ words: String) -> PhoneJSON {
        .object(["name": .string(PhoneCardWords.anythingElse), "values": .array([]), "changed": .bool(true),
                 "written": .string(words)])
    }

    /// The field lets go of what the press took as it goes.
    @MainActor func take(from photos: Binding<[PhonePhoto]>, _ notes: Binding<[PhoneJSON]>) {
        guard !isEmpty else { return }
        photos.wrappedValue.removeAll { photo in self.photos.contains { $0.id == photo.id } }
        notes.wrappedValue.removeAll { note in self.notes.contains { PhoneCardNotes.same($0, note) } }
    }

    /// A refusal puts the words, photos and notes the press took back in the field, ahead of any added since.
    func restoring(words: String, _ reply: Binding<String>, _ photos: Binding<[PhonePhoto]>,
                   _ notes: Binding<[PhoneJSON]>) -> @MainActor () -> Void {
        { [self] in
            if reply.wrappedValue.isEmpty { reply.wrappedValue = words }
            guard !isEmpty else { return }
            photos.wrappedValue = self.photos + photos.wrappedValue.filter { photo in !self.photos.contains { $0.id == photo.id } }
            notes.wrappedValue = self.notes.reduce(notes.wrappedValue) { queue, note in
                queue.contains { PhoneCardNotes.same($0, note) } ? queue : queue + [note]
            }
        }
    }
}

/// The footer's line while a photo or note waits in a card's field: what goes with whichever button is pressed, or,
/// against a computer without `choice-attachments`, the Mac's words for why the buttons wait.
struct PhoneCarryLine: View {
    let carry: PhoneChoiceCarry

    var body: some View {
        switch carry {
        case .nothing: EmptyView()
        case .carries(let line):
            Text(line).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("carried-line")
        case .holds(let notesFirst):
            Text(notesFirst ? PhoneMessages.shellCardNotesFirst() : PhoneCardWords.filesFirst)
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("carried-hold")
        }
    }
}

/// What went with a past card's closing choice from its field, as the Mac's past card shows it: the lead with its words,
/// its notes as a sent reply draws them, and its pictures by name.
struct PhonePastCarried: View {
    let words: String?
    let carried: PhoneJSON

    var body: some View {
        if words != nil || carried != .null {
            Text(words.map { "\(PhoneCardWords.sentWithChoice) \($0)" } ?? PhoneCardWords.sentWithChoice)
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("past-sent-words")
        }
        if !carried["notes"].list.isEmpty {
            PhoneThreadNotes(notes: carried["notes"].list, onReveal: nil).accessibilityIdentifier("past-sent-notes")
        }
        let names = carried["pictures"].list.compactMap(\.text)
        if !names.isEmpty {
            Text(PhoneMessages.cardPastPictures(count: names.count, names: PhoneFormats.list(names)))
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("past-sent-pictures")
        }
    }
}
