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

/// The Mac's annotation popover, drawn by the captain's direction B (INF-3746): a raised panel inside the card, under
/// the part it notes and as wide as the reply box, so nothing floats past the card; on an iPhone on its side it takes the
/// card's foot instead. It holds what is picked, a comment that may stay empty, Cancel and Queue. Return in the comment
/// queues it, Command-Return queues it and sends every queued note, and Escape closes it while the comment is empty.
struct PhoneNoteEditor: View {
    @Binding var pick: PhoneNotePick?
    /// The card's own focus for the comment, which counts as a card text box under the keyboard rules (INF-3468).
    var focused: FocusState<Bool>.Binding
    /// On an iPhone on its side the editor shares the card's short foot with the keyboard, so it drops its title and sets
    /// a short excerpt, the comment and its buttons on one row.
    var compact = false
    let onQueue: (_ send: Bool) -> Void
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
        let shape = RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous)
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if !compact {
                Text("\(PhoneCardWords.annotate) \(pick?.note["kind"].text ?? "")").font(PhoneFont.headline)
                    .accessibilityAddTraits(.isHeader)
            }
            if compact {
                HStack(spacing: PhoneTheme.space2) { excerpt.frame(maxWidth: 160, alignment: .leading); field(comment); buttons }
            } else {
                excerpt
                field(comment)
            }
            if hint {
                Text(PhoneCardWords.noteDiscardHint).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("note-hint")
            }
            if !compact {
                HStack(spacing: PhoneTheme.space2) { Spacer(minLength: 0); buttons }
            }
        }
        .padding(compact ? PhoneTheme.space2 : PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The lift's shadow belongs to the panel's own shape: on the whole stack SwiftUI would cast it from the field and
        // the buttons inside too.
        .background { shape.fill(PhoneTheme.raised).shadow(color: .black.opacity(0.35), radius: 12, y: 8) }
        .overlay { shape.strokeBorder(PhoneTheme.lineStrong) }
        .onKeyPress(.escape) {
            if pick?.comment.isEmpty ?? true { pick = nil } else { hint = true }
            return .handled
        }
        .onAppear { focused.wrappedValue = true }
        // A containing element, so its parts keep their own names.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("note-editor")
    }

    private var excerpt: some View {
        Text(pick?.note["excerpt"].text ?? "").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            .lineLimit(compact ? 1 : 2)
            .padding(.leading, PhoneTheme.space2)
            .overlay(alignment: .leading) { Rectangle().fill(PhoneTheme.line).frame(width: 2) }
            .accessibilityIdentifier("note-excerpt")
    }

    // The app's plain field: the control radius of the buttons beside it, with its words 12 points in.
    private func field(_ comment: Binding<String>) -> some View {
        TextField(PhoneCardWords.notePlaceholder, text: comment, axis: .vertical).lineLimit(compact ? 1...1 : 1...4)
            .textFieldStyle(.phone)
            .focused(focused)
            .accessibilityLabel(PhoneCardWords.noteCommentLabel)
            .accessibilityIdentifier("note-comment")
    }

    @ViewBuilder private var buttons: some View {
        Button(PhoneCardWords.noteCancel) { pick = nil }
            .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("note-cancel")
        Button(PhoneCardWords.queueNote) { onQueue(false) }
            .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("note-queue")
        // Command-Return from a keyboard queues the note and sends the reply, as the Mac's does.
        Button("") { onQueue(true) }.keyboardShortcut(.return, modifiers: .command)
            .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
    }
}

/// INF-3746: one row draws a note, queued or sent: a bar, one line naming what it points at, then the comment. Only the
/// bar's color differs, the accent for a note waiting for the reply.
struct PhoneNoteRow<Head: View, Below: View>: View {
    let note: PhoneJSON
    let queued: Bool
    /// The lines the comment takes at most; nil shows it whole, as a sent note in its thread does.
    let commentLines: Int?
    @ViewBuilder let label: (Text) -> Head
    @ViewBuilder let below: () -> Below

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            label(Text(PhoneCardNotes.label(note)).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary))
            Text(note["comment"].text.flatMap { $0.isEmpty ? nil : $0 } ?? PhoneCardWords.emptyNote)
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.text).lineLimit(commentLines).textSelection(.enabled)
            below()
        }
        .padding(.leading, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1).fill(queued ? PhoneTheme.accent : PhoneTheme.lineStrong).frame(width: 2)
        }
    }
}

/// The notes waiting for the reply, above the card's field: how many, then each with what it points at on one line,
/// its comment on at most two, and Edit and Remove. The field's send takes them all.
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
                PhoneNoteRow(note: note, queued: true, commentLines: 2) { $0.lineLimit(1) } below: {
                    if let failure = failures[Self.id(note)] {
                        Text(failure).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("queued-note-status")
                    }
                    HStack(spacing: PhoneTheme.space4) {
                        Spacer(minLength: 0)
                        Button(PhoneCardWords.noteEdit) { onEdit(note) }
                            .frame(minHeight: 32).contentShape(Rectangle()).accessibilityIdentifier("queued-note-edit")
                        Button(PhoneCardWords.noteRemove) { onRemove(note) }
                            .frame(minHeight: 32).contentShape(Rectangle()).accessibilityIdentifier("queued-note-remove")
                    }
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.accent).buttonStyle(.plain)
                    .disabled(disabled).opacity(disabled ? 0.5 : 1)
                }
                .accessibilityElement(children: .contain).accessibilityIdentifier("queued-note")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func id(_ note: PhoneJSON) -> String {
        "\(note["key"].text ?? "")|\(note["start"].numeric ?? 0)|\(note["span"]["start"].numeric ?? -1)|\(note["span"]["end"].numeric ?? -1)"
    }
}

/// A sent reply's notes in its thread, in the queued notes' row: each names what it points at, a press lights it in the
/// card, and a part the card no longer has, or a body that cannot show it, says so.
struct PhoneThreadNotes: View {
    let notes: [PhoneJSON]
    let onReveal: ((PhoneJSON) async -> CardWebHost.NoteReveal)?
    @State private var results: [Int: CardWebHost.NoteReveal] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            ForEach(Array(notes.enumerated()), id: \.offset) { index, note in
                PhoneNoteRow(note: note, queued: false, commentLines: nil) { label in
                    Button {
                        guard let onReveal else { return }
                        Task { results[index] = await onReveal(note) }
                    } label: {
                        label.lineLimit(1).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(onReveal == nil).accessibilityIdentifier("thread-note")
                } below: {
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
            }
        }
    }
}
