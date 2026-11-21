import Foundation
import Testing
@testable import InfinitaryKit

/// INF-5445 piece 2: the phone shares each open card's unsent picks, the words in its field and its queued notes with
/// every other screen (docs/ios.md, "Unsent picks on the phone"). The captain: "make sure the words are not literally
/// resending on every keystroke".
@MainActor struct PhoneCardDraftsTests {
    /// The computer as the phone reaches it: each change the phone sent, the answer it gives, and the captain's pause,
    /// which runs only when the test says the pause is over.
    @MainActor final class Home {
        var reach = true
        var sent: [(card: String, change: PhoneJSON)] = []
        var answer: (String, PhoneJSON) -> PhoneJSON = { card, change in
            .object(["draft": PhoneCardDraftsTests.draft(card, revision: 1, words: change["words"].text ?? "").json])
        }
        var pauses: [(run: @MainActor () -> Void, cancelled: Bool)] = []
        lazy var drafts = PhoneCardDrafts(
            send: { [unowned self] card, change in
                self.sent.append((card, change))
                guard self.reach else { throw PhoneError.unavailable }
                return self.answer(card, change)
            },
            canSend: { [unowned self] in self.reach },
            later: { [unowned self] run in
                let index = self.pauses.count
                self.pauses.append((run, false))
                return PhoneDraftTimer { [weak self] in Task { @MainActor in self?.pauses[index].cancelled = true } }
            })

        /// The captain stopped typing: every pause still waiting runs, and every request it sent is answered.
        func pause() async {
            await settle()
            let waiting = pauses.indices.filter { !pauses[$0].cancelled }
            for index in waiting { pauses[index].cancelled = true; pauses[index].run() }
            await settle()
        }
        func settle() async { for _ in 0..<20 { await Task.yield() } }
    }

    static func draft(_ card: String, revision: Int, answers: [PhoneJSON] = [], words: String = "", notes: [PhoneJSON] = [])
        -> PhoneCardDraft {
        PhoneCardDraft(cardID: card, lifecycle: "open-1", revision: revision, answers: answers, words: words, notes: notes)
    }
    static func card(_ id: String, opening: String = "open-1") -> PhoneCard {
        PhoneCard(trusted: .object(["id": .string(id), "lifecycleId": .string(opening), "title": .string("Pick one"),
                                    "author": .string("firstmate"), "body": .string("<p>Pick one</p>"), "actions": .array([])]))
    }
    /// A pick as a card body reads it (`cardAnswerSchema` in src/shared/cards.ts).
    static func answer(_ name: String, _ value: String) -> PhoneJSON {
        .object(["name": .string(name), "values": .array([.string(value)]), "labels": .array([.string(value.capitalized)]),
                 "changed": .bool(true)])
    }

    /// A note on the body's first paragraph as the phone queues one (`cardNoteSchema` in src/shared/cards.ts).
    static func note(_ comment: String) -> PhoneJSON {
        .object(["start": .number(0), "key": .string("p:0"), "kind": .string("p"), "excerpt": .string("Pick one"),
                 "comment": .string(comment), "line": .number(1)])
    }

    /// A phone joined to a computer that keeps drafts, holding one open card whose draft is empty.
    private func joined() async -> Home {
        let home = Home()
        home.drafts.cards([Self.card("card-1")])
        home.drafts.welcome([])
        await home.settle()
        return home
    }

    @Test func wordsTypedInOneRunGoOnceTheCaptainPauses() async {
        let home = await joined()
        for typed in ["S", "Sh", "Shi", "Ship", "Ship i", "Ship it"] { home.drafts.type("card-1", words: typed) }
        await home.settle()
        #expect(home.sent.isEmpty)
        await home.pause()
        #expect(home.sent.count == 1)
        #expect(home.sent.first?.change["words"] == .string("Ship it"))
        #expect(home.sent.first?.change["since"] == .number(0))
        #expect(home.sent.first?.change["lifecycle"] == .string("open-1"))
    }

    @Test func aPickMadeOutOfReachGoesOnReturnAgainstTheRevisionItWasMadeAt() async {
        let home = await joined()
        home.drafts.heard(Self.draft("card-1", revision: 3, answers: [Self.answer("size", "small")]))
        home.reach = false
        home.drafts.read("card-1", answers: .array([Self.answer("size", "large")]))
        await home.pause()
        #expect(home.sent.isEmpty)
        // Back in reach, the welcome's reading still says revision 3, so the pick goes, naming it.
        home.reach = true
        home.answer = { card, _ in .object(["draft": Self.draft(card, revision: 4, answers: [Self.answer("size", "large")]).json]) }
        home.drafts.welcome([Self.draft("card-1", revision: 3, answers: [Self.answer("size", "small")])])
        await home.settle()
        #expect(home.sent.count == 1)
        #expect(home.sent.first?.change["since"] == .number(3))
        #expect(home.sent.first?.change["answers"] == .array([Self.answer("size", "large")]))
        #expect(home.drafts.answers["card-1"] == .array([Self.answer("size", "large")]))
    }

    @Test func anotherScreensNewerPickOfTheSamePartWinsOverOneMadeOutOfReach() async {
        let home = await joined()
        home.drafts.heard(Self.draft("card-1", revision: 3, answers: [Self.answer("size", "small")]))
        home.reach = false
        home.drafts.read("card-1", answers: .array([Self.answer("size", "large")]))
        await home.pause()
        // Meanwhile another screen picked medium at revision 4; the computer passes over the phone's older pick.
        home.reach = true
        let theirs = Self.draft("card-1", revision: 4, answers: [Self.answer("size", "medium")])
        home.answer = { _, _ in .object(["draft": theirs.json, "passed": .object(["answers": .array([.string("size")])])]) }
        home.drafts.welcome([theirs])
        await home.settle()
        #expect(home.sent.first?.change["since"] == .number(3))
        #expect(home.drafts.answers["card-1"] == .array([Self.answer("size", "medium")]))
    }

    @Test func anotherScreensPickReachesTheBodyOnScreen() async {
        let home = await joined()
        var filled: [PhoneJSON] = []
        let detach = home.drafts.attach("card-1") { filled.append($0); return true }
        home.drafts.heard(Self.draft("card-1", revision: 1, answers: [Self.answer("size", "small")]))
        #expect(filled == [.array([Self.answer("size", "small")])])
        detach()
        // With no body on screen, the next body starts with the pick.
        home.drafts.heard(Self.draft("card-1", revision: 2, answers: [Self.answer("size", "large")]))
        #expect(filled.count == 1)
        #expect(home.drafts.fill("card-1") == .array([Self.answer("size", "large")]))
        await home.pause()
        #expect(home.sent.isEmpty)
    }

    @Test func anotherScreensWordsWaitWhileTheFieldIsTypedIn() async {
        let home = await joined()
        home.drafts.typing("card-1", true)
        home.drafts.heard(Self.draft("card-1", revision: 1, words: "From the Mac"))
        #expect(home.drafts.words["card-1"] == nil)
        home.drafts.typing("card-1", false)
        #expect(home.drafts.words["card-1"] == "From the Mac")
    }

    @Test func aNoteQueuedOnThePhoneGoesAndAnotherScreensNoteShowsHere() async {
        let home = await joined()
        let mine = Self.note("Ask the harbour office first")
        home.answer = { card, change in .object(["draft": Self.draft(card, revision: 1, notes: change["notes"].list).json]) }
        home.drafts.note("card-1", notes: [mine])
        await home.pause()
        #expect(home.sent.count == 1)
        #expect(home.sent.first?.change["notes"] == .array([mine]))
        // Another screen edits the note's comment: the queued note here shows its words.
        let theirs = Self.note("Ask the pilot too")
        home.drafts.heard(Self.draft("card-1", revision: 2, notes: [theirs]))
        #expect(home.drafts.notes["card-1"] == [theirs])
        await home.pause()
        #expect(home.sent.count == 1)
    }

    @Test func aCardClosedElsewhereLetsItsDraftGo() async {
        let home = await joined()
        home.answer = { _, _ in .object(["refused": .string("closed")]) }
        home.drafts.type("card-1", words: "Too late")
        await home.pause()
        #expect(home.sent.count == 1)
        // The refused change never goes again, and the card leaving the computer's cards lets the words here go.
        home.drafts.welcome([])
        await home.pause()
        #expect(home.sent.count == 1)
        #expect(home.drafts.cards([]) == false)
        #expect(home.drafts.words["card-1"] == nil)
    }

    @Test func aChangeRefusedForItsSizeIsNotSentAgainUnchanged() async {
        let home = await joined()
        home.answer = { _, _ in .object(["refused": .string("too-large")]) }
        home.drafts.type("card-1", words: "Long words")
        await home.pause()
        #expect(home.sent.count == 1)
        home.drafts.welcome([Self.draft("card-1", revision: 0)])
        await home.pause()
        #expect(home.sent.count == 1)
    }

    @Test func aComputerThatKeepsNoDraftsIsSentNothing() async {
        let home = Home()
        home.drafts.cards([Self.card("card-1")])
        home.drafts.type("card-1", words: "Stays here")
        home.drafts.note("card-1", notes: [.object(["start": .number(0), "key": .string("p:0"), "kind": .string("p"), "excerpt": .string("Pick one"),
                                                 "comment": .string("Ask the harbour office first"), "line": .number(1)])])
        await home.pause()
        #expect(home.sent.isEmpty)
        #expect(home.pauses.isEmpty)
        #expect(home.drafts.words["card-1"] == "Stays here")
    }

    @Test func aCardOpenedAnewDropsWhatThePhoneHeldForItsEarlierOpening() async {
        let home = await joined()
        home.drafts.type("card-1", words: "For the first opening")
        #expect(home.drafts.cards([Self.card("card-1", opening: "open-2")]))
        #expect(home.drafts.words["card-1"] == nil)
        await home.pause()
        #expect(home.sent.isEmpty)
    }
}

private extension PhoneCardDraft {
    var json: PhoneJSON {
        var fields: [String: PhoneJSON] = ["cardId": .string(cardID), "revision": .number(Double(revision)),
                                           "answers": .array(answers), "words": .string(words), "notes": .array(notes)]
        if let lifecycle { fields["lifecycle"] = .string(lifecycle) }
        return .object(fields)
    }
}
