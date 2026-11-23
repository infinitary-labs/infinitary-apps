import Foundation
import Testing
@testable import InfinitaryKit

struct CardValuesTests {
    /// INF-2022: the native reader is extensible JSON, so optional update fields do not alter legacy body/actions.
    @Test func optionalUpdateFieldsKeepLegacyCardReading() throws {
        let value: PhoneJSON = .object([
            "id": .string("card-findings"), "title": .string("Latency findings"), "author": .string("firstmate"),
            "body": .string("<p>The sampler has finished.</p>"),
            "actions": .array([.object(["id": .string("keep"), "label": .string("Keep the findings")])]),
            "offerId": .string("findings-offer"), "lifecycleId": .string("findings-life"),
            "seen": .bool(true), "currentUpdateId": .string("released-answer"), "currentUpdateSeen": .bool(false)
        ])
        let bytes = try JSONEncoder().encode(value)
        // The older PhoneCard's decoder used this same PhoneJSON reader and required these five fields.
        let legacy = try JSONDecoder().decode(PhoneJSON.self, from: bytes)
        #expect(legacy["id"].text == "card-findings")
        #expect(legacy["title"].text == "Latency findings")
        #expect(legacy["author"].text == "firstmate")
        #expect(legacy["body"] == value["body"])
        #expect(legacy["actions"] == value["actions"])
        let current = try JSONDecoder().decode(PhoneCard.self, from: bytes)
        #expect(current.value["seen"].flag)
        #expect(!current.currentUpdateSeen)
        #expect(current.currentUpdateID == "released-answer")
        #expect(current.actions == legacy["actions"].list)
    }

    /// INF-2714 review: the first mate's own answer names no task, while a card the app writes about a task - a
    /// required action, a closing note - keeps the task it heads with, as the Mac's `firstmateOwnCard` reads them.
    @Test func onlyTheFirstMatesOwnAnswerDropsItsTask() throws {
        func card(_ meta: String) throws -> PhoneCard {
            try PhoneCard(.object([
                "id": .string("card-fm-required-action-op1"), "title": .string("Renew the signing certificate"),
                "author": .string("firstmate"), "meta": .string(meta), "taskId": .string("t-sign"),
                "body": .string("<p>It expires on Friday.</p>"), "actions": .array([])
            ]))
        }
        #expect(try card("firstmate").isFirstmateOwn)
        #expect(try !card("Waiting on you").isFirstmateOwn)
        #expect(try !card("Release the alpha").isFirstmateOwn)
    }

    /// INF-499 #4: a reply admitted on the phone must fit the computer's UTF-16 budget.
    @Test func replyBudgetMatchesThePublishedWire() {
        let emoji = "😀"
        let fitting = String(repeating: emoji, count: PhoneLimits.reply / emoji.utf16.count)
        #expect(PhoneCard.canSendReply("Keep the northern entrance clear."))
        #expect(PhoneCard.canSendReply(fitting))
        #expect(!PhoneCard.canSendReply(fitting + emoji))
        #expect(!PhoneCard.canSendReply(" \n "))
    }

    /// INF-1670: the stuck alert takes a reply on the phone as on the Mac, answered by the first mate;
    /// the host's other cards still take none.
    @Test func stuckAlertTakesAReply() throws {
        let alert = try PhoneCard(.object([
            "id": .string("card-stall-a99caa29"), "title": .string("Move integration secrets has been stuck for 1h 21m"),
            "author": .string("host"), "taskId": .string("a99caa29"), "answeredBy": .string("firstmate"),
            "body": .string("<p>It stopped with nothing running and no question for you.</p>"), "actions": .array([])
        ]))
        #expect(alert.takesReplies)
        let signIn = try PhoneCard(.object([
            "id": .string("card-auth-claude"), "title": .string("Sign in to Claude again"), "author": .string("host"),
            "taskId": .string("a99caa29"), "body": .string("<p>Your sign-in ended.</p>"), "actions": .array([])
        ]))
        #expect(!signIn.takesReplies)
    }

    /// INF-6265 piece 1: the Mac's own card for a crewmate's ask takes a reply on the phone as on the Mac, answered by
    /// the crewmate that asked; without its task nobody can answer it.
    @Test func appAskTakesAReplyForItsCrewmate() throws {
        let ask: [String: PhoneJSON] = [
            "id": .string("card-secrets-ask-a99caa29-key"), "title": .string("Add Analytics API key to Secrets?"),
            "author": .string("host"), "taskId": .string("a99caa29"), "answeredBy": .string("crewmate"),
            "body": .string("<p>Asked by the crewmate on the task.</p>"), "actions": .array([])
        ]
        #expect(try PhoneCard(.object(ask)).takesReplies)
        var taskless = ask
        taskless["taskId"] = nil
        #expect(try !PhoneCard(.object(taskless)).takesReplies)
    }

    /// INF-1610: the "You asked" line reads the message the Mac sent, folds a long one onto one run of words,
    /// keeps its paragraphs when opened, and names a message of pictures alone.
    /// INF-1958: the bubble adds no quotation marks.
    @Test func askedLineReadsTheSavedMessage() throws {
        let message = "did something change about how we order the cards in the stack?\n\nkeep minimize as it is."
        let at = Date(timeIntervalSince1970: 1_793_200_200)
        let card = try PhoneCard(.object([
            "id": .string("card-1404-merge"), "title": .string("Keep a replied card in its place"),
            "author": .string("crewmate"), "body": .string("<p>Merged.</p>"), "actions": .array([]),
            "asked": .object(["at": .number(at.timeIntervalSince1970 * 1000), "text": .string(message)])
        ]))
        let asked = try #require(card.asked)
        #expect(asked.at == at)
        #expect(asked.words(open: false) == "did something change about how we order the cards in the stack? keep minimize as it is.")
        #expect(asked.words(open: true) == message)
        #expect(asked.label(now: at).hasPrefix("You asked · "))
        #expect(asked.label(now: at.addingTimeInterval(3 * 86_400)).contains(","))
        #expect(PhoneAsked(at: at, text: " ").words(open: false) == "A picture")
        let plain = try PhoneCard(.object([
            "id": .string("card-fm-1"), "title": .string("A note"), "author": .string("firstmate"),
            "body": .string("<p>Nothing asked.</p>"), "actions": .array([])
        ]))
        #expect(plain.asked == nil)
    }

    /// INF-2326, the captain: "when it comes from an automation, it should just say it's ran by an automation and name
    /// which one". The phone draws the same five kinds of line as the Mac: an automation and a task by name without a
    /// bubble, a click with its button's words and what was written, and how many tasks away the source sits.
    @Test func originLineNamesAutomationsClicksAndTasks() throws {
        let at = Date(timeIntervalSince1970: 1_793_200_200)
        let millis = PhoneJSON.number(at.timeIntervalSince1970 * 1000)
        func line(_ asked: [String: PhoneJSON]) throws -> PhoneAsked {
            try #require(try PhoneCard(.object([
                "id": .string("card-origin"), "title": .string("Three packages have newer versions"),
                "author": .string("firstmate"), "body": .string("<p>None is urgent.</p>"), "actions": .array([]),
                "asked": .object(asked)
            ])).asked)
        }
        let automation = try line(["at": millis, "text": .string("Nightly product audit"), "kind": .string("automation")])
        #expect(automation.label(now: at).hasPrefix("Run by an automation · "))
        #expect(!automation.inBubble)
        #expect(automation.text == "Nightly product audit")
        let click = try line([
            "at": millis, "text": .string("start them later"), "kind": .string("chose"),
            "choice": .string("File the picked improvements"), "through": .number(2)
        ])
        #expect(click.label(now: at).hasPrefix("You chose · "))
        #expect(click.label(now: at).hasSuffix(" · through 2 tasks"))
        #expect(click.words(open: false) == "File the picked improvements · start them later")
        // INF-2744: a click names the card it was on, as the Mac writes it.
        let onCard = try line([
            "at": millis, "text": .string(""), "kind": .string("chose"),
            "choice": .string("Merge the pull request"), "card": .string("Merge the meter fix")
        ])
        #expect(onCard.label(now: at).hasPrefix("You chose on “Merge the meter fix” · "))
        let from = try line([
            "at": millis, "text": .string("Cut tonight's alpha"), "kind": .string("from"), "key": .string("INF-2081")
        ])
        #expect(from.label(now: at) == "From INF-2081")
        #expect(!from.inBubble)
        let said = try line(["at": millis, "text": .string("keep the timeout"), "kind": .string("said"), "through": .number(1)])
        #expect(said.label(now: at).hasPrefix("You said · "))
        #expect(said.label(now: at).hasSuffix(" · through 1 task"))
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

    /// INF-5005 review: a card the Mac saved with the facts its title and buttons were worded from (`cardWordsMark`)
    /// reads them in the phone's words, as the Mac's `wordedCardText`. The card here was saved before its English was
    /// reworded, so the words shown can only come from the fact; a label with no fact, and a mark the phone cannot
    /// read, keep the words as saved.
    @Test func aCardWithItsWordedFactsReadsItsTitleAndButtonsFromThem() throws {
        func escaped(_ text: String) -> String {
            text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "'", with: "&#39;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
        }
        let facts = #"[{"text":"Move shop-kit to shop-web?","said":{"m":"projectsMoveTitleInto","a":{"repositories":"shop-kit","project":"shop-web"}}},{"text":"Apply","said":{"m":"projectsMoveApply"}}]"#
        func card(_ mark: String) throws -> PhoneCard {
            try PhoneCard(.object([
                "id": .string("card-project-change-project-move-p1"), "title": .string("Move shop-kit to shop-web?"),
                "author": .string("firstmate"),
                "body": .string("<template \(PhoneContract.cardWordsMark)=\"\(mark)\"></template><p>shop-kit moves.</p>"),
                "actions": .array([
                    .object(["id": .string("apply"), "label": .string("Apply")]),
                    .object(["id": .string("keep"), "label": .string("Keep it")])
                ])
            ]))
        }
        let worded = try card(escaped(facts))
        #expect(worded.title == "Move shop-kit into shop-web?")
        #expect(worded.actions.map { worded.label(of: $0) } == ["Apply move", "Keep it"])
        // Answered, the line that names the chosen button reads it as the button does.
        var answered = worded.value
        if case .object(var fields) = answered {
            fields["ending"] = .object(["how": .string("chose"), "label": .string("Apply"), "actionId": .string("apply")])
            answered = .object(fields)
        }
        #expect(try PhoneCard(answered).endingForWords["label"] == .string("Apply move"))
        let unreadable = try card(escaped("[{\"text\":"))
        #expect(unreadable.title == "Move shop-kit to shop-web?")
        #expect(unreadable.actions.map { unreadable.label(of: $0) } == ["Apply", "Keep it"])
    }
}
