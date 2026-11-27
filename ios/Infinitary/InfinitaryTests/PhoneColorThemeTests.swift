import SwiftUI
import UIKit
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-6888's part 3, approved by the captain: the phone wears the computer's built-in color themes, each device its
/// own pick. These read the colors a pick draws through the same trait and environment the app's window carries.
@MainActor final class PhoneColorThemeTests: XCTestCase {
    /// Dracula's own background and accent, as its makers publish them.
    private static let draculaBackground = (40.0, 42.0, 54.0), draculaAccent = (189.0, 147.0, 249.0)
    /// Tokyo Night's own background, as its makers publish it: another dark theme, on Dracula's base.
    private static let tokyoNightBackground = (26.0, 27.0, 38.0)

    private func traits(_ style: UIUserInterfaceStyle, _ theme: PhoneColorTheme?) -> UITraitCollection {
        UITraitCollection { $0.userInterfaceStyle = style; $0[PhoneColorThemeTrait.self] = theme?.rawValue }
    }

    private func rgb(_ color: UIColor, _ traits: UITraitCollection) -> (Double, Double, Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r) * 255, Double(g) * 255, Double(b) * 255)
    }

    private func assertClose(_ got: (Double, Double, Double), _ want: (Double, Double, Double), _ message: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        for (g, w) in [(got.0, want.0), (got.1, want.1), (got.2, want.2)] {
            XCTAssertEqual(g, w, accuracy: 0.5, "\(message): \(got) against \(want)", file: file, line: line)
        }
    }

    /// The pick draws its maker's colors on its own base; a window drawn in the other base, such as the media viewer's
    /// light page under a dark theme, takes that base's own Light colors, as the computer's `shownTheme` does.
    func testAPickDrawsItsMakersColorsOnlyOnItsOwnBase() {
        let background = UIColor(PhoneTheme.background), accent = UIColor(PhoneTheme.accent)
        assertClose(rgb(background, traits(.dark, .dracula)), Self.draculaBackground, "Dracula's background")
        assertClose(rgb(accent, traits(.dark, .dracula)), Self.draculaAccent, "Dracula's accent")
        assertClose(rgb(background, traits(.light, .dracula)), rgb(background, traits(.light, nil)),
                    "Dracula on a light page draws Light")
        XCTAssertNil(PhoneColorTheme.shown("solarized", dark: true), "An id this build does not know draws Dark or Light")
    }

    /// The spec's 4.5:1 for words on accent-filled controls, worked out by WCAG 2's relative luminance.
    func testWordsOnTheAccentReachFourAndAHalfToOne() {
        func luminance(_ c: (Double, Double, Double)) -> Double {
            let channel = { (v: Double) -> Double in let s = v / 255; return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4) }
            return 0.2126 * channel(c.0) + 0.7152 * channel(c.1) + 0.0722 * channel(c.2)
        }
        let onAccent = UIColor(PhoneTheme.onAccent), accent = UIColor(PhoneTheme.accent)
        let looks: [(UIUserInterfaceStyle, PhoneColorTheme?)] = [(.dark, nil), (.light, nil)]
            + PhoneColorTheme.allCases.map { ($0.style, $0) }
        for (style, theme) in looks {
            let shown = traits(style, theme)
            let (a, b) = (luminance(rgb(onAccent, shown)), luminance(rgb(accent, shown)))
            XCTAssertGreaterThanOrEqual((max(a, b) + 0.05) / (min(a, b) + 0.05), 4.5, theme?.name ?? "\(style.rawValue)")
        }
    }

    /// The crew animation's colors follow the pick through the cache the scene draws with, including between two
    /// themes on one base, where the base alone would keep the first theme's colors (the spec's cache keyed on the theme).
    func testTheCrewPaletteFollowsThePick() {
        func environment(_ theme: PhoneColorTheme) -> EnvironmentValues {
            var values = EnvironmentValues()
            values.colorScheme = .dark
            values.phoneColorTheme = theme.rawValue
            return values
        }
        let cache = CharacterPainter.Cache()
        let dracula = cache.palette(environment(.dracula))
        assertClose((dracula.bg.r, dracula.bg.g, dracula.bg.b), Self.draculaBackground, "The crew draws on Dracula's background")
        let tokyo = cache.palette(environment(.tokyoNight))
        assertClose((tokyo.bg.r, tokyo.bg.g, tokyo.bg.b), Self.tokyoNightBackground, "The same cache redraws on Tokyo Night's background")
    }

    /// INF-7024: the old green terminal of INF-6888's own-theme fixtures, as the computer's `workedOwnThemes` sends it.
    private static let oldTerminal = try! JSONDecoder().decode(PhoneOwnTheme.self, from: Data(##"{"id":"own-old-terminal","name":"Old terminal","base":"dark","tokens":{"--bg-0":"#020a03","--material-tint":"rgba(2, 10, 3, 1)","--bg-1":"#031305","--bg-2":"#001c05","--bg-3":"#04250c","--line-1":"rgba(131, 202, 141, 0.2)","--line-2":"rgba(131, 202, 141, 0.24)","--fg-1":"#3ddc5a","--fg-2":"#209a39","--fg-3":"#1c7a2d","--accent":"#8dff9c","--accent-strong":"#00d37a","--accent-dim":"rgba(141, 255, 156, 0.14)","--accent-glow":"rgba(141, 255, 156, 0.35)","--ok":"#8dff9c","--ok-dim":"rgba(141, 255, 156, 0.14)","--hot":"#ffd23d","--hot-dim":"rgba(255, 210, 61, 0.14)","--hot-glow":"rgba(255, 210, 61, 0.35)","--warn":"#ffd23d","--warn-dim":"rgba(255, 210, 61, 0.14)","--danger":"#ff5a4d","--danger-dim":"rgba(255, 90, 77, 0.12)","--captain":"#5b9bff","--captain-dim":"rgba(91, 155, 255, 0.14)","--idle":"#596f5c","--slot-premium":"#ff5a4d","--slot-high":"#ffd23d","--slot-medium":"#8dff9c","--slot-low":"#869988","--wire-accent":"#8dff9c","--wire-hot":"#ffd23d","--wire-dim":"#1a7730","--on-accent":"#020a03"}}"##.utf8))

    /// An own theme the computer sent draws its own background and accent through the window's trait, and the same
    /// theme saved again with another accent is a new trait value, so every view resolves its colors again.
    func testAnOwnThemeDrawsTheComputersColorsAndRedrawsWhenSavedAgain() {
        PhoneOwnPalettes.keep([Self.oldTerminal])
        defer { PhoneOwnPalettes.keep([]) }
        let look = PhoneLook.own("own-old-terminal"), first = look.traitValue
        XCTAssertEqual(look.style, .dark, "The old terminal sits on Dark")
        let shown = UITraitCollection { $0.userInterfaceStyle = .dark; $0[PhoneColorThemeTrait.self] = first }
        assertClose(rgb(UIColor(PhoneTheme.background), shown), (2, 10, 3), "The old terminal's background")
        assertClose(rgb(UIColor(PhoneTheme.accent), shown), (141, 255, 156), "The old terminal's accent")

        var blue = Self.oldTerminal.tokens
        blue["--accent"] = "#7fd6ff"
        PhoneOwnPalettes.keep([PhoneOwnTheme(id: "own-old-terminal", name: "Old terminal", base: "dark", tokens: blue)])
        let again = look.traitValue
        XCTAssertNotEqual(again, first, "A theme saved again under its name is a new trait value")
        let redrawn = UITraitCollection { $0.userInterfaceStyle = .dark; $0[PhoneColorThemeTrait.self] = again }
        assertClose(rgb(UIColor(PhoneTheme.accent), redrawn), (127, 214, 255), "The new accent")
    }

    /// A pick the computer no longer lists goes back to its base, as the computer's own window keeps its base.
    func testARemovedOwnPickGoesBackToItsBase() {
        let appearance = PhoneAppearance(), was = appearance.look
        defer { appearance.look = was; appearance.heard([]) }
        appearance.heard([Self.oldTerminal])
        appearance.look = .own("own-old-terminal")
        XCTAssertEqual(appearance.looks.last, .own("own-old-terminal"), "Yours follows the built-in themes")
        appearance.heard([])
        XCTAssertEqual(appearance.look, .dark)
    }
}
