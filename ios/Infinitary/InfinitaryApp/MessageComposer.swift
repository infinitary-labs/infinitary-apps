import ImageIO
import InfinitaryKit
import PhotosUI
import SwiftUI

struct MessageComposer: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @State private var text = ""
    @State private var photos: [Photo] = []
    @State private var selection: [PhotosPickerItem] = []
    @State private var loading = false
    @State private var sending = false
    @State private var problem: String?
    @State private var sent = 0
    @FocusState private var focused: Bool
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var replyOpen = false
    /// The reading clock (docs/composer.md "The last turn"): the reply it counts, the time left, and whether it faded.
    @State private var fadeKey: String?
    @State private var remaining = Self.readingTime
    @State private var faded = false

    /// The Mac's `READING_MS` (src/renderer/src/app/lastTurnFade.ts): the captain's choice.
    private static let readingTime = Duration.seconds(15)

    private var compact: Bool { phoneOnItsSide(verticalSize) }
    private var draftLayout: AnyLayout {
        compact ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: PhoneTheme.space2))
    }

    private var canSend: Bool {
        session.canChange && !sending && !loading && !(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty)
    }

    struct Photo: Identifiable {
        let id = UUID()
        let data: Data
        let image: UIImage
        var wire: [String: String] { ["mimeType": "image/jpeg", "data": data.base64EncodedString(), "name": "Photo.jpg"] }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            // INF-589 item 17: on its side an iPhone gives the card this height; the last turn returns upright.
            if let turn = session.lastTurn, !compact { lastTurn(turn) }
            // AnyLayout moves the same controls; neither rotation nor a tab creates a second draft.
            draftLayout {
                if !photos.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(photos) { photo in
                                Button { photos.removeAll { $0.id == photo.id } } label: {
                                    Image(uiImage: photo.image).resizable().scaledToFill()
                                        .frame(width: 44, height: 44).clipped()
                                        .overlay(alignment: .topTrailing) { Image(systemName: "xmark.circle.fill").foregroundStyle(PhoneTheme.text, PhoneTheme.surface) }
                                }.accessibilityLabel("Remove photo").accessibilityIdentifier("photo-chip")
                            }
                        }
                    }.frame(maxWidth: compact ? 96 : .infinity).disabled(sending)
                }
                // INF-1517, the captain's pick from ChatGPT's input: 48 points tall, the photo glyph 16 points in,
                // the words 52 points in, and send a 32-point circle 8 points from the end, each in a 44-point touch area.
                HStack(alignment: .bottom, spacing: 0) {
                    PhotosPicker(selection: $selection, maxSelectionCount: max(1, PhoneLimits.images - photos.count), matching: .images) {
                        // The glyph is about 22 points wide, centered in its 44: 5 + 11 puts it 16 in. The inset stays
                        // inside the button, so its frame starts where the box does, on the reading column.
                        Label("Photos", systemImage: "photo").labelStyle(.iconOnly).frame(width: 44, height: 48)
                            .padding(.leading, 5).contentShape(Rectangle())
                    }.disabled(loading || sending || photos.count >= PhoneLimits.images).accessibilityIdentifier("add-photos")
                    TextField("Give your first mate a task", text: $text, axis: .vertical)
                        .lineLimit(1...(compact ? 2 : 4)).focused($focused).disabled(sending)
                        .padding(.vertical, PhoneTheme.space3).frame(minHeight: 48)
                        .padding(.leading, 3)
                        .accessibilityIdentifier("message-box")
                    Button { send() } label: {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(PhoneTheme.onAccent)
                            .frame(width: 32, height: 32)
                            .background(canSend ? PhoneTheme.accent : PhoneTheme.muted, in: Circle())
                            .frame(width: 44, height: 48).padding(.trailing, 2).contentShape(Rectangle())
                    }.keyboardShortcut(.return, modifiers: .command)
                        .disabled(!canSend)
                        .accessibilityLabel("Send")
                        .accessibilityIdentifier("send-message")
                }.phoneInput(floating: true)
                    // INF-589 item 11: out of reach, the input dims; a draft stays typeable and is kept.
                    .opacity(session.canChange ? 1 : 0.5)
            }
            if loading { ProgressView("Adding photos…") }
            if sending { ProgressView("Sending…") }
            if let words = session.changesOffLine {
                Text(words).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    .accessibilityIdentifier("connection-refusal")
            }
            if let problem {
                Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("message-problem")
            }
        }.font(PhoneFont.callout).padding(.top, compact ? PhoneTheme.space2 : PhoneTheme.space3)
            // INF-589 item 15: the message box lines up with the card above it, inside the gutters the footer keeps.
            .frame(maxWidth: PhoneColumn.inside).frame(maxWidth: .infinity)
            .task(id: selection) { await loadPhotos() }
            // INF-589 item 12: a soft tap once the computer accepts the message.
            .sensoryFeedback(.phone, trigger: sent)
    }

    /// The Mac's two lines (src/renderer/src/app/LastTurn.tsx): the captain's words, then the first mate's ember dots
    /// and Working… whenever it is busy, else its reply line, which opens the whole reply. A completed reply fades after
    /// 15 seconds on screen; the pair keeps its room, so the input never moves.
    private func lastTurn(_ turn: PhoneLastTurn) -> some View {
        let key = Self.fadeKey(turn)
        let hidden = faded && key != nil && key == fadeKey
        // The count runs only while Home is shown, the app is open, the phone is upright and the first mate is idle.
        let readable = messageContext.cardsVisible && phase == .active && !compact && !session.firstmateBusy
        return VStack(spacing: 0) {
            Group { turn.you.isEmpty ? Text("A picture") : quoted(turn.you) }
                .foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("last-turn-you")
                .opacity(hidden ? 0 : 1).accessibilityHidden(hidden)
            Group {
                if session.firstmateBusy {
                    HStack(spacing: 6) {
                        WorkingDots(still: reduceMotion)
                        Text("Working…").foregroundStyle(PhoneTheme.muted)
                    }.accessibilityElement(children: .combine)
                } else if let reply = turn.reply {
                    Button { replyOpen = true } label: {
                        quoted(reply.text).foregroundStyle(reply.problem == true ? PhoneTheme.danger : PhoneTheme.text)
                    }.buttonStyle(.plain).accessibilityHint("Opens the whole reply")
                        .opacity(hidden ? 0 : 1).accessibilityHidden(hidden).disabled(hidden)
                } else {
                    Text(verbatim: " ").accessibilityHidden(true)
                }
            }.accessibilityIdentifier("last-turn-reply")
        }.font(PhoneFont.caption).lineLimit(1).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .task(id: "\(key ?? "")|\(readable)") { await read(key, readable: readable) }
            .sheet(isPresented: $replyOpen) { PhoneReplySheet(turn: turn) }
    }

    /// The reply this clock may fade, or nil while the line must stay: a problem, a queued receipt or an unknown line.
    static func fadeKey(_ turn: PhoneLastTurn) -> String? {
        guard let reply = turn.reply, reply.problem != true, reply.eligibility == "completed" else { return nil }
        return "\(turn.you)\u{0}\(reply.text)"
    }

    /// A new reply starts a fresh 15 seconds; leaving Home, the background, a turn on its side or work in flight
    /// pauses the count and keeps what is left. The dissolve takes 0.7 seconds, an instant under reduced motion.
    private func read(_ key: String?, readable: Bool) async {
        if key != fadeKey { fadeKey = key; remaining = Self.readingTime; faded = false }
        guard key != nil, readable, !faded else { return }
        let start = ContinuousClock.now
        do { try await Task.sleep(for: remaining) } catch {
            remaining = max(.zero, remaining - (ContinuousClock.now - start)); return
        }
        remaining = .zero
        withAnimation(reduceMotion ? nil : .linear(duration: 0.7)) { faded = true }
    }

    /// Quotation marks in the faintest ink, so even a bare "Got it" reads as something said.
    private func quoted(_ words: String) -> Text {
        let open = Text(verbatim: "“").foregroundStyle(PhoneTheme.muted), close = Text(verbatim: "”").foregroundStyle(PhoneTheme.muted)
        return Text("\(open)\(words)\(close)")
    }

    private func send() {
        guard !sending, !loading, session.canChange else { return }
        guard text.utf16.count <= PhoneLimits.text else { problem = "This message is too long. Shorten it before sending."; return }
        var payload: [String: Any] = ["text": text, "images": photos.map(\.wire)]
        for (key, value) in messageContext.fields { payload[key] = value }
        focused = false
        sending = true; problem = nil
        Task {
            defer { sending = false }
            do {
                let result: PhoneAnswer = try await session.request(.converse, args: [payload])
                try result.accepted()
                text = ""; photos = []; sent += 1
            } catch { problem = error.localizedDescription }
        }
    }

    private func loadPhotos() async {
        guard !selection.isEmpty else { return }
        loading = true; problem = nil
        defer { loading = false; selection = [] }
        for item in selection {
            do {
                guard photos.count < PhoneLimits.images, let bytes = try await item.loadTransferable(type: Data.self),
                      let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 2048,
                      ] as CFDictionary) else { throw PhoneError.refused("Could not add this photo. Choose another.") }
                try Task.checkCancellation()
                let image = UIImage(cgImage: thumbnail)
                guard let data = image.jpegData(compressionQuality: 0.85), data.count <= 5 * 1024 * 1024,
                      ((data.count + 2) / 3) * 4 <= PhoneLimits.imageBase64 else {
                    throw PhoneError.refused("This photo is too large. Choose a smaller photo.")
                }
                photos.append(Photo(data: data, image: image))
            } catch is CancellationError { return }
            catch { problem = error.localizedDescription }
        }
    }
}

/// The Mac's working dots (lastTurn.css): three 4-point ember dots 3 points apart, each brightening in turn over 1.2 s.
private struct WorkingDots: View {
    let still: Bool
    var body: some View {
        TimelineView(.animation(paused: still)) { clock in
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { dot in
                    Circle().fill(PhoneTheme.hot).frame(width: 4, height: 4)
                        .opacity(still ? 1 : Self.opacity(clock.date.timeIntervalSinceReferenceDate - Double(dot) * 0.2))
                }
            }
        }.accessibilityHidden(true)
    }

    /// 0.25 at rest and 1 at 30% of the cycle, eased in and out, as the Mac's keyframes.
    static func opacity(_ time: Double) -> Double {
        let phase = (time.truncatingRemainder(dividingBy: 1.2) + 1.2).truncatingRemainder(dividingBy: 1.2) / 1.2
        guard phase < 0.6 else { return 0.25 }
        let rise = phase < 0.3 ? phase / 0.3 : (0.6 - phase) / 0.3
        return 0.25 + 0.75 * (0.5 - cos(rise * .pi) / 2)
    }
}

/// INF-1517, the captain's pick: the reply line opens the whole reply in a half-height sheet, as the Mac's reply note.
/// Its title is the captain's message in quotation marks; its body the reply as written, a problem in red.
private struct PhoneReplySheet: View {
    let turn: PhoneLastTurn
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    Text(turn.you.isEmpty ? "A picture" : "“\(turn.you)”").font(PhoneFont.headline)
                        .accessibilityIdentifier("reply-note-title")
                    if let reply = turn.reply {
                        Text(reply.words ?? reply.text).font(PhoneFont.callout)
                            .foregroundStyle(reply.problem == true ? PhoneTheme.danger : PhoneTheme.text)
                            .textSelection(.enabled).accessibilityIdentifier("reply-note-words")
                    }
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .phoneTitle("Reply")
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }.accessibilityIdentifier("close-reply-note")
            } }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).phoneSheetSurface()
    }
}
