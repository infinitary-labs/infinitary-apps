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

    /// The crew animation's colors follow the pick, including between two themes on one base.
    func testTheCrewPaletteFollowsThePick() {
        let dracula = CharacterPainter.Palette(.dark, theme: .dracula)
        XCTAssertEqual(dracula.theme, .dracula)
        assertClose((dracula.bg.r, dracula.bg.g, dracula.bg.b), Self.draculaBackground, "The crew draws on Dracula's background")
        let tokyo = CharacterPainter.Palette(.dark, theme: .tokyoNight)
        XCTAssertNotEqual(tokyo.bg.r, dracula.bg.r, "Tokyo Night on the same base resolves its own background")
    }
}
