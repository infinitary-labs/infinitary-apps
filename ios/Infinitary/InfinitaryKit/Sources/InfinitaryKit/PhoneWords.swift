import Foundation

/// A line the Mac saved as a fact (docs/i18n.md, "Saved facts"): a catalog message by name and what fills its blanks,
/// so the phone words it in its own language when it shows it. The Mac's `said.ts` owns the shape.
public struct PhoneSaid: Decodable, Equatable, Sendable {
    public let m: String
    public let a: [String: Fill]?

    /// A blank's fill: words shown as they are, a count, a time of day worded where it is shown, or another message.
    public indirect enum Fill: Decodable, Equatable, Sendable {
        case words(String)
        case count(Double)
        case time(Double)
        case part(PhoneSaid)

        private enum Keys: String, CodingKey { case time }

        public init(from decoder: Decoder) throws {
            let single = try decoder.singleValueContainer()
            if let words = try? single.decode(String.self) { self = .words(words); return }
            if let count = try? single.decode(Double.self) { self = .count(count); return }
            if let time = try? decoder.container(keyedBy: Keys.self).decode(Double.self, forKey: .time) {
                self = .time(time); return
            }
            self = .part(try single.decode(PhoneSaid.self))
        }
    }

    public init(m: String, a: [String: Fill]? = nil) {
        self.m = m
        self.a = a
    }
}

/// The catalog's words on the phone (docs/i18n.md, "On the phone"): the Apple string files the message compiler
/// writes into this package, worded in the phone's language, and the Mac's saved facts worded from them.
public enum PhoneWords {
    /// The language the phone words the catalog in: the string files' language iOS chose for this phone.
    public static var language: String { Bundle.module.preferredLocalizations.first ?? "en" }

    /// Words led by a capital, as a heading reads the Mac's lowercase name of a group: its first letter in upper case,
    /// as the Mac's generator wrote it, and unchanged in a script with no case.
    public static func sentence(_ words: String) -> String {
        guard let first = words.first else { return words }
        return first.uppercased() + words.dropFirst()
    }

    /// One message worded from the string files, its fills in the order `fills` lists them; English when the phone's
    /// language lacks it. A count groups its digits as the language does, as the Mac's `formatNumber` writes it.
    static func format(_ name: String, _ fills: [CVarArg], locale: Locale = PhoneFormats.locale) -> String {
        String(format: Bundle.module.localizedString(forKey: name, value: nil, table: nil), locale: locale, arguments: fills)
    }

    /// A saved fact in the phone's language, as the Mac's `wordSaid` words it, or nil when this catalog cannot word it -
    /// a message it does not have, or a blank the fact never filled - so the caller shows the English saved beside it.
    public static func word(_ said: PhoneSaid, locale: Locale = PhoneFormats.locale) -> String? {
        guard let blanks = fills[said.m] else { return nil }
        let count = counts[said.m]
        var filled: [CVarArg] = []
        for blank in blanks {
            guard let fill = said.a?[blank] else { return nil }
            switch fill {
            case .count(let number) where blank == count:
                guard let whole = Int(exactly: number) else { return nil }
                filled.append(whole)
            case _ where blank == count:
                return nil
            case .words(let words): filled.append(words)
            // A number in a blank that is not a count shows as the Mac's template writes it.
            case .count(let number): filled.append(Int(exactly: number).map(String.init) ?? String(number))
            case .time(let at): filled.append(PhoneFormats.time(Date(timeIntervalSince1970: at / 1000), locale: locale))
            case .part(let part):
                guard let words = word(part, locale: locale) else { return nil }
                filled.append(words)
            }
        }
        return format(said.m, filled, locale: locale)
    }
}

extension PhoneWords {
    /// One title or button label a card saved, beside the fact it was worded from (the Mac's `cardWordsMark`).
    private struct CardWord: Decodable {
        let text: String
        let said: PhoneSaid
    }

    /// A card's saved title or button label in the phone's language, when its body carries the fact it was saved from,
    /// as the Mac's `wordedCardText` words it; otherwise, or when the phone cannot word that fact, the words as saved.
    public static func cardText(_ text: String, body: String?, locale: Locale = PhoneFormats.locale) -> String {
        guard let body, let mark = body.range(of: "\(PhoneContract.cardWordsMark)=\"") else { return text }
        guard let end = body[mark.upperBound...].firstIndex(of: "\"") else { return text }
        let raw = String(body[mark.upperBound..<end])
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
        guard let words = try? JSONDecoder().decode([CardWord].self, from: Data(raw.utf8)),
              let saved = words.first(where: { $0.text == text }) else { return text }
        return word(saved.said, locale: locale) ?? text
    }
}

public extension CodingUserInfoKey {
    /// The name of the Mac the phone reads, so a line in that Mac's own words names it where it says this computer.
    static let phoneHome = CodingUserInfoKey(rawValue: "infinitary.phoneHome")!
}

extension PhoneSaid {
    /// The fact with each blank the Mac filled with itself named from the phone, as the Mac's `placesAs` names it on
    /// another computer (src/shared/deviceNames.ts): this computer becomes the Mac's name, and here becomes on it.
    public func placed(as name: String) -> PhoneSaid {
        guard let a else { return self }
        var fills = a
        for (blank, fill) in a {
            guard case .part(let place) = fill else { continue }
            if place.m == PhoneContract.placeThis { fills[blank] = .words(name) }
            if place.m == PhoneContract.placeHere { fills[blank] = .part(PhoneSaid(m: PhoneContract.placeOn, a: ["computer": .words(name)])) }
        }
        return fills == a ? self : PhoneSaid(m: m, a: fills)
    }
}

extension PhoneWords {
    /// A saved line as the phone shows it (docs/i18n.md, "Saved facts"): its fact in the phone's language, or the
    /// English the Mac saved beside it when the phone cannot word the fact. A line in the Mac's own words (`here`)
    /// names that Mac where it says this computer, as the Mac's own view of another computer does
    /// (src/main/view/namedHere.ts): a fact's places are named first, and words that still say this computer keep
    /// their English with the Mac's name in it.
    public static func line(_ text: String, said: PhoneSaid?, here: Bool, home: String?, locale: Locale = PhoneFormats.locale) -> String {
        guard here, let home else { return said.flatMap { word($0, locale: locale) } ?? text }
        let named = PhoneContract.hereWords.reduce(text) { $0.replacingOccurrences(of: $1, with: home) }
        guard let said else { return named }
        let placed = said.placed(as: home)
        if placed != said { return word(placed, locale: locale) ?? named }
        return named == text ? word(said, locale: locale) ?? text : named
    }

    /// A decoder whose saved lines name `home` where the Mac said this computer of itself.
    static func decoder(home: String?) -> JSONDecoder {
        let decoder = JSONDecoder()
        if let home { decoder.userInfo[.phoneHome] = home }
        return decoder
    }

    /// A saved line's words as a reader decodes them: `text`, worded from `said` and named by `saidHere` beside it.
    static func line<Keys: CodingKey>(_ container: KeyedDecodingContainer<Keys>, text: Keys, said: Keys, here: Keys, decoder: Decoder) throws -> String {
        let english = try container.decode(String.self, forKey: text)
        let fact = try? container.decodeIfPresent(PhoneSaid.self, forKey: said)
        let mine = (try? container.decodeIfPresent(Bool.self, forKey: here)) == true
        return line(english, said: fact ?? nil, here: mine, home: decoder.userInfo[.phoneHome] as? String)
    }
}
