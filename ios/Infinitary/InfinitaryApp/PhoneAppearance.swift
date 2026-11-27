import InfinitaryKit
import SwiftUI
import UIKit

/// The captain's Approve and build on a theme of the phone's own (`PhoneLook`): the one owner of this device's choice.
/// A change is saved at once, so it survives a relaunch and an update, and it is never sent to the computer.
@MainActor @Observable final class PhoneAppearance {
    var look: PhoneLook { didSet { look.save() } }
    /// The captain's Split at the fold (`PhoneFoldSplit`): off, an open iPhone Duo lays out as an iPad does.
    var splitAtFold: Bool { didSet { PhoneFoldSplit.save(splitAtFold) } }
    /// The captain's Maximize card (`PhoneCardMaximized`): Home's card takes the window wherever a side panel shares it.
    var cardMaximized: Bool { didSet { PhoneCardMaximized.save(cardMaximized) } }
    /// An explicit Show panels / Fold panels choice for the open split Duo. No choice means card first.
    private static let duoPanelsKey = "phone-panels-shown"
    var duoPanelsShown: Bool { didSet { UserDefaults.standard.set(duoPanelsShown, forKey: Self.duoPanelsKey) } }
    /// Whether this device has shown a fold, which brings Split at the fold into Settings → Appearance.
    private(set) var foldSeen: Bool
    /// The captain's off switch for the Pencil's placement (`PhonePencilTop`): off, the message box keeps to the foot.
    var pencilTop: Bool { didSet { PhonePencilTop.save(pencilTop) } }
    /// Whether this device has seen an Apple Pencil, which brings that switch into Settings → Appearance.
    private(set) var pencilSeen: Bool

    init() {
        look = PhoneLook.saved()
        splitAtFold = PhoneFoldSplit.saved()
        cardMaximized = PhoneCardMaximized.saved()
        foldSeen = PhoneFoldSplit.foldSeen()
        pencilTop = PhonePencilTop.saved()
        pencilSeen = PhonePencilTop.pencilSeen()
        duoPanelsShown = UserDefaults.standard.bool(forKey: Self.duoPanelsKey)
    }

    /// A window reported a fold running down it, as an iPhone Duo open like a book does.
    func sawFold() {
        guard !foldSeen else { return }
        foldSeen = true
        PhoneFoldSplit.saveFoldSeen()
    }

    /// The window saw an Apple Pencil touch or hover, or iPadOS expects Pencil input.
    func sawPencil() {
        guard !pencilSeen else { return }
        pencilSeen = true
        PhonePencilTop.savePencilSeen()
    }

    /// The next choice to the left (-1) or right (1) of the current one, kept at the ends, as a segmented control's
    /// arrows move.
    func step(by offset: Int) {
        let looks = PhoneLook.allCases
        guard let at = looks.firstIndex(of: look), looks.indices.contains(at + offset) else { return }
        look = looks[at + offset]
    }
}

extension PhoneLook {
    /// Device leaves the window to the system's own setting, so iOS's Automatic switching keeps working; a built-in
    /// color theme sets its base, so everything that knows only Dark and Light follows that.
    var style: UIUserInterfaceStyle {
        switch self {
        case .device: .unspecified
        case .dark: .dark
        case .light: .light
        case .theme(let theme): theme.style
        }
    }
}

/// Sets the style and the color theme of the window it sits in. Sheets, the keyboard, card web views and the crew all
/// read their appearance from that window, so one setting changes every screen at once. Each window of an iPad's several
/// windows carries its own copy, so a new window starts in the chosen theme too. SwiftUI's own views also need the theme
/// as an environment value (`PhoneColorThemeTrait`), which the app's root sets beside this.
struct PhoneWindowLook: UIViewRepresentable {
    let look: PhoneLook

    func makeUIView(context: Context) -> Marker {
        let view = Marker()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: Marker, context: Context) { view.look = look }

    final class Marker: UIView {
        var look: PhoneLook = .device { didSet { apply() } }
        override func didMoveToWindow() { super.didMoveToWindow(); apply() }
        private func apply() {
            guard let window else { return }
            if window.overrideUserInterfaceStyle != look.style { window.overrideUserInterfaceStyle = look.style }
            // UIKit raises on reading an override that was never set, so ask whether it is there first.
            let overrides = window.traitOverrides, set = overrides.contains(PhoneColorThemeTrait.self)
            if let theme = look.colorTheme?.rawValue {
                if !set || overrides[PhoneColorThemeTrait.self] != theme { window.traitOverrides[PhoneColorThemeTrait.self] = theme }
            } else if set {
                window.traitOverrides.remove(PhoneColorThemeTrait.self)
            }
        }
    }
}
