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
    /// A minimized card asked back from the Mac, shown once its return reaches the stack.
    @State private var restoring: String?
    @State private var restoreProblem: String?
    private var card: PhoneCard? { past ?? session.stack.first(where: { $0.id == selected }) ?? session.stack.first }

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
                    showsNext: past == nil && index < session.stack.count - 1, visible: messageContext.cardsVisible,
                    replyLeaves: !card.value["holdsPlace"].flag && session.stack.count > 1)
                    .id("\(card.id):\(card.offerID ?? card.body):\(card.isPast)")
            } else {
                // INF-1060 keeps the empty stage free of placeholder words; INF-1066 adds its native crew.
                PhoneCrewScene(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).padding(.vertical, PhoneTheme.space5)
            }
            // INF-589 item 11: with no card to page, the pager hides; Minimized stays reachable while there are any.
            if let restoreProblem { Text(restoreProblem).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("restore-error") }
            if !session.stack.isEmpty || !session.minimizedCards.isEmpty { pager }
        }
        .padding(.horizontal, PhoneTheme.space4).frame(maxWidth: card == nil ? .infinity : PhoneColumn.width).frame(maxWidth: .infinity)
        .background(PhoneTheme.background)
        // INF-589 item 12: a soft tap once the computer accepts an answer or a reply; never on a page turn.
        .sensoryFeedback(.phone, trigger: sent)
        .onChange(of: card.map { $0.isPast ? PhoneMessageContext.Card.past($0.id) : .current($0.id) }, initial: true) { _, shown in
            messageContext.card = shown
        }
        .onChange(of: session.stack.map(\.id), initial: true) { _, ids in
            if let marked = session.stack.first(where: { !previousIDs.contains($0.id) && $0.value["holdsPlace"].flag }) {
                selected = marked.id; past = nil
            } else if selected == nil || !ids.contains(selected!) {
                selected = session.stack.first(where: { !session.seenCards.contains($0.offerID ?? $0.id) })?.id ?? ids.first
            }
            if let restoring, ids.contains(restoring) { selected = restoring; past = nil; self.restoring = nil }
            previousIDs = ids
            if let past, ids.contains(past.id) { self.past = nil }
        }
        .onChange(of: session.showCardID, initial: true) { _, id in
            guard let id else { return }
            if session.stack.contains(where: { $0.id == id }) { selected = id; past = nil }
            else { past = session.pastCards.first { $0.id == id } }
            session.showCardID = nil
        }
    }
    private var pager: some View {
        HStack(spacing: PhoneTheme.space2) {
            if !session.stack.isEmpty {
                Button { page(-1) } label: { Label("Previous card", systemImage: "chevron.left").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44) }
                    .disabled(past != nil || index <= 0).accessibilityIdentifier("previous-card")
                    .keyboardShortcut("[", modifiers: [.command, .shift])
            }
            Menu {
                ForEach(session.stack) { item in
                    Button(item.title) { selected = item.id; past = nil }
                }
                // INF-944 item 3: cards minimized on the Mac wait here; opening one brings it back on the Mac too.
                if !session.minimizedCards.isEmpty {
                    Section("Minimized") {
                        ForEach(session.minimizedCards) { item in
                            Button(item.title) { restore(item) }.disabled(!session.canChange).accessibilityIdentifier("minimized-card")
                        }
                    }
                }
            } label: {
                Text(past != nil ? "Past card" : session.stack.isEmpty ? "Minimized" : "\(index + 1) of \(session.stack.count)")
                    .font(.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption))
                    .frame(minWidth: 44, minHeight: 44)
            }.accessibilityIdentifier("card-pager")
            if !session.stack.isEmpty {
                Button { page(1) } label: {
                    Label("Next card", systemImage: "chevron.right").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                        .overlay(alignment: .topTrailing) {
                            if session.stack.dropFirst(index + 1).contains(where: { !session.seenCards.contains($0.offerID ?? $0.id) }) {
                                Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6).accessibilityHidden(true)
                            }
                        }
                }
                    .disabled(past != nil || index >= session.stack.count - 1).accessibilityIdentifier("next-card")
                    .keyboardShortcut("]", modifiers: [.command, .shift])
            }
        }
    }
    private var index: Int { session.stack.firstIndex { $0.id == (selected ?? session.stack.first?.id) } ?? 0 }
    private func restore(_ item: PhoneCard) {
        restoreProblem = nil; restoring = item.id
        Task {
            do { _ = try await session.ask(.minimize, [.string(item.id), .bool(false)]) }
            catch { restoring = nil; restoreProblem = error.localizedDescription; return }
            // The Mac's card push may already have arrived with the card back on its stack.
            if session.stack.contains(where: { $0.id == item.id }) { selected = item.id; past = nil; restoring = nil }
        }
    }
    private func page(_ delta: Int) {
        let next = index + delta
        if session.stack.indices.contains(next) { selected = session.stack[next].id; past = nil }
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
    @State private var contentHeight: CGFloat = 0
    /// The body runs on below the choices, so a hairline separates them, as on the Mac.
    @State private var runsOn = false
    /// The height the stage offers the card, and its head's and choices' own heights.
    @State private var paneHeight: CGFloat = 0
    @State private var headHeight: CGFloat = 0
    @State private var footHeight: CGFloat = 0
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

    private var hasFoot: Bool { !card.actions.isEmpty || problem != nil }
    /// A short stage, such as an iPhone on its side with a long draft, would leave the body a sliver between its pinned
    /// head and choices; unless the body keeps at least the room they take, the whole card scrolls as it did before.
    @State private var pinsFrame = true
    /// The stage height at which the frame last changed its shape.
    @State private var shapedAt: CGFloat?

    /// Moving the head and choices changes what they measure, and while a rotation animates both places are drawn at once,
    /// so the frame changes its shape at most once for each stage height and never animates the move; otherwise the two
    /// could trade places on every frame and the app would never come to rest.
    private func shapeFrame() {
        guard paneHeight > 0 else { return }
        let pins = paneHeight - headHeight - footHeight >= headHeight + footHeight
        guard pins != pinsFrame, shapedAt != paneHeight else { return }
        shapedAt = paneHeight
        var moved = Transaction()
        moved.disablesAnimations = true
        withTransaction(moved) { pinsFrame = pins }
    }

    private var measuredHead: some View {
        head.padding([.horizontal, .top], PhoneTheme.space4).padding(.bottom, PhoneTheme.space3)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headHeight = $0 }
    }

    private var measuredFoot: some View {
        foot.fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footHeight = $0 }
    }

    var body: some View {
        // INF-944 items 1 and 2, the Mac's shape: the head and the choices stay in the frame, and the body and
        // thread scroll between them in this one native scroller. The body's web view never scrolls on its own.
        VStack(alignment: .leading, spacing: 0) {
            if pinsFrame { measuredHead }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !pinsFrame { measuredHead }
                    content.padding([.horizontal], PhoneTheme.space4).padding(.bottom, PhoneTheme.space4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if hasFoot && !pinsFrame { measuredFoot }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
            .scrollBounceBehavior(.basedOnSize)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height < geometry.contentSize.height - 1
            } action: { _, below in runsOn = below }
            .accessibilityIdentifier("card-scroll")
            .scrollDismissesKeyboard(.interactively)
            if hasFoot && pinsFrame { measuredFoot }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous))
        // A frame holding only its scroller is that scroller to accessibility, which then keeps the scroller's name.
        .accessibilityElement(children: .contain).accessibilityIdentifier(pinsFrame ? "card-frame" : "card-scroll")
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { surfaceHeight = $0 }
        .frame(maxHeight: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { paneHeight = $0 }
        .onChange(of: [paneHeight, headHeight, footHeight]) { shapeFrame() }
        .background(alignment: .topTrailing) {
            if showsNext {
                // The stack follows the card's frame, which never reaches the pager.
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
        .onAppear { connectHost(); readThread() }
        .onChange(of: session.contact) { _, contact in if contact == "in-reach" { readThread(); markSeen() } }
        .onChange(of: phase) { _, phase in if phase == .active { markSeen() } }
        .onChange(of: visible) { _, visible in if visible { markSeen() } }
        .sheet(isPresented: Binding(get: { host.presentation != nil }, set: { if !$0 { host.presentation = nil } })) {
            if let presentation = host.presentation { CardMediaView(presentation: presentation, session: session) }
        }
    }

    private var head: some View {
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
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
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
                }.buttonStyle(PhoneChoiceStyle(.secondary)).disabled(host.changing).accessibilityIdentifier("retry-card")
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
    }

    /// INF-944 item 5 with the captain's INF-945 pick: the Mac's row, pinned under a hairline while the body runs on beneath.
    /// The Mac's footer order (footerGroups.ts): the default is drawn last, at the trailing edge.
    private var footerOrder: [PhoneJSON] {
        card.actions.filter { !$0["default"].flag } + card.actions.filter { $0["default"].flag }
    }

    /// The Mac's footerVariant: the action's own variant, else primary for the default.
    private func footerKind(_ action: PhoneJSON) -> PhoneChoiceStyle.Kind {
        switch action["variant"].text {
        case "primary": .primary
        case "danger": .danger
        case "secondary", "ghost": action["danger"].flag ? .danger : .secondary
        default: action["danger"].flag ? .danger : action["default"].flag ? .primary : .secondary
        }
    }

    private var foot: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if let problem { Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-error") }
            if !card.actions.isEmpty {
                PhoneChoiceRow {
                    if !card.isPast, let count = host.reading["of"].numeric, count > 0 {
                        Text("\(Int(host.reading["answered"].numeric ?? 0)) of \(Int(count)) answered")
                            .font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                            .layoutValue(key: PhoneChoiceRow.Leading.self, value: true)
                    }
                    ForEach(Array(footerOrder.enumerated()), id: \.offset) { _, action in
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
                            HStack(spacing: 6) {
                                Text(action["label"].text ?? "Choose")
                                if card.isPast && card.value["ending"]["actionId"] == action["id"] { Image(systemName: "checkmark").accessibilityLabel("Chosen") }
                            }
                        }
                        .buttonStyle(PhoneChoiceStyle(footerKind(action)))
                        .disabled(card.isPast || host.changing || !session.canChange || !host.drawn)
                        .accessibilityIdentifier("card-action-\(action["id"].text ?? "")")
                    }
                }
            }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space2).padding(.bottom, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if runsOn && pinsFrame { Rectangle().fill(PhoneTheme.line).frame(height: 1) } }
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
