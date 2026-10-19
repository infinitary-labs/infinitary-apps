import Foundation
import Testing
@testable import InfinitaryKit

struct CardValuesTests {
    /// INF-499 #4: a reply admitted on the phone must fit the computer's UTF-16 budget.
    @Test func replyBudgetMatchesThePublishedWire() {
        let emoji = "😀"
        let fitting = String(repeating: emoji, count: PhoneLimits.reply / emoji.utf16.count)
        #expect(PhoneCard.canSendReply("Keep the northern entrance clear."))
        #expect(PhoneCard.canSendReply(fitting))
        #expect(!PhoneCard.canSendReply(fitting + emoji))
        #expect(!PhoneCard.canSendReply(" \n "))
    }

    /// INF-499 #2: the actual body-choice receipt has a frame evidence actor, not a captain.
    @Test func frameChoiceNamesItsAuthorWithoutRewritingTheReceipt() throws {
        let card = try PhoneCard(.object([
            "id": .string("card-fm-phone-conversation"), "title": .string("Read the harbour chart"),
            "author": .string("firstmate"), "body": .string("<p>The survey is ready for your reply.</p>"),
            "actions": .array([]), "ending": .object([
                "how": .string("chose"), "actionId": .string("body"), "label": .string("Keep this chart"), "by": .string("frame")
            ])
        ]))
        #expect(card.endingForWords["by"] == .string("firstmate"))
        #expect(card.value["ending"]["by"] == .string("frame"))
    }

    /// INF-499 #6: a saved reading is not presented as fresh question evidence.
    @Test func savedDraftCarriesItsProvenance() throws {
        let card = try PhoneCard(.object([
            "id": .string("card-fm-phone-last-reading"), "title": .string("Keep the harbour note"),
            "author": .string("firstmate"), "body": .string("<p>Keep the harbour note.</p>"),
            "actions": .array([]), "offerId": .string("last-reading-offer")
        ]))
        let reading: PhoneJSON = .object([
            "answers": .array([]), "of": .number(0), "answered": .number(0), "questions": .array([])
        ])
        let fresh = card.submission(reading: reading)
        #expect(fresh["reading"] == .string("fresh"))
        #expect(fresh["questions"] == .array([]))
        let saved = card.submission(reading: reading, fresh: false)
        #expect(saved["reading"] == .string("fallback"))
        #expect(saved["questions"] == .null)
        #expect(saved["questionsGap"] == .string("no-fresh-reading"))
        #expect(saved["offerId"] == card.value["offerId"])
    }
}
