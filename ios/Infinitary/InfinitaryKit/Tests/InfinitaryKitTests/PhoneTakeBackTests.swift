import Foundation
import Testing
@testable import InfinitaryKit

/// INF-6763's plan, part 3: the phone takes back the captain's newest message within its minute, as the Mac does
/// (docs/composer.md, "Taking back"; docs/ios.md, "Talk and tasks"). Each test replays the core's own readings
/// (`scripts/generate-phone-conversation.ts`): a conversation at rest, and one where a message was replaced before any
/// turn read it and the replacement was then taken back.
struct PhoneTakeBackTests {
    private struct Reading: Decodable {
        let lastTurn: PhoneLastTurn
        let strip: PhoneConversationPage
        let takeBack: Conversation
        struct Conversation: Decodable {
            let lastTurn: PhoneLastTurn
            let strip: PhoneConversationPage
        }
    }

    private static let reading: Reading = {
        let url = Bundle.module.url(forResource: "PhoneConversation.generated", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONDecoder().decode(Reading.self, from: Data(contentsOf: url))
    }()

    private var reading: Reading { Self.reading }

    private func strip(_ turn: PhoneLastTurn, _ page: PhoneConversationPage) -> [PhoneConversationRound] {
        PhoneConversation.strip(turn: turn, page: page.rounds, readAt: turn)
    }

    /// The window is `TAKE_BACK_WINDOW_MS` from when the computer accepted the message, inclusive of its last moment.
    @Test func theNewestMessageMayBeTakenBackForItsFirstMinuteOnly() throws {
        let rounds = strip(reading.lastTurn, reading.strip)
        let sentAt = try #require(reading.lastTurn.sentAt)
        let at = { (ms: Double) in Date(timeIntervalSince1970: (sentAt + ms) / 1000) }
        #expect(PhoneTakeBack.revertible(rounds[0], now: at(0)) == "ask-2")
        #expect(PhoneTakeBack.revertible(rounds[0], now: at(60_000)) == "ask-2")
        #expect(PhoneTakeBack.revertible(rounds[0], now: at(60_001)) == nil)
        // A card round is no message to take back.
        #expect(rounds[1].kind == .choice)
        #expect(PhoneTakeBack.revertible(rounds[1], now: at(0)) == nil)
    }

    @Test func aMessageTakenBackIsMarkedOnTheStripAndOffersNothingMore() throws {
        let back = reading.takeBack
        let rounds = strip(back.lastTurn, back.strip)
        #expect(rounds.map(\.you) == ["chart the open tasks by project", "chart the open tasks"])
        #expect(rounds.map(\.takenBack) == [true, true])
        #expect(rounds[0].replaces == "chart the open tasks")
        #expect(rounds[0].askId == "ask-edit")
        let sentAt = try #require(rounds[0].sentAt)
        #expect(PhoneTakeBack.revertible(rounds[0], now: Date(timeIntervalSince1970: sentAt / 1000)) == nil)
        // The message replaced before any turn read it carries the computer's typed line, worded on the phone.
        #expect(rounds[1].reply?.withdrawn == true)
        #expect(rounds[1].reply?.whole == PhoneMessages.shellLastTurnRevertedUnread())
        #expect(back.lastTurn.previous?.reply?.withdrawn == true)
    }

    /// The revert icon's tap draws Reverted at once over the computer's last turn, and settles on the last turn that
    /// marks it: the turn read before the tap lacks it, the marked one holds it, and one without the message voids it.
    @Test func aTakeBackShowsAtTheTapAndSettlesOnTheMarkedTurn() {
        var ledger = PhoneIntentLedger()
        ledger.add(.takeBack(ask: "ask-2"))
        let shown = PhoneIntentFold.lastTurn(reading.lastTurn, ledger.intents)
        #expect(shown?.takenBack == true && shown?.askId == "ask-2")
        #expect(shown?.previous?.takenBack != true)
        let marked = reading.lastTurn.marking("ask-2")
        #expect(PhoneIntentLedger.evidence(.takeBack(ask: "ask-2"), .turn(reading.lastTurn)) == .lacks)
        #expect(PhoneIntentLedger.evidence(.takeBack(ask: "ask-2"), .turn(marked)) == .holds)
        #expect(PhoneIntentLedger.evidence(.takeBack(ask: "ask-2"), .turn(reading.takeBack.lastTurn)) == .void)
        #expect(ledger.saw(.turn(reading.lastTurn), welcome: 1).isEmpty && !ledger.isEmpty)
        _ = ledger.saw(.turn(marked), welcome: 1)
        #expect(ledger.isEmpty)
    }

    /// A replacement draws the new message as the newest round and the one it replaces taken back as the older one.
    @Test func aReplacementShowsBothAtTheTap() {
        var ledger = PhoneIntentLedger()
        ledger.add(.takeBack(ask: "ask-2"))
        ledger.add(.send(text: "also remind me on Monday", before: PhoneTurnMark(reading.lastTurn)))
        let shown = PhoneIntentFold.lastTurn(reading.lastTurn, ledger.intents)
        #expect(shown?.you == "also remind me on Monday" && shown?.takenBack != true)
        #expect(shown?.previous?.you == reading.lastTurn.you && shown?.previous?.takenBack == true)
    }

    @Test func aRefusalIsHeldOnlyWhenTheMessageWasAlreadyTakenBack() throws {
        let decode = { (json: String) in try JSONDecoder().decode(PhoneTakeBackResult.self, from: Data(json.utf8)) }
        #expect(try decode(#"{"outcome":"withdrawn"}"#).holds)
        #expect(try decode(#"{"outcome":"undoing"}"#).holds)
        #expect(try decode(#"{"outcome":"refused","reason":"taken-back"}"#).holds)
        #expect(try !decode(#"{"outcome":"refused","reason":"past-window"}"#).holds)
    }
}
