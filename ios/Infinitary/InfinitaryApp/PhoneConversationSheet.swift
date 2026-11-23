import InfinitaryKit
import SwiftUI

/// The Conversation's reading, kept while the sheet is away so a card opened from it returns to the same view and
/// place (INF-6337's plan; docs/ios.md, "Talk and tasks"). The rounds are the computer's pages, merged as read.
@MainActor @Observable final class PhoneConversationModel {
    enum Show: Hashable { case everything, cards }

    /// A card a tile opened on Home; the Conversation comes back once Home showed it and it left.
    struct Opened: Equatable { let id: String; var shown: Bool }

    /// The desktop's page: as many rounds as one read answers by default (`CONVERSATION_PAGE`).
    static let pageSize = 30

    var show: Show = .everything
    /// The round at the top of the reading when the sheet went away.
    var place: String?
    var opened: Opened?
    /// Newest first: every page read so far.
    private(set) var rounds: [PhoneConversationRound] = []
    private(set) var more = false
    /// The first page was read.
    private(set) var read = false
    /// The computer refused the read, as one from before the Conversation does: the last turn stands in, said so.
    private(set) var partial = false
    private(set) var readingEarlier = false

    /// What Everything draws, newest first: the pages read, with the last turn's live reply and a message it holds
    /// that no page has yet; the last turn alone until the first page arrives or when the computer cannot read it.
    func shown(_ turn: PhoneLastTurn?) -> [PhoneConversationRound] {
        PhoneConversation.strip(turn: turn, page: read && !partial ? rounds : nil, count: .max)
    }

    /// The newest page again; rounds read earlier stay, and how many remain keeps the deepest page's word.
    func readNewest(_ session: ReadOnlySession) async {
        do {
            let page = try await session.readConversation(limit: Self.pageSize)
            let deeper = read && !partial && rounds.count > page.rounds.count
            rounds = read && !partial ? PhoneConversation.merged(rounds, page.rounds) : page.rounds
            if !deeper { more = page.more }
            read = true; partial = false
        } catch PhoneError.refused, PhoneError.invalidReply {
            read = true; partial = true; rounds = []; more = false
        } catch {}
    }

    /// The page before the oldest round read.
    func readEarlier(_ session: ReadOnlySession) async {
        guard read, !partial, more, !readingEarlier, let oldest = rounds.last else { return }
        readingEarlier = true
        defer { readingEarlier = false }
        guard let page = try? await session.readConversation(before: oldest, limit: Self.pageSize) else { return }
        rounds = PhoneConversation.merged(rounds, page.rounds)
        more = page.more
    }

    /// Reads back until `id` is among the rounds, for a strip round older than the first page.
    func reach(_ id: String, _ session: ReadOnlySession) async {
        while read, !partial, more, !rounds.contains(where: { $0.id == id }) {
            let before = rounds.count
            await readEarlier(session)
            if rounds.count == before { return }
        }
    }
}

/// The phone's Conversation (INF-6337's plan, part 3): the strip's reply sheet become the whole conversation. Everything
/// draws each round oldest first, with day and time marks; Cards lists the cards waiting on the captain, then the ones
/// they answered. A card's tile opens it on Home, and the Conversation returns when the card leaves.
struct PhoneConversationSheet: View {
    let session: ReadOnlySession
    @Bindable var model: PhoneConversationModel
    /// The strip round pressed to open it, brought into view once read.
    let landing: String?
    let openCard: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var position: String?
    @State private var pending: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker(PhoneMessages.shellConversationShow(), selection: $model.show) {
                    Text(PhoneMessages.shellConversationEverything()).tag(PhoneConversationModel.Show.everything)
                    Text(PhoneMessages.shellConversationCards()).tag(PhoneConversationModel.Show.cards)
                }.pickerStyle(.segmented).labelsHidden()
                    .padding(.horizontal, PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
                    .accessibilityIdentifier("conversation-show")
                switch model.show {
                case .everything: everything
                case .cards: cards
                }
            }
            .phoneTitle(PhoneMessages.shellConversationHeading())
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-conversation")
            } }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        // On an iPad, about the page width the desktop gives the Conversation; on an iPhone, the whole width.
        .presentationSizing(.page)
        .phoneSheetSurface()
        .onAppear {
            pending = landing
            position = landing ?? model.place ?? model.shown(session.lastTurn).first?.id
        }
        .onDisappear { model.place = position }
        // Read on opening, and again whenever the newest rounds changed.
        .task(id: session.conversationRevision) {
            await model.readNewest(session)
            if let pending { await model.reach(pending, session) }
        }
    }

    private var everything: some View {
        let rounds = model.shown(session.lastTurn)
        let newestMessage = rounds.first(where: \.sentAsMessage)?.id
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: PhoneTheme.space4) {
                if model.partial {
                    Text(PhoneMessages.shellConversationPartial()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center).accessibilityIdentifier("conversation-partial")
                }
                if model.more {
                    Text(PhoneMessages.shellConversationReadingEarlier()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                        .frame(maxWidth: .infinity)
                        .onAppear { Task { await model.readEarlier(session) } }
                }
                if rounds.isEmpty && (model.read || session.lastTurn == nil) {
                    Text(PhoneMessages.shellConversationEmpty()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.muted)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(.top, PhoneTheme.space5)
                        .accessibilityIdentifier("conversation-empty")
                }
                // Oldest at the top: the newest round sits at the foot, nearest the message box.
                let oldestFirst = Array(rounds.reversed())
                ForEach(Array(oldestFirst.enumerated()), id: \.element.id) { index, round in
                    let before = index > 0 ? oldestFirst[index - 1] : nil
                    PhoneConversationRoundView(round: round, before: before,
                                               working: session.firstmateBusy && round.id == newestMessage,
                                               openCard: openCard)
                        .id(round.id)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, PhoneTheme.space5).padding(.vertical, PhoneTheme.space4)
        }
        .defaultScrollAnchor(.bottom)
        .scrollPosition(id: $position, anchor: .center)
        .onChange(of: rounds.map(\.id)) { _, ids in
            guard let pending, ids.contains(pending) else { return }
            position = pending; self.pending = nil
        }
        .accessibilityIdentifier("conversation-scroll")
    }

    private var cards: some View {
        let waiting = PhoneConversation.waiting(session.cards)
        let answered = PhoneConversation.answered(model.shown(session.lastTurn), waiting: Set(waiting.map(\.id)))
        return ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space5) {
                if waiting.isEmpty && answered.isEmpty {
                    Text(PhoneMessages.shellConversationNoCards()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.muted)
                        .frame(maxWidth: .infinity).padding(.top, PhoneTheme.space5).accessibilityIdentifier("conversation-no-cards")
                }
                if !waiting.isEmpty {
                    section(PhoneMessages.shellConversationWaitingOnYou(), id: "waiting") {
                        ForEach(waiting) { card in
                            PhoneConversationTile(id: card.id, title: card.title,
                                                  presentation: PhoneConversation.presentation(card), taskKey: nil, open: openCard)
                            Text(PhoneConversationTime.when(card.value["createdAt"].numeric ?? 0))
                                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                        }
                    }
                }
                if !answered.isEmpty {
                    section(PhoneMessages.shellConversationAnswered(), id: "answered") {
                        ForEach(answered, id: \.card.id) { answered in
                            PhoneConversationTile(id: answered.card.id, title: answered.card.title,
                                                  presentation: answered.card.presentation, taskKey: answered.card.taskKey, open: openCard)
                            Text("\(answered.round.kind == .choice ? PhoneMessages.shellConversationYouChose(label: answered.round.you) : PhoneMessages.shellConversationYouReplied(words: answered.round.you)) · \(PhoneConversationTime.when(answered.at))")
                                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2)
                        }
                    }
                }
            }.padding(.horizontal, PhoneTheme.space5).padding(.vertical, PhoneTheme.space4)
        }
        .accessibilityIdentifier("conversation-cards")
    }

    private func section<Rows: View>(_ title: String, id: String, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(title.uppercased()).font(PhoneFont.label).tracking(PhoneFont.labelTracking).foregroundStyle(PhoneTheme.muted)
                .accessibilityAddTraits(.isHeader)
            rows()
        }.accessibilityIdentifier("conversation-section-\(id)")
    }
}

/// Day and time words for the Conversation, in the phone's own formats.
enum PhoneConversationTime {
    static func day(_ at: Double) -> String {
        let date = Date(timeIntervalSince1970: at / 1000)
        if Calendar.current.isDateInToday(date) { return PhoneMessages.shellConversationToday() }
        if Calendar.current.isDateInYesterday(date) { return PhoneMessages.shellConversationYesterday() }
        return date.formatted(.dateTime.weekday(.wide).month(.wide).day().locale(PhoneFormats.locale))
    }

    static func time(_ at: Double) -> String { PhoneFormats.time(Date(timeIntervalSince1970: at / 1000)) }

    static func sameDay(_ a: Double, _ b: Double) -> Bool {
        Calendar.current.isDate(Date(timeIntervalSince1970: a / 1000), inSameDayAs: Date(timeIntervalSince1970: b / 1000))
    }

    /// The time alone today; the day and the time before.
    static func when(_ at: Double) -> String {
        Calendar.current.isDateInToday(Date(timeIntervalSince1970: at / 1000)) ? time(at) : "\(day(at)) \(time(at))"
    }
}

/// One round in Everything, as the desktop draws it: a day mark where the day changes, the time where the minute
/// changes, a card's tile before an act on it, the captain's words in the bubble and what came back under them.
private struct PhoneConversationRoundView: View {
    let round: PhoneConversationRound
    let before: PhoneConversationRound?
    let working: Bool
    let openCard: (String) -> Void

    var body: some View {
        let newDay = round.at > 0 && (before.map { !PhoneConversationTime.sameDay($0.at, round.at) } ?? true)
        let newTime = round.at > 0 && (newDay || PhoneConversationTime.time(before?.at ?? 0) != PhoneConversationTime.time(round.at))
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if newDay {
                HStack(spacing: PhoneTheme.space3) {
                    Rectangle().fill(PhoneTheme.line).frame(height: 1)
                    Text(PhoneConversationTime.day(round.at)).font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted).fixedSize()
                    Rectangle().fill(PhoneTheme.line).frame(height: 1)
                }.padding(.vertical, PhoneTheme.space2).accessibilityAddTraits(.isHeader)
            }
            if newTime {
                Text(PhoneConversationTime.time(round.at)).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                    .frame(maxWidth: .infinity)
            }
            if let card = round.card {
                PhoneConversationTile(id: card.id, title: card.title, presentation: card.presentation, taskKey: card.taskKey, open: openCard)
            }
            you
            if let answer = round.answer {
                mate(answer.text, problem: false, crewmate: answer.who == "crewmate")
            } else if let reply = round.reply {
                mate(reply.words ?? reply.text, problem: reply.problem == true, crewmate: false)
            } else if working {
                mate(nil, problem: false, crewmate: false)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-round-\(round.id)")
    }

    private var you: some View {
        let words = round.kind == .choice ? PhoneMessages.shellConversationChose(label: round.you)
            : round.you.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? PhoneMessages.phoneComposerPictureOnly() : round.you
        return BubbleColumn {
            VStack(alignment: .trailing, spacing: 4) {
                if round.through {
                    Text(PhoneMessages.shellLastTurnFromCommand(command: "infinitary-axi")).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted) // i18n-exempt: the command's own name
                }
                Text(words).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text).textSelection(.enabled)
                    .padding(.vertical, 6).padding(.horizontal, 12)
                    .background(PhoneTheme.text.opacity(0.1), in: PhoneConversationBubble())
                    .accessibilityIdentifier("conversation-you")
            }
        }
    }

    private func mate(_ words: String?, problem: Bool, crewmate: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
            if crewmate {
                Text(PhoneMessages.shellConversationCrewmate()).font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted)
            } else {
                MateMark(working: working, still: false).frame(width: 16, height: 16).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            }
            Text(words ?? PhoneMessages.phoneComposerWorking()).font(PhoneFont.callout)
                .foregroundStyle(words == nil ? PhoneTheme.muted : problem ? PhoneTheme.danger : PhoneTheme.text)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("conversation-words")
        }
    }
}

/// The captain's bubble, its corner nearest the box tucked in, as on the strip.
struct PhoneConversationBubble: Shape {
    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 5, topTrailingRadius: 14).path(in: rect)
    }
}

/// A card the captain acted on, drawn small: its kind's chip, its title and its task's key; the tap opens it on Home.
struct PhoneConversationTile: View {
    let id: String
    let title: String
    let presentation: String
    let taskKey: String?
    let open: (String) -> Void

    var body: some View {
        Button { open(id) } label: {
            HStack(spacing: PhoneTheme.space2) {
                chip
                Text(title).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let taskKey { Text(taskKey).font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted) }
            }
            .padding(.horizontal, PhoneTheme.space3).padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
            .overlay { RoundedRectangle(cornerRadius: PhoneTheme.controlRadius, style: .continuous).strokeBorder(PhoneTheme.line) }
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("conversation-tile-\(id)")
    }

    private var chip: some View {
        let tone = presentation == "decision" ? PhoneTheme.accent : presentation == "attention" ? PhoneTheme.danger : PhoneTheme.muted
        let words = presentation == "decision" ? PhoneMessages.uiCardKindDecision()
            : presentation == "attention" ? PhoneMessages.uiCardKindAttention() : PhoneMessages.uiCardKindNote()
        return HStack(spacing: 4) {
            Circle().fill(tone).frame(width: 6, height: 6)
            Text(words).font(PhoneFont.micro).foregroundStyle(tone)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .overlay { Capsule().strokeBorder(tone.opacity(0.4)) }
        .fixedSize()
    }
}
