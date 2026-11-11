import InfinitaryKit
import SwiftUI

/// INF-3296's phone piece, the captain's Approve and build: a part of a card's body, or words selected in it, picked
/// to note. The note is the Mac's (`CardNote` in src/shared/cardNotes.ts), built by the card's own page from the part's
/// identity; native code adds only the comment. `box` is where the part or the words sit in the body view's points.
struct PhoneNotePick: Equatable {
    var note: PhoneJSON
    var box: CGRect
    var comment: String
    /// The pick opened a note already queued, whose place in the queue a Queue keeps.
    var queued: Bool

    init(note: PhoneJSON, box: CGRect, queued: [PhoneJSON]) {
        self.note = note; self.box = box
        comment = note["comment"].text ?? ""
        self.queued = queued.contains { PhoneCardNotes.same($0, note) }
    }

    /// The note with the comment written now.
    var written: PhoneJSON {
        guard case .object(var fields) = note else { return note }
        fields["comment"] = .string(comment)
        return .object(fields)
    }
}

enum PhoneCardNotes {
    /// The Mac's sameNote: one part, or one range of words, is one note.
    static func same(_ a: PhoneJSON, _ b: PhoneJSON) -> Bool {
        a["key"] == b["key"] && a["start"] == b["start"] && a["span"] == b["span"]
    }

    /// The queue with this note in it: a note on the same target takes the earlier one's place.
    static func queuing(_ note: PhoneJSON, in queue: [PhoneJSON]) -> [PhoneJSON] {
        if let at = queue.firstIndex(where: { same($0, note) }) {
            var queue = queue
            queue[at] = note
            return queue
        }
        return queue + [note]
    }

    static func label(_ note: PhoneJSON) -> String {
        PhoneCardWords.noteLabel(kind: note["kind"].text ?? "", excerpt: note["excerpt"].text ?? "")
    }

    /// What a reply that carries notes reads as in its thread while it is sending, as the computer's plain lines read.
    static func sendingText(_ text: String, _ notes: [PhoneJSON]) -> String {
        ([text] + notes.map { "\(label($0))\n\($0["comment"].text.flatMap { $0.isEmpty ? nil : $0 } ?? PhoneCardWords.emptyNote)" })
            .filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

/// The Mac's annotation popover: what is picked, a comment that may stay empty, Cancel and Queue. Return in the comment
/// queues it, Command-Return queues it and sends every queued note, and Escape closes it while the comment is empty.
struct PhoneNotePopover: View {
    @Binding var pick: PhoneNotePick?
    let onQueue: (_ send: Bool) -> Void
    @FocusState private var focused: Bool
    @State private var hint = false

    var body: some View {
        let comment = Binding(get: { pick?.comment ?? "" }, set: { words in
            // Return queues, as the Mac's Enter does; a vertical field would otherwise take it as a new line.
            if words.hasSuffix("\n") {
                pick?.comment = String(words.dropLast())
                onQueue(false)
                return
            }
            hint = false
            pick?.comment = String(words.prefix(PhoneLimits.reply))
        })
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text("\(PhoneCardWords.annotate) \(pick?.note["kind"].text ?? "")").font(PhoneFont.headline)
                .accessibilityAddTraits(.isHeader)
            Text(pick?.note["excerpt"].text ?? "").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).lineLimit(3)
                .padding(.leading, PhoneTheme.space2)
                .overlay(alignment: .leading) { Rectangle().fill(PhoneTheme.line).frame(width: 2) }
                .accessibilityIdentifier("note-excerpt")
            TextField(PhoneCardWords.notePlaceholder, text: comment, axis: .vertical).lineLimit(1...4)
                .padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                .phoneInput()
                .focused($focused)
                .accessibilityLabel(PhoneCardWords.noteCommentLabel)
                .accessibilityIdentifier("note-comment")
            if hint {
                Text(PhoneCardWords.noteDiscardHint).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("note-hint")
            }
            HStack(spacing: PhoneTheme.space2) {
                Spacer(minLength: 0)
                Button(PhoneCardWords.noteCancel) { pick = nil }
                    .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("note-cancel")
                Button(PhoneCardWords.queueNote) { onQueue(false) }
                    .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("note-queue")
                // Command-Return from a keyboard queues the note and sends the reply, as the Mac's does.
                Button("") { onQueue(true) }.keyboardShortcut(.return, modifiers: .command)
                    .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
            }
        }
        .padding(PhoneTheme.space4)
        .frame(idealWidth: 320, maxWidth: 360)
        .presentationCompactAdaptation(.popover)
        // A comment is not lost to a stray tap outside: Cancel discards it, as the hint says.
        .interactiveDismissDisabled(!(pick?.comment.isEmpty ?? true))
        .onKeyPress(.escape) {
            if pick?.comment.isEmpty ?? true { pick = nil } else { hint = true }
            return .handled
        }
        .onAppear { focused = true }
        // A containing element, so its parts keep their own names.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("note-popover")
    }
}

/// The notes waiting for the reply, above the card's field: how many, then each with what it points at, its comment,
/// Edit and Remove. The field's send takes them all.
struct PhoneQueuedNotes: View {
    let notes: [PhoneJSON]
    let disabled: Bool
    let onEdit: (PhoneJSON) -> Void
    let onRemove: (PhoneJSON) -> Void
    /// A note whose Edit could not show its part, and why.
    let failures: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneCardWords.queuedNotes(notes.count)).font(PhoneFont.mono).foregroundStyle(PhoneTheme.accent)
                .accessibilityIdentifier("queued-notes-count")
            ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                VStack(alignment: .leading, spacing: 2) {
                    Text(PhoneCardNotes.label(note)).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).lineLimit(2)
                    Text(note["comment"].text.flatMap { $0.isEmpty ? nil : $0 } ?? PhoneCardWords.emptyNote)
                        .font(PhoneFont.caption).foregroundStyle(PhoneTheme.text).lineLimit(3)
                    if let failure = failures[Self.id(note)] {
                        Text(failure).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("queued-note-status")
                    }
                    HStack(spacing: PhoneTheme.space3) {
                        Text(PhoneCardWords.notSent).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                        Spacer(minLength: 0)
                        Button(PhoneCardWords.noteEdit) { onEdit(note) }.font(PhoneFont.caption)
                            .frame(minHeight: 32).accessibilityIdentifier("queued-note-edit")
                        Button(PhoneCardWords.noteRemove) { onRemove(note) }.font(PhoneFont.caption)
                            .frame(minHeight: 32).accessibilityIdentifier("queued-note-remove")
                    }.disabled(disabled)
                }
                .padding(.leading, PhoneTheme.space2)
                .overlay(alignment: .leading) { Rectangle().fill(PhoneTheme.accent).frame(width: 2) }
                .accessibilityElement(children: .contain).accessibilityIdentifier("queued-note")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func id(_ note: PhoneJSON) -> String {
        "\(note["key"].text ?? "")|\(note["start"].numeric ?? 0)|\(note["span"]["start"].numeric ?? -1)|\(note["span"]["end"].numeric ?? -1)"
    }
}

/// A sent reply's notes in its thread: each names what it points at, a press lights it in the card, and a part the card
/// no longer has, or a body that cannot show it, says so.
struct PhoneThreadNotes: View {
    let notes: [PhoneJSON]
    let onReveal: ((PhoneJSON) async -> CardWebHost.NoteReveal)?
    @State private var results: [Int: CardWebHost.NoteReveal] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            ForEach(Array(notes.enumerated()), id: \.offset) { index, note in
                VStack(alignment: .leading, spacing: 2) {
                    Button {
                        guard let onReveal else { return }
                        Task { results[index] = await onReveal(note) }
                    } label: {
                        Text(PhoneCardNotes.label(note)).font(PhoneFont.caption).foregroundStyle(PhoneTheme.accent)
                            .multilineTextAlignment(.leading).frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(onReveal == nil).accessibilityIdentifier("thread-note")
                    Text(note["comment"].text.flatMap { $0.isEmpty ? nil : $0 } ?? PhoneCardWords.emptyNote).textSelection(.enabled)
                    switch results[index] {
                    case .missing:
                        Text(PhoneCardWords.staleNote).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                            .accessibilityIdentifier("thread-note-status")
                    case .unavailable:
                        Text(PhoneCardWords.unavailableNote).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                            .accessibilityIdentifier("thread-note-status")
                    default: EmptyView()
                    }
                }
                .padding(.leading, PhoneTheme.space2)
                .overlay(alignment: .leading) { Rectangle().fill(PhoneTheme.line).frame(width: 2) }
            }
        }
    }
}
