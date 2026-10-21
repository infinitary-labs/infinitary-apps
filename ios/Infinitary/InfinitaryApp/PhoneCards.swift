import InfinitaryKit
import SwiftUI

struct PhoneCards: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @State private var selected: String?
    @State private var past: PhoneCard?
    @State private var drafts: [String: PhoneJSON] = [:]
    @State private var replies: [String: String] = [:]
    @State private var previousIDs: [String] = []
    @State private var sent = 0
    private var card: PhoneCard? { past ?? session.cards.first(where: { $0.id == selected }) ?? session.cards.first }

    var body: some View {
        VStack(spacing: PhoneTheme.space3) {
            if let card {
                PhoneCardPane(card: card, session: session,
                    fill: card.isPast ? card.value["answers"] : drafts[card.id] ?? .array([]),
                    reply: Binding(get: { replies[card.id] ?? "" }, set: { replies[card.id] = $0 }),
                    onReading: { drafts[card.id] = $0["answers"] },
                    onSeen: { session.markSeen(card) },
                    onHide: { past = nil },
                    onPage: { page($0) },
                    onSent: { sent += 1 },
                    showsNext: past == nil && index < session.cards.count - 1, visible: messageContext.cardsVisible,
                    replyLeaves: !card.value["holdsPlace"].flag && session.cards.count > 1)
                    .id("\(card.id):\(card.offerID ?? card.body):\(card.isPast)")
            } else {
                VStack(spacing: PhoneTheme.space3) {
                    PhoneCharacter(state: session.firstmateBusy ? .working : .idle).frame(width: 200, height: 200)
                    Text("No cards to read yet.").font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(.vertical, PhoneTheme.space5)
            }
            // INF-589 item 11: with no card to page, the pager hides; Past cards stays reachable while there are any.
            if !session.cards.isEmpty || !session.pastCards.isEmpty { pager }
        }
        .padding(.horizontal, PhoneTheme.space4).frame(maxWidth: PhoneColumn.width).frame(maxWidth: .infinity)
        .background(PhoneTheme.background)
        // INF-589 item 12: a soft tap once the computer accepts an answer or a reply; never on a page turn.
        .sensoryFeedback(.phone, trigger: sent)
        .onChange(of: card.map { $0.isPast ? PhoneMessageContext.Card.past($0.id) : .current($0.id) }, initial: true) { _, shown in
            messageContext.card = shown
        }
        .onChange(of: session.cards.map(\.id), initial: true) { _, ids in
            if let marked = session.cards.first(where: { !previousIDs.contains($0.id) && $0.value["holdsPlace"].flag }) {
                selected = marked.id; past = nil
            } else if selected == nil || !ids.contains(selected!) {
                selected = session.cards.first(where: { !session.seenCards.contains($0.offerID ?? $0.id) })?.id ?? ids.first
            }
            previousIDs = ids
            if let past, ids.contains(past.id) { self.past = nil }
        }
        .onChange(of: session.showCardID, initial: true) { _, id in
            guard let id else { return }
            if session.cards.contains(where: { $0.id == id }) { selected = id; past = nil }
            else { past = session.pastCards.first { $0.id == id } }
            session.showCardID = nil
        }
    }
    private var pager: some View {
        HStack(spacing: PhoneTheme.space2) {
            if !session.cards.isEmpty {
                Button { page(-1) } label: { Label("Previous card", systemImage: "chevron.left").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44) }
                    .disabled(past != nil || index <= 0).accessibilityIdentifier("previous-card")
                    .keyboardShortcut("[", modifiers: [.command, .shift])
            }
            Menu {
                ForEach(session.cards) { item in
                    Button(item.title) { selected = item.id; past = nil }
                }
                if !session.pastCards.isEmpty {
                    Section("Past cards") {
                        ForEach(session.pastCards) { item in Button(item.title) { past = item } }
                    }
                }
            } label: {
                Text(past != nil ? "Past card" : session.cards.isEmpty ? "Past cards" : "\(index + 1) of \(session.cards.count)")
                    .font(.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption))
                    .frame(minWidth: 44, minHeight: 44)
            }.accessibilityIdentifier("card-pager")
            if !session.cards.isEmpty {
                Button { page(1) } label: {
                    Label("Next card", systemImage: "chevron.right").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                        .overlay(alignment: .topTrailing) {
                            if session.cards.dropFirst(index + 1).contains(where: { !session.seenCards.contains($0.offerID ?? $0.id) }) {
                                Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6).accessibilityHidden(true)
                            }
                        }
                }
                    .disabled(past != nil || index >= session.cards.count - 1).accessibilityIdentifier("next-card")
                    .keyboardShortcut("]", modifiers: [.command, .shift])
            }
        }
    }
    private var index: Int { session.cards.firstIndex { $0.id == (selected ?? session.cards.first?.id) } ?? 0 }
    private func page(_ delta: Int) {
        let next = index + delta
        if session.cards.indices.contains(next) { selected = session.cards[next].id; past = nil }
    }
}

private struct PhoneCardChoiceStyle: ViewModifier {
    let primary: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if primary { content.buttonStyle(.borderedProminent).foregroundStyle(PhoneTheme.onAccent) }
        else { content.buttonStyle(.bordered) }
    }
}

private struct PhoneCardPane: View {
    let card: PhoneCard
    let session: ReadOnlySession
    @Binding var reply: String
    let onReading: (PhoneJSON) -> Void
    let onSeen: () -> Void
    let onHide: () -> Void
    let onPage: (Int) -> Void
    let onSent: () -> Void
    let showsNext: Bool
    /// The stage is on screen: a card drawn behind another tab is not yet read.
    let visible: Bool
    let replyLeaves: Bool
    @State private var surfaceHeight: CGFloat = 0
    @State private var host: CardWebHost
    @State private var problem: String?
    @State private var threadOpen = false
    @State private var retry = 0
    @Environment(\.scenePhase) private var phase
    @FocusState private var replyFocused: Bool

    init(card: PhoneCard, session: ReadOnlySession, fill: PhoneJSON, reply: Binding<String>,
         onReading: @escaping (PhoneJSON) -> Void, onSeen: @escaping () -> Void, onHide: @escaping () -> Void, onPage: @escaping (Int) -> Void, onSent: @escaping () -> Void, showsNext: Bool, visible: Bool, replyLeaves: Bool) {
        self.card = card; self.session = session; _reply = reply
        self.onReading = onReading; self.onSeen = onSeen; self.onHide = onHide; self.onPage = onPage; self.onSent = onSent
        self.showsNext = showsNext; self.visible = visible; self.replyLeaves = replyLeaves
        _host = State(initialValue: CardWebHost(card: card, session: session, fill: fill))
    }
    private var messages: [PhoneJSON] { card.isPast ? card.value["messages"].list : session.threads[card.id]?["messages"].list ?? [] }
    private var reachable: Bool { session.contact == "in-reach" }
    private var canSendReply: Bool { !host.changing && session.canChange && host.drawn && PhoneCard.canSendReply(reply) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: PhoneTheme.space2) { kind; attribution }
                            VStack(alignment: .leading, spacing: PhoneTheme.space2) { kind; attribution }
                        }
                        if card.reviewTaskId != nil {
                            Text("Review finding").font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                        }
                        Text(card.title).font(.custom("SpaceGrotesk-Light", size: 20, relativeTo: .title3).weight(.semibold))
                            .accessibilityIdentifier("card-title")
                    }
                    Spacer()
                    Button {
                        if card.isPast { onHide() } else { perform(closesCard: true) { _ = try await session.ask(.close, [.string(card.id), card.submission()]) } }
                    } label: {
                        Label(card.isPast ? "Hide" : "Close", systemImage: "xmark")
                            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                        .accessibilityIdentifier("close-card").disabled(host.changing || (!card.isPast && !session.canChange))
                }
                .contentShape(Rectangle())
                .simultaneousGesture(DragGesture(minimumDistance: 44).onEnded { value in
                    // Paging belongs to native chrome, never a body's slider, canvas or pinch gesture.
                    if !card.isPast && abs(value.translation.width) > abs(value.translation.height) * 1.5 {
                        onPage(value.translation.width < 0 ? 1 : -1)
                    }
                })
                if card.isPast {
                    Text(ending).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("past-ending")
                }
                if let failure = host.failure {
                    Text(failure).foregroundStyle(PhoneTheme.secondary)
                    if host.reading["of"].numeric != nil {
                        Text("Choices use the last saved answers. Retry to read the card again.").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    }
                    Button("Retry") {
                        let fill = host.reading["answers"]; host.close(); problem = nil
                        host = CardWebHost(card: card, session: session, fill: fill)
                        connectHost(); retry += 1
                    }.buttonStyle(.bordered).controlSize(.large).disabled(host.changing).accessibilityIdentifier("retry-card")
                } else {
                    CardWebView(host: host).frame(height: host.height).id(retry)
                }
                if let notice = host.notice { Text(notice).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-notice") }
                ForEach(Array(card.value["requiredActions"].list.enumerated()), id: \.offset) { _, action in
                    VStack(alignment: .leading) {
                        Text("After merging: \(action["title"].text ?? "") · \(action["target"].text ?? "")").font(PhoneFont.headline)
                        Text(action["consequence"].text ?? "").font(PhoneFont.callout)
                    }
                }
                if card.value["attachment"] != .null {
                    Button(card.value["attachment"]["label"].text ?? "Open browser") { host.notice = "Do this on \(session.mac.name)." }
                        .accessibilityIdentifier("card-browser")
                }
                if !card.actions.isEmpty {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        if !card.isPast, let count = host.reading["of"].numeric, count > 0 {
                            Text("\(Int(host.reading["answered"].numeric ?? 0)) of \(Int(count)) answered")
                                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                        }
                        ForEach(Array(card.actions.enumerated()), id: \.offset) { _, action in
                            Button {
                                if onMac(action) { host.notice = "Do this on \(session.mac.name)."; return }
                                perform(closesCard: true) {
                                    let snapshot = try await host.submissionReading()
                                    let reading = snapshot.value
                                    guard !action["default"].flag || reading["answered"] == reading["of"] else {
                                        throw PhoneRequestError("Answer each required question first.")
                                    }
                                    let result = try await session.ask(.act, [.string(card.id), action["id"], .string("chrome"),
                                        .object(["answers": reading["answers"]]), card.submission(reading: reading, fresh: snapshot.fresh)])
                                    if let refusal = result["refusal"].text { throw PhoneRequestError(refusal) }
                                    onSent()
                                }
                            } label: {
                                HStack { Text(action["label"].text ?? "Choose"); if card.isPast && card.value["ending"]["actionId"] == action["id"] { Image(systemName: "checkmark").accessibilityLabel("Chosen") } }
                                    .frame(maxWidth: .infinity).padding(.vertical, PhoneTheme.space2)
                            }
                            .modifier(PhoneCardChoiceStyle(primary: action["default"].flag))
                            .tint(action["danger"].flag ? PhoneTheme.danger : PhoneTheme.accent)
                            .disabled(card.isPast || host.changing || !session.canChange || !host.drawn)
                            .accessibilityIdentifier("card-action-\(action["id"].text ?? "")")
                        }
                    }
                }
                if let problem { Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-error") }
                if !messages.isEmpty {
                    DisclosureGroup("Thread", isExpanded: $threadOpen) {
                        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                            ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                                    Text(message["who"].text == "captain" ? "You" : message["who"].text == "host" ? "Infinitary" : "Your first mate").font(PhoneFont.caption)
                                    Text(message["text"].text ?? "").textSelection(.enabled)
                                    ForEach(Array(message["answers"].list.enumerated()), id: \.offset) { _, answer in
                                        Text("\(answer["name"].text ?? ""): \(answer["values"].list.compactMap(\.text).joined(separator: ", "))\(answer["written"].text.map { " — " + $0 } ?? "")").font(PhoneFont.caption)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.padding(.top, PhoneTheme.space3)
                    }.accessibilityIdentifier("card-thread")
                }
                if card.takesReplies && !card.isPast {
                    HStack(alignment: .bottom, spacing: 0) {
                        TextField("Reply to this card", text: $reply, axis: .vertical).lineLimit(1...5)
                            .padding(.leading, PhoneTheme.space4).padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                            .focused($replyFocused).accessibilityIdentifier("card-reply")
                        Button {
                            perform {
                                let text = reply
                                guard PhoneCard.canSendReply(text) else { return }
                                let snapshot = try await host.submissionReading()
                                let reading = snapshot.value
                                _ = try await session.ask(.reply, [.string(card.id), .object(["text": .string(text), "answers": reading["answers"]]),
                                    card.submission(reading: reading, fresh: snapshot.fresh), .bool(replyLeaves)])
                                if reply == text { reply = "" }
                                threadOpen = true; replyFocused = false; onSent()
                            }
                        } label: {
                            Label("Send reply", systemImage: "arrow.up.circle.fill").labelStyle(.iconOnly).imageScale(.large)
                                .foregroundStyle(canSendReply ? PhoneTheme.accent : PhoneTheme.muted)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }.accessibilityIdentifier("send-reply")
                            .disabled(!canSendReply)
                    }.phoneInput()
                        // INF-589 item 11: the line under the composer says why; the reply row only dims.
                        .opacity(session.canChange ? 1 : 0.5)
                    if reply.utf16.count > PhoneLimits.reply { Text("Keep your reply within \(PhoneLimits.reply.formatted()) characters.").foregroundStyle(PhoneTheme.warning) }
                }
            }
            .padding(PhoneTheme.space4).frame(maxWidth: .infinity, alignment: .leading)
            .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.cardRadius))
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { surfaceHeight = $0 }
            .padding(.bottom, PhoneTheme.space4)
        }
        .background(alignment: .topTrailing) {
            if showsNext {
                // The stack follows a short card, not the unused space in its scrolling viewport.
                // A taller card's peek still fits the viewport and never reaches the pager.
                RoundedRectangle(cornerRadius: PhoneTheme.cardRadius)
                    .fill(PhoneTheme.surface).overlay {
                        RoundedRectangle(cornerRadius: PhoneTheme.cardRadius).stroke(PhoneTheme.line)
                    }
                    .frame(width: PhoneTheme.space5)
                    .frame(maxHeight: max(0, surfaceHeight - 2 * PhoneTheme.space3))
                    .padding(.vertical, PhoneTheme.space3)
                    .offset(x: PhoneTheme.space2).accessibilityHidden(true).allowsHitTesting(false)
            }
        }
        .accessibilityIdentifier("card-scroll")
        .scrollDismissesKeyboard(.interactively)
        .onAppear { connectHost(); readThread() }
        .onChange(of: session.contact) { _, contact in if contact == "in-reach" { readThread(); markSeen() } }
        .onChange(of: phase) { _, phase in if phase == .active { markSeen() } }
        .onChange(of: visible) { _, visible in if visible { markSeen() } }
        .sheet(isPresented: Binding(get: { host.presentation != nil }, set: { if !$0 { host.presentation = nil } })) {
            if let presentation = host.presentation { CardMediaView(presentation: presentation, session: session) }
        }
    }
    private var kind: some View {
        Text(card.isPast ? "Past" : card.author == "host" ? "Attention" : card.actions.isEmpty ? "Note" : "Decision")
            .font(.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption2))
            .foregroundStyle(card.actions.isEmpty ? PhoneTheme.secondary : PhoneTheme.accent)
            .padding(.horizontal, PhoneTheme.space2).padding(.vertical, 4)
            .background(PhoneTheme.background, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
    }
    private var attribution: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(card.author == "firstmate" ? "Your first mate" : card.author == "host" ? "Infinitary" : card.meta ?? "Crewmate")
            if card.author == "firstmate", let meta = card.meta, meta != "firstmate" {
                Text(meta)
            }
        }.font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
    }
    private var ending: String {
        let end = card.endingForWords
        let words = PhonePastEnding.words(end)
        guard let at = end["at"].numeric else { return words }
        return "\(words) · \(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened))"
    }
    private func onMac(_ action: PhoneJSON) -> Bool {
        let effect = action["effect"]
        return (effect["kind"].text == "open" && !(effect["target"].text == "browser" && effect["savedSignIn"].flag))
            || (effect["kind"].text == "host" && effect["op"].text == "restore-account")
    }
    private func perform(closesCard: Bool = false, _ operation: @escaping @MainActor () async throws -> Void) {
        let activeHost = host
        guard activeHost.beginChange() else { return }
        problem = nil
        Task {
            defer { activeHost.busy = false }
            do { try await operation(); if closesCard { activeHost.chosen = true } }
            catch { problem = error.localizedDescription }
        }
    }
    private func connectHost() { host.onReading = onReading; host.onDrawn = markSeen }
    private func markSeen() {
        guard !card.isPast, host.drawn, reachable, visible, phase == .active else { return }
        onSeen()
        if let offer = card.offerID { Task { _ = try? await session.ask(.seen, [.string(card.id), .string(offer)]) } }
    }
    private func readThread() {
        guard !card.isPast, reachable else { return }
        Task { do { try await session.readThread(card.id) } catch { problem = error.localizedDescription } }
    }
}
