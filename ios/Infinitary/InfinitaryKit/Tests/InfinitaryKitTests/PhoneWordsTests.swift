import Foundation
import Testing
@testable import InfinitaryKit

/// The approved plan for the phone's languages (INF-3675, piece 1): the phone words the Mac's saved facts as the
/// desktop does. scripts/generate-messages.ts records the desktop's own `wordSaid` for every message in the catalog,
/// each blank filled apart, each plural at counts that pick different forms and group digits, a message filling
/// another's blank, and facts no catalog words; the phone words the same facts from its Apple string files.
struct PhoneWordsTests {
    private struct Case: Decodable { let said: PhoneSaid; let words: String? }

    @Test func wordsEverySavedFactAsTheDesktopDoes() throws {
        let url = try #require(Bundle.module.url(forResource: "PhoneWords.generated", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
        #expect(cases.count > 700)
        for sample in cases {
            #expect(PhoneWords.word(sample.said, locale: Locale(identifier: "en_US")) == sample.words, "\(sample.said.m)")
        }
    }

    /// INF-3675's piece 3: the phone words a feed line from the fact beside its English, names the Mac where a line in
    /// its own words says this computer, as the desktop's view of another computer does, and shows the saved English
    /// of a fact it cannot word. The lines are the Mac's own: `runsOnSaid`'s fact (src/shared/repos.ts) and a merge.
    @Test func wordsTheMacsFeedLinesNamingTheMac() async throws {
        let place = { (name: String) in ["m": name] }
        let lines: [[String: Any]] = [
            ["kind": "repo_runs_on", "at": 1, "saidHere": true,
             "text": "notes-app runs on this computer now. Its next task starts here.",
             "said": ["m": "feedRunsOnHere", "a": ["name": "notes-app", "computer": place("placeThisComputer"), "here": place("placeHere")]]],
            ["kind": "firstmate_note", "at": 2, "saidHere": true, "text": "Paused this computer's crew."],
            ["kind": "task_event", "at": 3, "taskKey": "INF-61", "text": "Merged PR #61", "said": ["m": "noSuchMessage"]],
        ]
        let frame = try JSONSerialization.data(withJSONObject: ["t": "result", "id": 4, "ok": true, "value": lines])
        let decoded = try await PhoneFrame.decode(String(decoding: frame, as: UTF8.self), reads: [4: PhoneContract.feed], home: "Studio Mac")
        #expect(try decoded.feed().map(\.text) == [
            "notes-app runs on Studio Mac now. Its next task starts on Studio Mac.",
            "Paused Studio Mac's crew.",
            "Merged PR #61",
        ])
    }
}

