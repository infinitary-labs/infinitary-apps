import InfinitaryKit
import SwiftUI
import UIKit

/// The captain's Approve and build on a theme of the phone's own (`PhoneLook`): the one owner of this device's choice.
/// A change is saved at once, so it survives a relaunch and an update, and it is never sent to the computer.
@MainActor @Observable final class PhoneAppearance {
    var look: PhoneLook { didSet { look.save() } }
    /// The person's own themes as each kept computer last sent them, by its pin (`PhoneOwnThemes`); this is their one
    /// writer.
    private var ownLists: [String: [PhoneOwnTheme]]
    /// The pin of the computer heard last, whose own themes Yours lists first.
    private var heardFrom: String?
    /// Every kept computer's own themes together, as Yours lists them.
    private(set) var ownThemes: [PhoneOwnTheme]
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
        let lists = PhoneOwnThemes.saved(), together = PhoneOwnThemes.together(lists)
        PhoneOwnPalettes.keep(together)
        ownLists = lists
        ownThemes = together
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

    /// The computer with `pin` sent its own themes again. Another kept computer's list stays, so a pick from it survives
    /// showing this one; a pick no kept computer lists any longer goes back to its base, as the computer's own window
    /// does when the theme it wears is removed.
    func heard(_ themes: [PhoneOwnTheme], from pin: String) {
        heardFrom = pin
        var lists = ownLists
        lists[pin] = themes
        keep(lists)
    }

    /// The kept computers changed: a forgotten one's own themes leave Yours with it.
    func kept(_ pins: Set<String>) {
        keep(ownLists.filter { pins.contains($0.key) })
    }

    private func keep(_ lists: [String: [PhoneOwnTheme]]) {
        let together = PhoneOwnThemes.together(lists, first: heardFrom)
        if lists != ownLists { ownLists = lists; PhoneOwnThemes.save(lists) }
        guard together != ownThemes else { return }
        let base = look.style
        PhoneOwnPalettes.keep(together)
        ownThemes = together
        if case .own(let id) = look, !together.contains(where: { $0.id == id }) { look = base == .light ? .light : base == .dark ? .dark : .device }
    }

    /// Every choice in the order Settings lists them: Device, Dark, Light, the built-in themes, then Yours.
    var looks: [PhoneLook] { PhoneLook.allCases + ownThemes.map { .own($0.id) } }

    /// The next choice to the left (-1) or right (1) of the current one, kept at the ends, as a segmented control's
    /// arrows move.
    func step(by offset: Int) {
        let looks = looks
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
        case .own(let id): PhoneOwnPalettes.entry(id: id).map { $0.theme.isDark ? .dark : .light } ?? .unspecified
        }
    }

    /// What the window's theme trait carries: a built-in theme's id, an own theme's key, or nothing.
    var traitValue: String? {
        switch self {
        case .device, .dark, .light: nil
        case .theme(let theme): theme.rawValue
        case .own(let id): PhoneOwnPalettes.entry(id: id)?.key
        }
    }
}

/// Sets the style and the color theme of the window it sits in. Sheets, the keyboard, card web views and the crew all
/// read their appearance from that window, so one setting changes every screen at once. Each window of an iPad's several
/// windows carries its own copy, so a new window starts in the chosen theme too. SwiftUI's own views read the theme
/// through the trait's bridged environment value (`PhoneColorThemeTrait`).
struct PhoneWindowLook: UIViewRepresentable {
    let look: PhoneLook
    /// The own themes kept, so a theme saved again under its name reaches the window as its new key.
    let ownThemes: [PhoneOwnTheme]

    func makeUIView(context: Context) -> Marker {
        let view = Marker()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: Marker, context: Context) { view.drawn = Marker.Drawn(style: look.style, theme: look.traitValue) }

    final class Marker: UIView {
        struct Drawn: Equatable { var style: UIUserInterfaceStyle = .unspecified, theme: String? }
        var drawn = Drawn() { didSet { if drawn != oldValue { apply() } } }
        override func didMoveToWindow() { super.didMoveToWindow(); apply() }
        private func apply() {
            guard let window else { return }
            if window.overrideUserInterfaceStyle != drawn.style { window.overrideUserInterfaceStyle = drawn.style }
            // UIKit raises on reading an override that was never set, so ask whether it is there first.
            let overrides = window.traitOverrides, set = overrides.contains(PhoneColorThemeTrait.self)
            if let theme = drawn.theme {
                if !set || overrides[PhoneColorThemeTrait.self] != theme { window.traitOverrides[PhoneColorThemeTrait.self] = theme }
            } else if set {
                window.traitOverrides.remove(PhoneColorThemeTrait.self)
            }
        }
    }
}
