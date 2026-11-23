import Foundation
import Testing
@testable import InfinitaryKit

/// INF-6337's plan, on the phone (INF-6366): the conversation holds everything the captain did directly - messages,
/// presses of a card's own buttons, lines typed under cards - with what came back; the strip shows the last couple of
/// rounds, and the Conversation is the place to find recent cards. Each test replays the core's own readings
/// (`scripts/generate-phone-conversation.ts`).
struct PhoneConversationTests {
    private struct Reading: Decodable {
        let lastTurn: PhoneLastTurn
        let whole: PhoneConversationPage
        let pages: [PhoneConversationPage]
        let strip: PhoneConversationPage
        let cards: [PhoneCard]
    }

    private static let reading: Reading = {
        let url = Bundle.module.url(forResource: "PhoneConversation.generated", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONDecoder().decode(Reading.self, from: Data(contentsOf: url))
    }()

    private var reading: Reading { Self.reading }

    @Test func eachActReadsAsItsRound() {
        let rounds = reading.whole.rounds
        #expect(rounds.map(\.kind) == [.message, .choice, .reply, .reply, .choice, .message])
        #expect(rounds.map(\.you) == [
            "also remind me to check usage on friday", "Got it", "move it to Monday", "use bars, not lines",
            "Approve and build", "can a panel track my backlog?",
        ])
        #expect(rounds.map(\.card?.title) == [nil, "Usage this week", "Your reminders", "Which chart reads best?",
                                                "A panel that charts your backlog", nil])
        // A line typed under the first mate's own card was also a message; one under a crewmate's card was not.
        #expect(rounds.map(\.sentAsMessage) == [true, false, true, false, false, true])
        #expect(rounds[2].reply?.text == "Moved to Monday.")
        #expect(rounds[2].answer?.text == "Moved to Monday at 9:00 AM.")
        #expect(rounds[3].answer?.text == "Bars it is.")
        #expect(rounds[3].reply == nil)
    }

    @Test func pagesReadBackwardsMeetTheWholeConversationOnce() {
        var kept: [PhoneConversationRound] = []
        for page in reading.pages { kept = PhoneConversation.merged(kept, page.rounds) }
        #expect(kept.map(\.id) == reading.whole.rounds.map(\.id))
        #expect(reading.pages.map(\.more) == [true, false])
        // The newest page read again after older pages keeps every round, still once each.
        #expect(PhoneConversation.merged(kept, reading.pages[0].rounds).map(\.id) == kept.map(\.id))
    }

    @Test func theStripShowsTheLastTwoRoundsWithTheLastTurnsReply() {
        let strip = PhoneConversation.strip(turn: reading.lastTurn, page: reading.strip.rounds)
        #expect(strip.map(\.id) == reading.strip.rounds.map(\.id))
        #expect(strip.map(\.kind) == [.message, .choice])
        #expect(strip[0].reply?.words == "All set.\nI'll remind you Friday at 9:00 AM.")
        #expect(strip[1].card?.title == "Usage this week")
    }

    @Test func aLiveReplyReachesTheStripBeforeThePageReadsAgain() {
        let turn = PhoneLastTurn(you: "also remind me to check usage on friday",
                                 reply: .init(text: "Setting it up", problem: nil, eligibility: "pending", words: nil),
                                 previous: reading.lastTurn.previous)
        let strip = PhoneConversation.strip(turn: turn, page: reading.strip.rounds)
        #expect(strip[0].reply?.text == "Setting it up")
        #expect(PhoneConversation.fadeKey(strip[0]) == nil)
    }

    @Test func aMessageThePageHasNotReadComesFirst() {
        let turn = PhoneLastTurn(you: "and the weekly report", reply: nil,
                                 previous: PhoneLastRound(you: reading.lastTurn.you, reply: reading.lastTurn.reply))
        let strip = PhoneConversation.strip(turn: turn, page: reading.strip.rounds)
        #expect(strip.map(\.you) == ["and the weekly report", "also remind me to check usage on friday"])
        #expect(strip[0].reply == nil)
    }

    @Test func withoutCardRoundsTheStripShowsMessagesAlone() {
        let strip = PhoneConversation.strip(turn: reading.lastTurn, page: reading.whole.rounds, cardRounds: false)
        #expect(strip.map(\.you) == ["also remind me to check usage on friday", "move it to Monday"])
    }

    @Test func aComputerThatCannotReadItShowsTheLastTurnAsBefore() {
        let strip = PhoneConversation.strip(turn: reading.lastTurn, page: nil)
        #expect(strip.map(\.you) == ["also remind me to check usage on friday", "move it to Monday"])
        #expect(strip.map(\.kind) == [.message, .message])
        #expect(strip[1].reply?.text == "Moved to Monday.")
        #expect(PhoneConversation.strip(turn: nil, page: nil).isEmpty)
    }

    @Test func aRoundMayDissolveOnceItIsComplete() {
        let rounds = reading.whole.rounds
        #expect(PhoneConversation.fadeKey(rounds[0]) != nil)
        #expect(PhoneConversation.fadeKey(rounds[1]) == rounds[1].id)
        #expect(PhoneConversation.fadeKey(rounds[0]) != PhoneConversation.fadeKey(rounds[5]))
    }

    @Test func cardsListWaitingThenAnsweredEachOnce() {
        let waiting = PhoneConversation.waiting(reading.cards)
        #expect(waiting.map(\.title) == ["Which project goes first?", "Your reminders", "Which chart reads best?"])
        let answered = PhoneConversation.answered(reading.whole.rounds, waiting: Set(waiting.map(\.id)))
        #expect(answered.map(\.card.title) == ["Usage this week", "A panel that charts your backlog"])
        #expect(answered.map(\.round.you) == ["Got it", "Approve and build"])
    }
}
