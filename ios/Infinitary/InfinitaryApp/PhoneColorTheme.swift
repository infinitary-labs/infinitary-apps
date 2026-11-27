import InfinitaryKit
import SwiftUI
import UIKit
import os

/// The color theme a window draws (docs/themes.md, "On the phone"): a UIKit trait on the window, which UIKit views,
/// lists, sheets and the keyboard read, bridged into SwiftUI's environment, so SwiftUI's own views resolve their colors
/// again when the pick moves between two themes on the same base. Its value is a built-in theme's id or an own theme's
/// key (`PhoneOwnPalettes`).
struct PhoneColorThemeTrait: UITraitDefinition {
    static let defaultValue: String? = nil
    static let affectsColorAppearance = true
    static let identifier = "com.getinfinitary.app.color-theme"
}

private struct PhoneColorThemeKey: UITraitBridgedEnvironmentKey {
    static let defaultValue: String? = nil
    static func read(from traitCollection: UITraitCollection) -> String? { traitCollection[PhoneColorThemeTrait.self] }
    static func write(to mutableTraits: inout UIMutableTraits, value: String?) { mutableTraits[PhoneColorThemeTrait.self] = value }
}

extension EnvironmentValues {
    /// The chosen built-in theme's id or own theme's key, or nil for Device, Dark and Light.
    var phoneColorTheme: String? {
        get { self[PhoneColorThemeKey.self] }
        set { self[PhoneColorThemeKey.self] = newValue }
    }

    /// The theme these values draw, as `PhoneTheme.palette` picks it.
    var shownColorTheme: PhoneDrawnTheme? { PhoneDrawnTheme.shown(phoneColorTheme, dark: colorScheme == .dark) }
}

extension PhoneColorTheme {
    /// The theme a saved id draws on a base, as the computer's `shownTheme` does: a built-in theme sitting on that base,
    /// or none, so something drawn in the other base, such as the media viewer's light page, takes that base's own colors.
    static func shown(_ id: String?, dark: Bool) -> PhoneColorTheme? {
        guard let id, let theme = PhoneColorTheme(rawValue: id), theme.isDark == dark else { return nil }
        return theme
    }

    var style: UIUserInterfaceStyle { isDark ? .dark : .light }
}

/// A color theme a window draws: a built-in one, or one of the person's own as the computer worked it out.
enum PhoneDrawnTheme: Hashable, Sendable {
    case builtIn(PhoneColorTheme)
    case own(PhoneOwnPalettes.Entry)

    /// The theme a trait value draws on a base, as `PhoneColorTheme.shown` does for a built-in one.
    static func shown(_ value: String?, dark: Bool) -> PhoneDrawnTheme? {
        if let theme = PhoneColorTheme.shown(value, dark: dark) { return .builtIn(theme) }
        guard let value, let entry = PhoneOwnPalettes.entry(value), entry.theme.isDark == dark else { return nil }
        return .own(entry)
    }

    var palette: PhonePalette {
        switch self {
        case .builtIn(let theme): theme.palette
        case .own(let entry): entry.palette
        }
    }

    /// What a card's or panel's page takes as its color theme (`phoneThemeRule`, CardRuntime/themeRule.ts): a built-in
    /// theme's id, or an own theme's tokens.
    var frameValue: PhoneJSON {
        switch self {
        case .builtIn(let theme): .string(theme.rawValue)
        case .own(let entry): .object(entry.theme.tokens.mapValues(PhoneJSON.string))
        }
    }

    /// `frameValue` written as a script's argument; nil writes null.
    static func script(_ theme: PhoneDrawnTheme?) -> String {
        guard let theme, let data = try? JSONEncoder().encode(theme.frameValue) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// The person's own themes the phone can draw, each palette built once from the computer's tokens. Colors resolve on
/// any thread, so the table sits behind a lock. A theme's key carries its tokens' fingerprint, so a theme saved again
/// under its name is a new trait value and every view resolves its colors again.
enum PhoneOwnPalettes {
    struct Entry: Hashable, Sendable {
        let key: String
        let theme: PhoneOwnTheme
        let palette: PhonePalette
        static func == (a: Entry, b: Entry) -> Bool { a.key == b.key }
        func hash(into hasher: inout Hasher) { hasher.combine(key) }
    }

    private static let table = OSAllocatedUnfairLock(initialState: [String: Entry]())

    /// Keeps the drawable ones of `themes`, those whose every token reads as a color, in place of the last list.
    static func keep(_ themes: [PhoneOwnTheme]) {
        let entries = themes.compactMap { theme -> Entry? in
            guard let palette = PhonePalette(tokens: theme.tokens) else { return nil }
            var print = Hasher()
            for (name, value) in theme.tokens.sorted(by: { $0.key < $1.key }) { print.combine(name); print.combine(value) }
            return Entry(key: "\(theme.id)#\(UInt(bitPattern: print.finalize()))", theme: theme, palette: palette)
        }
        table.withLock { $0 = Dictionary(entries.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first }) }
    }

    static func entry(_ key: String) -> Entry? { table.withLock { $0[key] } }

    /// The kept theme an id names, with the key its trait carries.
    static func entry(id: String) -> Entry? { table.withLock { $0.values.first { $0.theme.id == id } } }
}

extension PhonePalette {
    /// A CSS color as the computer's tokens write it, `#rrggbb` or `rgba(r, g, b, a)`; nil for any other.
    static func color(_ css: String) -> UIColor? {
        let value = css.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#"), value.count == 7, let rgb = UInt32(value.dropFirst(), radix: 16) {
            return UIColor(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
                           blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
        }
        guard value.hasPrefix("rgba("), value.hasSuffix(")") else { return nil }
        let parts = value.dropFirst(5).dropLast().split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4 else { return nil }
        return UIColor(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts[3])
    }
}

extension PhoneTheme {
    /// The palette a trait collection draws: the chosen theme's, else Dark's or Light's.
    static func palette(_ traits: UITraitCollection) -> PhonePalette {
        let dark = traits.userInterfaceStyle != .light
        if let theme = PhoneDrawnTheme.shown(traits[PhoneColorThemeTrait.self], dark: dark) { return theme.palette }
        return dark ? .dark : .light
    }
}
