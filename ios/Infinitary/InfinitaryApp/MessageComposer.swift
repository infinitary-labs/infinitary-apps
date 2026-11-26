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
    @State private var problem: String?
    @State private var sent = 0
    @FocusState private var focused: Bool
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// INF-6366: the Conversation, open at the strip round pressed, and what it read, kept only while a card a tile
    /// opened is in front.
    @State private var conversationOpen: ConversationOpening?
    @State private var conversation = PhoneConversationModel()
    /// The reading clock (docs/composer.md "The last turn"): the reply it counts, the time left, and whether it faded.
    @State private var fadeKey: String?
    @State private var remaining = Self.readingTime
    @State private var faded = false
    /// INF-6763's plan, part 3: the message an Edit put back in the box, which the next send replaces; and the clock the
    /// revert icon reads, moved on when the newest message leaves the minute.
    @State private var replacing: String?
    @State private var now = Date()

    /// The Mac's `READING_MS` (src/renderer/src/app/lastTurnFade.ts): the captain's choice.
    private static let readingTime = Duration.seconds(15)

    private var compact: Bool { phoneOnItsSide(verticalSize) }
    private var draftLayout: AnyLayout {
        compact ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: PhoneTheme.space2))
    }

    private var canSend: Bool {
        session.canMessage && !loading && !(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty)
            && (session.canChange || photos.isEmpty)
    }

    private struct TurnReading: Equatable {
        let mark: PhoneTurnMark?
        let reply: String?
        let words: String?
        let rounds: [String]
    }

    private var turnReading: TurnReading {
        TurnReading(mark: PhoneTurnMark(session.lastTurn), reply: session.lastTurn?.reply?.text,
                    words: session.lastTurn?.reply?.words, rounds: session.stripRounds.map(\.id))
    }

    /// The newest message's id while it may be taken back from this phone (docs/composer.md, "Taking back").
    private var revertible: String? {
        guard session.canTakeBack, let newest = session.stripRounds.first else { return nil }
        return PhoneTakeBack.revertible(newest, now: now)
    }

    typealias Photo = PhonePhoto

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            // INF-589 item 17: on its side an iPhone gives the card this height; the last turn returns upright.
            if !session.stripRounds.isEmpty, !compact, !messageContext.replyTucked { lastTurn(session.stripRounds) }
            // The Mac's mark on a recalled draft: an Edit put the newest message's words back, and the next send replaces
            // it; the cross keeps the words and sends them as a new message.
            if let replacing, replacing == revertible {
                HStack(spacing: 6) {
                    Image(systemName: "pencil").foregroundStyle(PhoneTheme.muted)
                    Text(PhoneMessages.composerReplacesLast()).foregroundStyle(PhoneTheme.secondary)
                        .accessibilityIdentifier("replacing-mark")
                    Spacer(minLength: 0)
                    Button { self.replacing = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(PhoneTheme.secondary)
                            .frame(width: 44, height: 32).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(PhoneMessages.phoneComposerSendAsNew())
                        .accessibilityIdentifier("replacing-drop")
                }.font(PhoneFont.caption).padding(.leading, PhoneTheme.space3)
            }
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
                                }.accessibilityLabel(PhoneMessages.phoneCommonRemovePhoto()).accessibilityIdentifier("photo-chip")
                            }
                        }
                    }.frame(maxWidth: compact ? 96 : .infinity)
                }
                // INF-1517, the captain's pick from ChatGPT's input: 48 points tall, the photo glyph 16 points in,
                // the words 52 points in, and send a 32-point circle 8 points from the end, each in a 44-point touch area.
                HStack(alignment: .bottom, spacing: 0) {
                    PhotosPicker(selection: $selection, maxSelectionCount: max(1, PhoneLimits.images - photos.count), matching: .images) {
                        // The glyph is about 22 points wide, centered in its 44: 5 + 11 puts it 16 in. The inset stays
                        // inside the button, so its frame starts where the box does, on the reading column.
                        Label(PhoneMessages.phoneComposerPhotos(), systemImage: "photo").labelStyle(.iconOnly).frame(width: 44, height: 48)
                            .padding(.leading, 5).contentShape(Rectangle())
                    }.disabled(loading || photos.count >= PhoneLimits.images || session.messagesWhileReading)
                        // The box's text color overrides the system's disabled look, so between versions the
                        // photo glyph dims itself: only words can go until Infinitary is updated.
                        .opacity(session.messagesWhileReading ? 0.35 : 1)
                        .accessibilityIdentifier("add-photos")
                    TextField(PhoneMessages.phoneComposerPlaceholder(), text: $text, axis: .vertical)
                        // With a Pencil in hand the box reserves four lines, as Apple's own handwriting fields do.
                        .lineLimit(messageContext.pencilRoom ? 4...4 : 1...(compact ? 2 : 4)).focused($focused)
                        .padding(.vertical, PhoneTheme.space3).frame(minHeight: 48)
                        .padding(.leading, 3)
                        .accessibilityIdentifier("message-box")
                        .simultaneousGesture(TapGesture().onEnded { messageContext.replyTucked = false })
                    Button { send() } label: {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(PhoneTheme.onAccent)
                            .frame(width: 32, height: 32)
                            .background(canSend ? PhoneTheme.accent : PhoneTheme.muted, in: Circle())
                            .frame(width: 44, height: 48).padding(.trailing, 2).contentShape(Rectangle())
                    }
                        // INF-1208's direction C: a panel's own field beside Home on a foldable's pages, such as a
                        // record's steer box, takes Command-Return for its own send while it holds focus.
                        .keyboardShortcut(messageContext.panelFieldFocused ? nil : KeyboardShortcut(.return, modifiers: .command))
                        .disabled(!canSend)
                        .accessibilityLabel(PhoneMessages.phoneCommonSend())
                        .accessibilityIdentifier("send-message")
                        // INF-3106 direction B: the keyboard-down circle before send, matching its 32 points.
                        .hidesKeyboardBefore(focused && messageContext.keyboardUp, diameter: 32, height: 48)
                }
                    // INF-589 item 11: out of reach, the input dims; a draft stays typeable and is kept. INF-3462: only what
                    // the box holds dims, so its glass keeps blurring the crew scene that passes behind it.
                    .opacity(session.canMessage ? 1 : 0.5)
                    .phoneInput(floating: true)
            }
            if loading { ProgressView(PhoneMessages.phoneComposerAddingPhotos()) }
            // INF-4012 piece 2: reading only, the first mate still hears plain words, and the line says so.
            if let words = session.messageLine ?? session.changesOffLine {
                Text(words).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    .accessibilityIdentifier("connection-refusal")
            }
            // INF-4012's direction 1: between versions, or while it moves, the computer's own update, with Update.
            PhoneHomeUpdateControls(session: session)
            // INF-2553: on its side there is no notice pill, so a message taken back says why here, as a refusal did before.
            if let problem = problem ?? (compact ? session.takenBack[PhoneIntent.messagePlace] : nil) {
                Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("message-problem")
            }
        }.font(PhoneFont.callout).padding(.top, compact ? PhoneTheme.space2 : PhoneTheme.space3)
            // INF-589 item 15: the message box lines up with the card above it, inside the gutters the footer keeps.
            .frame(maxWidth: PhoneColumn.inside).frame(maxWidth: .infinity)
            .task(id: selection) { await loadPhotos() }
            .onChange(of: focused) { _, focused in
                messageContext.composerFocused = focused
                if focused { messageContext.replyTucked = false }
            }
            .onChange(of: turnReading) { messageContext.replyTucked = false }
            // An emptied box replaces nothing: the next words are a new message, as on the Mac.
            .onChange(of: text) { _, text in if text.isEmpty && photos.isEmpty { replacing = nil } }
            .onDisappear { if focused { messageContext.composerFocused = false } }
            // INF-1524: a card's draft button puts its words at the start of the box, unsent, for the captain to finish.
            .onChange(of: messageContext.draft, initial: true) { _, draft in
                guard let draft else { return }
                messageContext.draft = nil
                text = text.isEmpty ? draft : "\(draft) \(text)"
                focused = true
            }
            // INF-589 item 12: a soft tap once the computer accepts the message.
            .sensoryFeedback(.phone, trigger: sent)
            .sheet(item: $conversationOpen) { opening in
                PhoneConversationSheet(session: session, model: conversation, landing: opening.landing, openCard: openCard)
            }
            // A card a tile opened: once Home showed it and it left, the Conversation comes back as it was.
            .onChange(of: messageContext.card) { _, card in
                guard let opened = conversation.opened else { return }
                if card == .current(opened.id) || card == .past(opened.id) { conversation.opened?.shown = true }
                else if opened.shown { conversation.opened = nil; conversationOpen = ConversationOpening(landing: nil) }
            }
            .onChange(of: messageContext.cardsVisible) { _, visible in if !visible { conversation.opened = nil } }
    }

    /// The Mac's last turn (src/renderer/src/app/LastTurn.tsx), drawn as INF-1770's Chat layout: the last two rounds, the
    /// older at half strength and only the newest while a card is up. A message round is the captain's words in a soft
    /// grey bubble on the right and the first mate's reply beside its mark on the left; while the first mate works, the
    /// newest round's mark turns ember and spins (INF-2483), beside its reply or Working…. A card round (INF-6337's plan)
    /// is one row: a card glyph and the card's title, then the button's words in an outlined bubble or the typed words in
    /// the filled one; every press on it opens the Conversation, whose tile opens the card (INF-6623's plan). After 15 seconds of a complete newest round on screen the older round
    /// dissolves and keeps its room, so the input never moves. INF-1846 chose "A quiet glance": 15-point rows, 12 points
    /// between rounds and 12 above the box, one line each. With the box at the top for Apple Pencil only the newest round
    /// shows, card or no card, so a card coming or going never moves the box. Pressing a round anywhere else opens the
    /// Conversation at it.
    private func lastTurn(_ rounds: [PhoneConversationRound]) -> some View {
        let key = PhoneConversation.fadeKey(rounds[0])
        let hidden = faded && key != nil && key == fadeKey
        // The count runs only while Home is shown, the app is open, the phone is upright and the first mate is idle.
        let readable = messageContext.cardsVisible && phase == .active && !compact && !session.firstmateBusy
        let cardUp = messageContext.cardsVisible && messageContext.cardShown
        let older = cardUp || messageContext.pencilRoom || rounds.count < 2 ? nil : rounds[1]
        return VStack(spacing: 12) {
            if let older {
                round(older, newest: false)
                    .opacity(hidden ? 0 : 1).accessibilityHidden(hidden).disabled(hidden)
            }
            round(rounds[0], newest: true)
        }.font(PhoneFont.subheadline).lineLimit(1)
            // The composer's stack adds 8 points; these 4 make the 12 above the box.
            .frame(maxWidth: .infinity).padding(.bottom, 4)
            .task(id: "\(key ?? "")|\(readable)") { await read(key, readable: readable) }
            // The revert icon and Edit leave when the minute ends: the clock moves on then and draws the strip again.
            .task(id: PhoneTakeBack.remaining(rounds[0], now: now) == nil ? nil : rounds[0].askId) {
                guard let left = PhoneTakeBack.remaining(rounds[0], now: Date()) else { return }
                try? await Task.sleep(for: left)
                if !Task.isCancelled { now = Date() }
            }
    }

    /// One round: the captain's bubble, then the first mate's line, 4 points apart. The bubble hugs its words up to three
    /// quarters of the column, and the reply row is 24 points tall, in the secondary colour, pressable across its width.
    /// A card round has no reply row unless its words were also a message. The older round's identifiers carry `older`.
    private func round(_ round: PhoneConversationRound, newest: Bool) -> some View {
        let id = newest ? "last-turn" : "last-turn-older"
        let busy = newest && session.firstmateBusy && round.sentAsMessage
        let strength = newest ? 1.0 : 0.5
        // A press opens the Conversation afresh (docs/composer.md, "The conversation"): only the return after a tile's
        // card keeps the reading. A round the phone made itself is on no page, so the Conversation lands on the newest.
        let open = {
            conversation = PhoneConversationModel()
            conversationOpen = ConversationOpening(landing: PhoneConversation.heldOnPhone(round) ? nil : round.id)
        }
        return VStack(alignment: .leading, spacing: 4) {
            if let card = round.card {
                cardRow(round, card: card, id: id, working: newest && session.firstmateBusy && !round.sentAsMessage, open: open)
                    .opacity(strength)
            } else {
                BubbleColumn {
                    HStack(spacing: 4) {
                        // The captain's words on the plan: a revert icon, never a button reading Take back.
                        if newest, let ask = revertible, ask == round.askId {
                            Button { Task { await session.takeBack(ask: ask) } } label: {
                                Image(systemName: "arrow.uturn.backward").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(PhoneTheme.secondary).frame(width: 44, height: 32).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityLabel(PhoneMessages.shellLastTurnRevert())
                                .accessibilityIdentifier("\(id)-revert")
                        }
                        if round.takenBack {
                            Text(PhoneMessages.shellLastTurnReverted()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                                .fixedSize().accessibilityIdentifier("\(id)-reverted")
                        }
                        bubble(round, id: id, open: open)
                    }.opacity(strength)
                }
            }
            if round.sentAsMessage && (round.reply != nil || busy || (newest && session.messageSending && round.card == nil)) {
                HStack(spacing: 8) {
                    MateMark(working: busy, still: reduceMotion).frame(width: 16, height: 16)
                    if let reply = round.reply {
                        Button(action: open) {
                            WholeWordsLine(words: reply.shown).foregroundStyle(reply.problem == true ? PhoneTheme.danger : PhoneTheme.secondary)
                                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityHint(PhoneMessages.phoneComposerConversationHint())
                            .accessibilityIdentifier("\(id)-reply")
                    } else if newest && session.messageSending {
                        // INF-2553: the message is the last turn at the tap, marked sending until the computer has it.
                        Text(PhoneMessages.phoneCommonSendingEllipsis()).foregroundStyle(PhoneTheme.muted)
                            .frame(minHeight: 24).accessibilityElement(children: .combine).accessibilityIdentifier("last-turn-sending")
                    } else {
                        Text(PhoneMessages.phoneComposerWorking()).foregroundStyle(PhoneTheme.muted)
                            .frame(minHeight: 24).accessibilityElement(children: .combine).accessibilityIdentifier("\(id)-reply")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).opacity(strength)
            } else if round.card == nil {
                Text(verbatim: " ").frame(minHeight: 24).accessibilityHidden(true)
            }
        }
    }

    /// The captain's words in the bubble: filled for words they wrote, outlined for a button's own words. INF-3462, the
    /// captain's pick: the bubble is solid in the colour it always showed, so the crew scene passing behind it is hidden.
    /// A message's bubble stays words with a tap, its reply line the round's button; a card round's bubble is its button.
    @ViewBuilder
    private func bubble(_ round: PhoneConversationRound, id: String, open: @escaping () -> Void) -> some View {
        let shape = PhoneConversationBubble()
        let choice = round.kind == .choice
        // A message taken back, as on the Mac: its words struck in the muted colour, its bubble faint.
        let struck = round.takenBack
        let words = WholeWordsLine(words: round.you.isEmpty ? PhoneMessages.phoneComposerPictureOnly() : round.you)
            .strikethrough(struck).foregroundStyle(struck ? PhoneTheme.muted : PhoneTheme.text)
            .padding(.vertical, 4).padding(.horizontal, 12)
            .background(choice ? Color.clear : PhoneTheme.text.opacity(struck ? 0.04 : 0.1), in: shape)
            .overlay { if choice { shape.stroke(PhoneTheme.text.opacity(0.3), lineWidth: 1) } }
            .background(PhoneTheme.background, in: shape)
            .contentShape(shape)
        if round.card == nil, let ask = revertible, ask == round.askId, id == "last-turn" {
            // Plan part 3: a long press on the newest message offers Revert and Edit.
            words.onTapGesture(perform: open).accessibilityIdentifier("\(id)-you")
                .contextMenu {
                    Button { Task { await session.takeBack(ask: ask) } } label: {
                        Label(PhoneMessages.shellLastTurnRevert(), systemImage: "arrow.uturn.backward")
                    }.accessibilityIdentifier("last-turn-menu-revert")
                    Button { edit(round, ask: ask) } label: {
                        Label(PhoneMessages.phoneComposerEditLast(), systemImage: "pencil")
                    }.accessibilityIdentifier("last-turn-menu-edit")
                }
        } else if round.card == nil {
            words.onTapGesture(perform: open).accessibilityIdentifier("\(id)-you")
        } else {
            Button(action: open) { words }.buttonStyle(.plain)
                .accessibilityHint(PhoneMessages.phoneComposerConversationHint()).accessibilityIdentifier("\(id)-you")
        }
    }

    /// A card round's one row: the card glyph and title on the left and the bubble on the right, each opening the
    /// Conversation at the round; the card itself opens from the Conversation's tile (INF-6623's plan).
    /// A round that is not also a message has no reply line, so while it is the newest and the first mate works the row
    /// starts with the spinning mark and no words, at its own height (INF-6365's review, the captain's choice).
    private func cardRow(_ round: PhoneConversationRound, card: PhoneConversationRound.Card, id: String, working: Bool,
                         open: @escaping () -> Void) -> some View {
        HStack(spacing: PhoneTheme.space2) {
            if working {
                MateMark(working: true, still: reduceMotion).frame(width: 16, height: 16)
                    .accessibilityElement(children: .ignore).accessibilityLabel(PhoneMessages.phoneComposerWorking())
                    .accessibilityIdentifier("\(id)-card-working")
            }
            Button(action: open) {
                HStack(spacing: 6) {
                    Image(systemName: "rectangle.portrait").font(.system(size: 11)).foregroundStyle(PhoneTheme.muted)
                    WholeWordsLine(words: card.title).foregroundStyle(PhoneTheme.secondary)
                }.frame(minHeight: 28).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint(PhoneMessages.phoneComposerConversationHint())
                .accessibilityIdentifier("\(id)-card")
            Spacer(minLength: 0)
            bubble(round, id: id, open: open).layoutPriority(1)
        }.frame(maxWidth: .infinity)
    }

    /// A card from a Conversation tile, shown on Home: one on the stage comes forward, one put aside comes
    /// back first, and an ended one opens as a past card. The Conversation steps away while it shows.
    private func openCard(_ id: String) {
        let leave = {
            conversation.opened = .init(id: id, shown: messageContext.card == .current(id) || messageContext.card == .past(id))
            conversationOpen = nil
        }
        if let card = session.cards.first(where: { $0.id == id }), card.awaiting == nil || card.sentBackAt != nil {
            if card.minimized {
                guard session.canChange else { return }
                Task { try? await session.change(.bringBack(card: id), .minimize, [.string(id), .bool(false)]) }
            }
            if conversationOpen != nil { leave() }
            messageContext.restoring = id
            return
        }
        Task {
            try? await session.readPast(id)
            guard session.pastCards.contains(where: { $0.id == id }) else { return }
            if conversationOpen != nil { leave() }
            messageContext.pastCard = id
        }
    }

    /// A new newest round starts a fresh 15 seconds; leaving Home, the background, a turn on its side or work in flight
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

    /// Edit on the newest message: its words come back to the box, in front of anything typed, marked as replacing it.
    private func edit(_ round: PhoneConversationRound, ask: String) {
        text = text.isEmpty ? round.you : round.you + "\n" + text
        replacing = ask
        messageContext.replyTucked = false
        focused = true
    }

    /// INF-2553: the box clears at the tap and the message is the last turn, marked sending; a refusal puts the words and
    /// pictures back in front of anything typed since, and the session says why.
    private func send() {
        guard !loading, session.canMessage else { return }
        // Reading only, words alone go, as one plain string: no photos and no hints (`messages-while-reading`).
        let plain = !session.canChange
        guard !plain || photos.isEmpty else { return }
        guard text.utf16.count <= PhoneLimits.text else { problem = PhoneMessages.phoneComposerTooLong(); return }
        let words = text, pictures = photos
        var payload: [String: Any] = ["text": words, "images": pictures.map(\.wire)]
        for (key, value) in messageContext.fields { payload[key] = value }
        // Only the newest message inside the minute is replaced, and never by plain words to a computer between versions.
        let replaces = plain ? nil : replacing.flatMap { $0 == revertible ? $0 : nil }
        if let replaces { payload["replaces"] = replaces }
        let args: [Any] = plain ? [words] : [payload]
        replacing = nil
        focused = false
        problem = nil
        text = ""; photos = []
        // The computer keeps the words trimmed, and its turn for them follows the last turn shown now.
        let intent = PhoneIntent.Kind.send(text: words.trimmingCharacters(in: .whitespacesAndNewlines), before: PhoneTurnMark(session.lastTurn))
        Task {
            do {
                let box = $text, shelf = $photos
                let restore: @MainActor () -> Void = { @MainActor in
                    box.wrappedValue = box.wrappedValue.isEmpty ? words : words + "\n" + box.wrappedValue
                    shelf.wrappedValue = Array((pictures + shelf.wrappedValue).prefix(PhoneLimits.images))
                }
                if let replaces { try await session.replace(replaces, with: intent, args: args, restore: restore) }
                else { try await session.change(intent, .converse, args: args, restore: restore) }
                sent += 1
            } catch {}
        }
    }

    private func loadPhotos() async {
        guard !selection.isEmpty else { return }
        loading = true; problem = nil
        defer { loading = false; selection = [] }
        for item in selection {
            do {
                guard photos.count < PhoneLimits.images, let bytes = try await item.loadTransferable(type: Data.self) else {
                    throw PhoneError.refused(PhoneMessages.phoneComposerPhotoFailed())
                }
                try Task.checkCancellation()
                photos.append(try PhonePhoto(bytes: bytes))
            } catch is CancellationError { return }
            catch { problem = error.localizedDescription }
        }
    }
}

/// The captain's bubble on the right, hugging its words up to three quarters of the width it is offered.
struct BubbleColumn: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let bubble = subviews.first?.sizeThatFits(widest(proposal.width)) ?? .zero
        return CGSize(width: proposal.width ?? bubble.width, height: bubble.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let bubble = subviews.first else { return }
        let offered = widest(bounds.width)
        bubble.place(at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing, proposal: offered)
    }

    private func widest(_ width: CGFloat?) -> ProposedViewSize {
        ProposedViewSize(width: width.map { $0 * 0.75 }, height: nil)
    }
}

/// One line of words cut after its last whole word that fits, as the Mac cuts its last turn (`WholeWords`). The text
/// keeps every word for a reader and its own ellipsis; the line only offers it the width of the words it shows. Before
/// iOS 26 the text's own font is out of reach, so the line keeps the text's own cut.
private struct WholeWordsLine: View {
    let words: String
    @Environment(\.font) private var font
    @Environment(\.fontResolutionContext) private var fontContext

    var body: some View {
        if #available(iOS 26, *) {
            WholeWordsFit(words: words, font: (font ?? .body).resolve(in: fontContext)) { Text(words) }
        } else {
            Text(words)
        }
    }
}

/// Offers its one text the width `WholeWords` gives for the room it is offered, so the text's own tail cut falls right
/// after a whole word, and takes the text's size.
@available(iOS 26, *)
private struct WholeWordsFit: Layout {
    let words: String
    let font: Font.Resolved

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(offer(proposal)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // The room offered, not the narrower size the text took, so the cut stays where it was measured.
        subviews.first?.place(at: bounds.origin, proposal: offer(proposal))
    }

    private func offer(_ proposal: ProposedViewSize) -> ProposedViewSize {
        guard let room = proposal.width, room.isFinite, let width = WholeWords.width(for: words, font: font.ctFont, room: room) else { return proposal }
        return ProposedViewSize(width: width, height: proposal.height)
    }
}

/// The Conversation's opening from the strip: at the round pressed, or where it was left.
private struct ConversationOpening: Identifiable {
    let id = UUID()
    let landing: String?
}

/// The first mate's mark beside each reply line: the app's hexagon in accent, as the Mac draws it (lastTurn.css,
/// LastTurn.tsx). While the first mate works it turns ember over 0.16 s and spins one steady turn every 2 s (INF-2483's
/// plan, the captain's Approve and build: "turn the mark to orange and spin it"); when work ends it eases on to its next
/// resting sixth of a turn over 0.36 s as it fades back to accent. Under reduced motion it turns ember and stands still.
struct MateMark: View {
    let working: Bool
    let still: Bool
    /// One whole turn, in seconds: INF-2483's chosen steady turn.
    static let turn = 2.0
    @State private var started = Date()
    @State private var resting = 0.0

    var body: some View {
        TimelineView(.animation(paused: !working || still)) { clock in
            ZStack {
                MarkHexagon(points: [(8, 1.2), (13.9, 4.6), (13.9, 11.4), (8, 14.8), (2.1, 11.4), (2.1, 4.6)])
                MarkHexagon(points: [(12, 8), (10, 11.46), (6, 11.46), (4, 8), (6, 4.54), (10, 4.54)]).opacity(0.45)
                MarkDot()
            }
            .foregroundStyle(working ? PhoneTheme.hot : PhoneTheme.accent)
            .rotationEffect(.degrees(working && !still ? angle(at: clock.date) : resting))
        }
        .animation(.linear(duration: working ? 0.16 : 0.36), value: working)
        .onChange(of: working) { was, now in
            if now { started = Date(); resting = 0; return }
            guard was, !still else { resting = 0; return }
            let at = angle(at: Date())
            resting = at
            withAnimation(.easeOut(duration: 0.36)) { resting = (at / 60).rounded(.up) * 60 }
        }
        .onAppear { started = Date() }
        .accessibilityHidden(true)
    }

    private func angle(at date: Date) -> Double {
        let turns = date.timeIntervalSince(started) / Self.turn
        return (turns - turns.rounded(.down)) * 360
    }
}

/// A hexagon of the mark as its 1.2-unit outline, its points on the mark's 16-unit grid, drawn at any size.
private struct MarkHexagon: Shape {
    let points: [(CGFloat, CGFloat)]
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 16
        var path = Path()
        path.addLines(points.map { CGPoint(x: rect.minX + $0.0 * scale, y: rect.minY + $0.1 * scale) })
        path.closeSubpath()
        return path.strokedPath(StrokeStyle(lineWidth: 1.2 * scale))
    }
}

/// The mark's centre dot, 1.3 units of 16 in radius.
private struct MarkDot: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 16
        let dot = 1.3 * scale
        return Path(ellipseIn: CGRect(x: rect.midX - dot, y: rect.midY - dot, width: dot * 2, height: dot * 2))
    }
}

/// A photo the captain adds to a message or a card's reply: scaled to at most 2,048 pixels and sent as a JPEG.
struct PhonePhoto: Identifiable {
    let id = UUID()
    let data: Data
    let image: UIImage
    var wire: [String: String] { ["mimeType": "image/jpeg", "data": data.base64EncodedString(), "name": "Photo.jpg"] }

    init(bytes: Data) throws {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
              ] as CFDictionary) else { throw PhoneError.refused(PhoneMessages.phoneComposerPhotoFailed()) }
        try self.init(image: UIImage(cgImage: thumbnail))
    }

    init(image: UIImage) throws {
        guard let data = image.jpegData(compressionQuality: 0.85), data.count <= 5 * 1024 * 1024,
              ((data.count + 2) / 3) * 4 <= PhoneLimits.imageBase64 else {
            throw PhoneError.refused(PhoneMessages.phoneComposerPhotoTooLarge())
        }
        self.data = data; self.image = image
    }
}
