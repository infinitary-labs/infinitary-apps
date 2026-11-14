import Testing
@testable import InfinitaryKit

/// INF-1649, the captain's "Yes, “Update Infinitary on this phone” or “on your computer”": the line names the older side.
struct PhoneUpdateTests {
    @Test func namesTheOlderSide() {
        #expect(PhoneUpdate.side(phone: "12.0.0", computer: "14.0.0") == .phone)
        #expect(PhoneUpdate.side(phone: "12.0.0", computer: "10.1.0") == .computer)
        #expect(PhoneUpdate.side(phone: "12.0.0", computer: nil) == .phone)
        #expect(PhoneUpdate.computer.words == "Update Infinitary on your computer to make changes.")
        #expect(PhoneUpdate.phone.words == "Update Infinitary on this phone to make changes.")
    }

    /// INF-4012 piece 2: reading only, the line says the first mate still hears the phone, naming the side to update.
    @Test func saysTheFirstMateStillHears() {
        #expect(PhoneUpdate.computer.hearsWords
            == "Your first mate still hears your messages. Buttons come back once Infinitary on your computer is updated.")
        #expect(PhoneUpdate.phone.hearsWords
            == "Your first mate still hears your messages. Buttons come back once Infinitary on this phone is updated.")
    }

    /// The one change a reading-only phone sends is the shape the computer's `READ_ONLY_ASKS` lets through.
    @MainActor @Test func sendsPlainWordsAlone() {
        #expect(ReadOnlySession.plainWords("inf:converse", ["Merge the harbour fix"]))
        #expect(!ReadOnlySession.plainWords("inf:converse", ["   "]))
        #expect(!ReadOnlySession.plainWords("inf:converse", [["text": "Merge the harbour fix"]]))
        #expect(!ReadOnlySession.plainWords("inf:converse", ["Merge", "twice"]))
        #expect(!ReadOnlySession.plainWords("inf:cards:close", ["card-1"]))
    }
}
