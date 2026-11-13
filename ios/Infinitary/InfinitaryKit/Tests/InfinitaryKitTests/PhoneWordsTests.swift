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
}
