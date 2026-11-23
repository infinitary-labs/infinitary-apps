import Foundation

/// The conversation (INF-6337's plan, INF-6366 on the phone; docs/ios.md, "Talk and tasks"): everything the captain did
/// directly and what came back, as the computer reads it a page at a time (`inf:conversation:thread`,
/// `src/shared/conversation.ts`). A round is one act of the captain's - a message to the first mate, a press of a
/// card's own button, or a line typed under a card - with what answered it.
public struct PhoneConversationRound: Decodable, Identifiable, Sendable, Equatable {
    public enum Kind: String, Decodable, Sendable { case message, choice, reply }

    /// The card a round acted on, as it stands now.
    public struct Card: Decodable, Sendable, Equatable {
        public let id: String
        public let title: String
        /// `cardPresentation`'s kind: note, decision or attention.
        public let presentation: String
        public let taskKey: String?
    }

    /// The card author's first line after the captain's, in the card's thread.
    public struct Answer: Decodable, Sendable, Equatable {
        public let who: String
        public let text: String
        public let at: Double
    }

    public struct Reply: Decodable, Sendable, Equatable {
        public let text: String
        public let problem: Bool?
        public let eligibility: String?
        public let words: String?
        public init(_ reply: PhoneLastTurn.Reply) {
            text = reply.text; problem = reply.problem; eligibility = reply.eligibility; words = reply.words
        }
    }

    /// Unique and ordered with `at`; the page cursor names it.
    public let id: String
    /// Milliseconds; 0 for a round the phone holds before the computer read it.
    public let at: Double
    public let kind: Kind
    /// The captain's words, or for a choice the button's words.
    public let you: String
    public let card: Card?
    /// The first mate's reply line: a message's, or a line typed under its own card's.
    public internal(set) var reply: Reply?
    public let answer: Answer?
    /// The message came from the captain's own command, not a window.
    public let through: Bool
    /// A line typed under the first mate's own card, which is also a message.
    public let typedAsMessage: Bool

    private enum Keys: String, CodingKey { case id, at, kind, you, label, card, reply, answer, through }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        id = try keys.decode(String.self, forKey: .id)
        at = try keys.decode(Double.self, forKey: .at)
        kind = try keys.decode(Kind.self, forKey: .kind)
        you = kind == .choice ? try keys.decode(String.self, forKey: .label) : try keys.decode(String.self, forKey: .you)
        card = kind == .message ? nil : try keys.decode(Card.self, forKey: .card)
        reply = try keys.decodeIfPresent(Reply.self, forKey: .reply)
        answer = try keys.decodeIfPresent(Answer.self, forKey: .answer)
        through = keys.contains(.through)
        // A reply round names its first mate's reply line, null while none was given, only when it was also a message.
        typedAsMessage = kind == .reply && keys.contains(.reply)
    }

    /// A message the phone holds before the computer read it: the last turn's.
    init(held you: String, reply: PhoneLastTurn.Reply?, id: String) {
        self.id = id; at = 0; kind = .message; self.you = you; card = nil
        self.reply = reply.map(Reply.init); answer = nil; through = false; typedAsMessage = false
    }

    /// The same round with the reply line the last turn holds, which a live reply reaches first.
    func replying(_ line: PhoneLastTurn.Reply?) -> PhoneConversationRound {
        var round = self
        round.reply = line.map(Reply.init)
        return round
    }

    /// Sent as a message, as the strip's rounds are: one typed under the first mate's card included (`sentAsMessage`).
    public var sentAsMessage: Bool { kind == .message || typedAsMessage }
}

public struct PhoneConversationPage: Decodable, Sendable, Equatable {
    /// Newest first.
    public let rounds: [PhoneConversationRound]
    /// Older rounds remain past the last one.
    public let more: Bool
    public init(rounds: [PhoneConversationRound], more: Bool) { self.rounds = rounds; self.more = more }
}

/// The phone's reading of the conversation: the pages read so far, merged; and the strip's rounds.
public enum PhoneConversation {
    /// The plan's rounds at rest: the strip shows the last two.
    public static let roundsAtRest = 2

    /// Newest first: a later time, then the greater id (`newerRound`).
    public static func newer(_ a: PhoneConversationRound, _ b: PhoneConversationRound) -> Bool {
        a.at != b.at ? a.at > b.at : a.id > b.id
    }

    /// Rounds from `page` replace the same ids; rounds read earlier stay.
    public static func merged(_ kept: [PhoneConversationRound], _ page: [PhoneConversationRound]) -> [PhoneConversationRound] {
        var byID = Dictionary(kept.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for round in page { byID[round.id] = round }
        return byID.values.sorted(by: newer)
    }

    /// The two rounds the last turn holds, for a computer that cannot answer the read.
    public static func fallback(_ turn: PhoneLastTurn?) -> [PhoneConversationRound] {
        guard let turn else { return [] }
        var rounds = [PhoneConversationRound(held: turn.you, reply: turn.reply, id: "last:1")]
        if let older = turn.previous { rounds.append(PhoneConversationRound(held: older.you, reply: older.reply, id: "last:0")) }
        return rounds
    }

    /// The strip's rounds, newest first (INF-6337's plan, as INF-6365 draws them on the Mac): the newest page's order,
    /// times and card rounds, with each message's reply taken from the last turn, which a live reply and a message sent
    /// from this phone reach first. A message the last turn holds that the page has not read yet comes first. With no
    /// page - an older computer, or before the first read - the last turn's two messages, as before.
    public static func strip(turn: PhoneLastTurn?, page: [PhoneConversationRound]?, cardRounds: Bool = true,
                             count: Int = roundsAtRest) -> [PhoneConversationRound] {
        guard let page else { return Array(fallback(turn).prefix(count)) }
        let held: [(you: String, reply: PhoneLastTurn.Reply?)] = turn.map { turn in
            [(turn.you, turn.reply)] + (turn.previous.map { [($0.you, $0.reply)] } ?? [])
        } ?? []
        var rounds = page.filter { cardRounds || $0.sentAsMessage }
        let messages = rounds.indices.filter { rounds[$0].sentAsMessage }
        if let newest = held.first, !messages.contains(where: { rounds[$0].you == newest.you }) {
            rounds.insert(PhoneConversationRound(held: newest.you, reply: newest.reply, id: "held:\(newest.you)"), at: 0)
        } else {
            for (place, index) in messages.prefix(held.count).enumerated() where rounds[index].you == held[place].you {
                rounds[index] = rounds[index].replying(held[place].reply)
            }
        }
        return Array(rounds.prefix(count))
    }

    /// What the reading clock waits on before the older round may dissolve, or nil while it must stay: a message's
    /// completed reply line, or a card round, which is complete as it is drawn.
    public static func fadeKey(_ round: PhoneConversationRound) -> String? {
        if round.sentAsMessage {
            guard let reply = round.reply, reply.problem != true, reply.eligibility == "completed" else { return nil }
            return "\(round.you)\u{0}\(reply.text)"
        }
        return round.id
    }

    /// A card the captain answered, once with their newest act on it.
    public struct Answered: Sendable, Equatable {
        public let card: PhoneConversationRound.Card
        public let at: Double
        public let round: PhoneConversationRound
    }

    /// The cards the captain answered, newest first, each once, leaving out the ones still waiting on them.
    public static func answered(_ rounds: [PhoneConversationRound], waiting: Set<String>) -> [Answered] {
        var seen = Set<String>()
        return rounds.compactMap { round in
            guard let card = round.card, !waiting.contains(card.id), seen.insert(card.id).inserted else { return nil }
            return Answered(card: card, at: round.at, round: round)
        }
    }

    /// A card's kind as a round names it (`cardPresentation`): a note has no buttons, a host's card asks for attention.
    public static func presentation(_ card: PhoneCard) -> String {
        card.actions.isEmpty ? "note" : card.author == "host" ? "attention" : "decision"
    }

    /// Cards waiting on the captain, newest first: every live card the computer shows, those put aside included; a card
    /// its author ended, or one still waiting on its author's first close-out, waits on nothing of theirs (`onStage`).
    public static func waiting(_ cards: [PhoneCard]) -> [PhoneCard] {
        cards.filter { ($0.awaiting == nil || $0.sentBackAt != nil) && $0.value["ended"] == .null }
            .sorted { ($0.value["createdAt"].numeric ?? 0) > ($1.value["createdAt"].numeric ?? 0) }
    }
}
