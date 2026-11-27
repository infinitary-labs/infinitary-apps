import Foundation

/// The captain's Approve and build on a theme of the phone's own: Infinitary on iPhone and iPad keeps its Theme on the
/// device, apart from the computer's, and offers to match the device, Dark, Light or a built-in color theme (INF-6888's
/// part 3, the captain's "each client can choose its own theme"). The choice is saved in this app's own defaults, never
/// in the connection file, so Leave, Forget, Removed and joining another computer keep it, and it never reaches the
/// computer. Nothing saved, or a value this version does not know, reads as matching the device.
public enum PhoneLook: Hashable, Sendable, CaseIterable, RawRepresentable {
    case device, dark, light
    case theme(PhoneColorTheme)

    /// Device, Dark and Light first, then the built-in themes in the computer's order.
    public static var allCases: [PhoneLook] { [.device, .dark, .light] + PhoneColorTheme.allCases.map(PhoneLook.theme) }

    /// What the phone-theme key saves: device, dark, light or a built-in theme's id, as the computer names it.
    public var rawValue: String {
        switch self {
        case .device: "device"
        case .dark: "dark"
        case .light: "light"
        case .theme(let theme): theme.rawValue
        }
    }

    public init?(rawValue: String) {
        switch rawValue {
        case "device": self = .device
        case "dark": self = .dark
        case "light": self = .light
        default:
            guard let theme = PhoneColorTheme(rawValue: rawValue) else { return nil }
            self = .theme(theme)
        }
    }

    /// The words on the choice: Device, Dark and Light as short as the computer's, a built-in theme under its maker's
    /// name in every language.
    public var words: String {
        switch self {
        case .device: PhoneMessages.phoneLookDevice()
        case .dark: PhoneMessages.phoneLookDark()
        case .light: PhoneMessages.phoneLookLight()
        case .theme(let theme): theme.name
        }
    }

    /// The built-in theme this choice draws, if any.
    public var colorTheme: PhoneColorTheme? {
        if case .theme(let theme) = self { theme } else { nil }
    }

    static let key = "phone-theme"

    public static func saved(in defaults: UserDefaults = .standard) -> PhoneLook {
        defaults.string(forKey: key).flatMap(PhoneLook.init(rawValue:)) ?? .device
    }

    public func save(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.key)
    }
}

/// The captain, on an iPhone Duo open like a book: "is there a way for the user to not split the view, but instead see
/// what an ipad would see?" Split at the fold, under Settings → Appearance, is this device's own switch, saved beside
/// its Theme and never sent to the computer. On, the default, the open Duo keeps Tasks and Activity on one side of the
/// fold and Home on the other; off, it lays out as an iPad does. Whether this device has shown a fold is saved too, so
/// the switch stays in Settings while the phone is closed, and a device that never folds never shows it.
public enum PhoneFoldSplit {
    static let key = "phone-split-at-fold"
    static let seenKey = "phone-fold-seen"

    public static func saved(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }

    public static func save(_ split: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(split, forKey: key)
    }

    public static func foldSeen(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: seenKey)
    }

    public static func saveFoldSeen(in defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: seenKey)
    }
}

/// The captain's pick "Direction 1: Maximize card, as on the Mac": wherever a side panel shares the window with Home's
/// card, an open iPhone Duo or an iPad on its side, the card's Maximize gives it the window and Restore brings the split
/// back. The choice is this device's own, saved beside its Theme and never sent to the computer, so the card stays
/// maximized from card to card and after a relaunch until Restore. Nothing saved reads as the usual split.
public enum PhoneCardMaximized {
    static let key = "phone-card-maximized"

    public static func saved(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: key)
    }

    public static func save(_ maximized: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(maximized, forKey: key)
    }
}
