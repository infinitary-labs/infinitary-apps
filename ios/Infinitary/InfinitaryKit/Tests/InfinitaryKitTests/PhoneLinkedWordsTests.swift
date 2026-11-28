import Foundation
import InfinitaryKit
import Testing

/// INF-7045's plan, part 2 (the captain's pick "Card bodies and the card's thread replies"): the phone links a thread
/// reply's addresses exactly where the computer does. Each reading is a reply and the computer's own split of it
/// (`splitCardBodyUrls`, written by scripts/generate-phone-scene.ts).
struct PhoneLinkedWordsTests {
    private struct Reading: Decodable {
        let text: String
        let parts: [Piece]
    }
    private struct Piece: Decodable {
        let type: String
        let value: String
    }

    private func readings() throws -> [Reading] {
        let url = try #require(Bundle.module.url(forResource: "PhoneLinkedWords.generated", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Reading].self, from: Data(contentsOf: url))
    }

    @Test func splitsEachReplyAsTheComputerDoes() throws {
        let readings = try readings()
        #expect(!readings.isEmpty)
        for reading in readings {
            let expected = reading.parts.map { $0.type == "url" ? PhoneLinkedWords.Part.address($0.value) : .text($0.value) }
            #expect(PhoneLinkedWords.parts(reading.text) == expected, "\(reading.text)")
        }
    }
}
