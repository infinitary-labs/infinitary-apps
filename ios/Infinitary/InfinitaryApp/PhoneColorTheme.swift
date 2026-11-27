import InfinitaryKit
import SwiftUI
import UIKit

/// The built-in color theme a window draws (docs/themes.md, "On the phone"): a UIKit trait on the window, which UIKit
/// views, lists, sheets and the keyboard read, bridged into SwiftUI's environment, so SwiftUI's own views resolve their
/// colors again when the pick moves between two themes on the same base.
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
    /// The chosen built-in theme's id, or nil for Device, Dark and Light.
    var phoneColorTheme: String? {
        get { self[PhoneColorThemeKey.self] }
        set { self[PhoneColorThemeKey.self] = newValue }
    }

    /// The built-in theme these values draw, as `PhoneTheme.palette` picks it.
    var shownColorTheme: PhoneColorTheme? { PhoneColorTheme.shown(phoneColorTheme, dark: colorScheme == .dark) }
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

extension PhoneTheme {
    /// The palette a trait collection draws: the chosen built-in theme's, else Dark's or Light's.
    static func palette(_ traits: UITraitCollection) -> PhonePalette {
        let dark = traits.userInterfaceStyle != .light
        if let theme = PhoneColorTheme.shown(traits[PhoneColorThemeTrait.self], dark: dark) { return theme.palette }
        return dark ? .dark : .light
    }
}
