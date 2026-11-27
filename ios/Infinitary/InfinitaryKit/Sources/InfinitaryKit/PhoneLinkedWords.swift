import Foundation

/// INF-7045's plan, part 2: a card thread's reply split at the addresses it writes as words, as the computer splits it
/// (`splitCardAddresses` in src/shared/linkify.ts). The pattern, punctuation and hosts are the computer's own, generated
/// into `PhoneAddressRule`; the trimming and opener logic here are twins of `trimTrailingUrlPunctuation` and
/// `isSafeCardHref`, held to the computer's split of the same replies by `PhoneLinkedWordsTests`.
public enum PhoneLinkedWords {
    public enum Part: Equatable, Sendable {
        case text(String)
        case address(String)
    }

    private static let expression = try! NSRegularExpression(pattern: PhoneAddressRule.pattern, options: [.caseInsensitive])

    /// The reply's words in order, each address the opener takes a part of its own. Positions are counted in UTF-16, as
    /// the pattern's matches and the computer's are.
    public static func parts(_ text: String) -> [Part] {
        let whole = text as NSString
        var parts: [Part] = []
        var cursor = 0
        for match in expression.matches(in: text, range: NSRange(location: 0, length: whole.length)) {
            let address = trimmed(whole.substring(with: match.range))
            guard !address.isEmpty, opens(address) else { continue }
            if match.range.location > cursor {
                parts.append(.text(whole.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            parts.append(.address(address))
            cursor = match.range.location + (address as NSString).length
        }
        if cursor < whole.length { parts.append(.text(whole.substring(from: cursor))) }
        return parts
    }

    /// The address without the sentence's punctuation after it, and without a closing bracket it never opened.
    static func trimmed(_ raw: String) -> String {
        var address = raw
        while let last = address.last {
            let opener = PhoneAddressRule.closers[last]
            guard PhoneAddressRule.trailing.contains(last) || opener.map({ unmatched(address, open: $0, close: last) }) == true
            else { break }
            address.removeLast()
        }
        return address
    }

    private static func unmatched(_ value: String, open: Character, close: Character) -> Bool {
        var depth = 0
        for character in value {
            if character == open { depth += 1 } else if character == close { depth -= 1 }
        }
        return depth < 0
    }

    /// The safe opener's rule: any https address, and http only to this device's own loopback names.
    public static func opens(_ address: String) -> Bool {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
              !host.isEmpty else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && (PhoneAddressRule.loopbackHosts.contains(host) || host.hasSuffix(PhoneAddressRule.localhostSuffix))
    }
}
