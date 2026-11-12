import CoreText
import Foundation

/// One line of words cut after a whole word, the Mac's rule (src/renderer/src/design/core/wholeWords.ts): a line too
/// long for its row ends on the last whole word that fits beside the ellipsis, never part way through one. The text
/// keeps all its words and its own tail cut; the row only offers it the width of the words it shows, the ellipsis and
/// half the next character, so its own ellipsis falls right after the last whole word. A first word too wide for the
/// row keeps the text's own cut, part way through it.
public enum WholeWords {
    /// Where a line of `words` may be cut: before a space that ends a word, and between two words of a script written
    /// without spaces, where one word starts as the last ends.
    public static func ends(_ words: String) -> [String.Index] {
        var ends = Set<String.Index>()
        var previous: Character?
        for index in words.indices {
            let character = words[index]
            if let previous, breaks(character), !previous.isWhitespace { ends.insert(index) }
            previous = character
        }
        var last: Range<String.Index>?
        words.enumerateSubstrings(in: words.startIndex..., options: [.byWords, .substringNotRequired]) { _, range, _, _ in
            if let last, last.upperBound == range.lowerBound { ends.insert(range.lowerBound) }
            last = range
        }
        return ends.sorted()
    }

    /// The width to offer one line of `words` set in `font` within `room` points, so the text's own tail cut falls
    /// after the last whole word that fits beside the ellipsis; nil when every word fits, or the first alone does not.
    public static func width(for words: String, font: CTFont, room: CGFloat) -> CGFloat? {
        func measure(_ text: some StringProtocol) -> CGFloat {
            let set = NSAttributedString(string: String(text), attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
            return CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(set), nil, nil, nil))
        }
        guard measure(words) > room else { return nil }
        let ends = ends(words)
        let ellipsis = measure("…")
        // How many cuts fit: the widths only grow along the line.
        var low = 0
        var high = ends.count
        while low < high {
            let middle = (low + high) / 2
            if measure(words[..<ends[middle]]) + ellipsis <= room { low = middle + 1 } else { high = middle }
        }
        guard low > 0 else { return nil }
        let end = ends[low - 1]
        let shown = measure(words[..<end])
        let next = measure(words[...end]) - shown
        return min(room, shown + ellipsis + next / 2)
    }

    /// A space a line may break at: no-break spaces join their words.
    private static func breaks(_ character: Character) -> Bool {
        character.isWhitespace && !["\u{00A0}", "\u{2007}", "\u{202F}"].contains(character)
    }
}
