import CoreText
import Foundation
import Testing
@testable import InfinitaryKit

/// The captain's report that the last turn's lines "can get cut off mid word", and their ask: "i think we should
/// preserve full words". The phone's rows set each line in one line and let the text cut itself at the width the row
/// offers (MessageComposer.swift), so this reads what CoreText, the text's own engine, draws at the width
/// `WholeWords` offers. Fixture: the conversation in the captain's picture, at every row width from wide to narrow.
/// Failure: a line whose ellipsis follows part of a word, or one cut a whole word early.
struct WholeWordsTests {
    private let font = CTFontCreateUIFontForLanguage(.system, 15, nil)!
    private let lines = [
        #"i'm thinking of renaming the label "Care" to "Rigor" or "Quality" because Care reads soft"#,
        "I asked a crewmate to recommend a new name for “Care”. It will compare both and come back with one.",
    ]

    private func line(_ text: some StringProtocol) -> CTLine {
        CTLineCreateWithAttributedString(NSAttributedString(string: String(text), attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
    }

    private func width(_ text: some StringProtocol) -> CGFloat {
        CGFloat(CTLineGetTypographicBounds(line(text), nil, nil, nil))
    }

    /// The words CoreText draws before its ellipsis when it cuts `words` to `width`.
    private func drawn(_ words: String, at width: CGFloat) -> Substring {
        let cut = CTLineCreateTruncatedLine(line(words), Double(width), .end, line("…"))!
        // The ellipsis is the last run, standing for every character it hides.
        let runs = CTLineGetGlyphRuns(cut) as! [CTRun]
        let hidden = CTRunGetStringRange(runs.last!).location
        return words[..<String.Index(utf16Offset: hidden, in: words)]
    }

    @Test func endsEachCutLineOnTheLastWholeWordThatFits() throws {
        var cuts = 0
        for words in lines {
            for room in stride(from: width(words) - 1, to: 120, by: -7) {
                let offered = try #require(WholeWords.width(for: words, font: font, room: room), "\(room) points")
                #expect(offered <= room)
                let shown = drawn(words, at: offered)
                let rest = words[shown.endIndex...]
                #expect(rest.first == " ", "At \(room) points the line ends part way through a word: \(shown)…")
                #expect(shown.last?.isWhitespace == false)
                // The next whole word would not fit beside the ellipsis.
                let next = rest.dropFirst().prefix { !$0.isWhitespace }
                #expect(width(shown + " " + next) + width("…") > room, "At \(room) points \(shown)… stops a word early")
                cuts += 1
            }
            #expect(WholeWords.width(for: words, font: font, room: width(words) + 1) == nil, "A line that fits is left whole")
        }
        #expect(cuts > 20)
    }
}
