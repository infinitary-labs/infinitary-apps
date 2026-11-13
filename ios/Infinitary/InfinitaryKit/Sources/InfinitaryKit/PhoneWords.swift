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
