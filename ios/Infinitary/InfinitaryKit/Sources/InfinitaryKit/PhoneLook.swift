import Foundation

/// The captain's Approve and build on a theme of the phone's own: Infinitary on iPhone and iPad keeps its Theme on the
/// device, apart from the computer's, and offers to match the device, Dark or Light. The choice is saved in this app's
/// own defaults, never in the connection file, so Leave, Forget, Removed and joining another computer keep it, and it
/// never reaches the computer. Nothing saved, or a value this version does not know, reads as matching the device.
public enum PhoneLook: String, CaseIterable, Sendable {
    case device, dark, light

    /// The words on the segmented control, as short as the computer's Dark and Light pills.
    public var words: String {
        switch self {
        case .device: PhoneMessages.phoneLookDevice()
        case .dark: PhoneMessages.phoneLookDark()
        case .light: PhoneMessages.phoneLookLight()
        }
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
