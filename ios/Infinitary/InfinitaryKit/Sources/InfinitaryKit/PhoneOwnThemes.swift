import Foundation

/// One of the person's own color themes as the computer worked it out (`inf:settings:own-themes:get`,
/// docs/themes.md, "On the phone"): its id and name, the base it sits on and every color token, so the phone draws it
/// with none of the math.
public struct PhoneOwnTheme: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `dark` or `light`.
    public let base: String
    /// Each CSS color token by its name, such as `--bg-0`, as the window's own sheet has it.
    public let tokens: [String: String]

    public init(id: String, name: String, base: String, tokens: [String: String]) {
        self.id = id; self.name = name; self.base = base; self.tokens = tokens
    }

    public var isDark: Bool { base == "dark" }
}

/// The last list of own themes the phone read from its computer, kept in this app's own defaults beside its Theme, so
/// Yours and a pick among them survive a relaunch and a computer that cannot answer the read.
public enum PhoneOwnThemes {
    static let key = "phone-own-themes"

    /// The read's answer.
    public struct Answer: Decodable, Sendable { public let themes: [PhoneOwnTheme] }

    public static func saved(in defaults: UserDefaults = .standard) -> [PhoneOwnTheme] {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([PhoneOwnTheme].self, from: $0) } ?? []
    }

    public static func save(_ themes: [PhoneOwnTheme], in defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(themes), forKey: key)
    }
}
