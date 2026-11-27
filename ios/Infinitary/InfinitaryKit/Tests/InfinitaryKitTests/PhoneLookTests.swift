import Foundation
import Testing
@testable import InfinitaryKit

/// The captain's Approve and build on the phone's own theme: Device, Dark, Light or a built-in color theme, saved on the
/// device and starting on Device, so nobody's app looks different after the update.
struct PhoneLookTests {
    /// A defaults domain of this test's own, removed after it, so the app's real choice is never read or changed.
    private func scratch() -> (UserDefaults, String) {
        let name = "phone-look-tests-\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }

    @Test func startsOnMatchingTheDevice() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(PhoneLook.saved(in: defaults) == .device)
    }

    @Test func keepsEachChoiceAcrossReads() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        for look in PhoneLook.allCases {
            look.save(in: defaults)
            // A fresh reader of the same domain stands in for the next launch.
            #expect(PhoneLook.saved(in: UserDefaults(suiteName: name)!) == look)
        }
    }

    @Test func readsAnUnknownChoiceAsTheDevice() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("sepia", forKey: PhoneLook.key)
        #expect(PhoneLook.saved(in: defaults) == .device)
    }

    @Test func wordsAreTheCaptainsShortOnes() {
        #expect(PhoneLook.allCases.prefix(3).map(\.words) == ["Device", "Dark", "Light"])
    }

    /// INF-6888's part 3: the phone offers the built-in themes the computer shipped, under the makers' names the captain
    /// chose, in the computer's order.
    @Test func offersTheBuiltInThemesUnderTheirMakersNames() {
        #expect(PhoneLook.allCases.dropFirst(3).map(\.words) == [
            "Rosé Pine", "Rosé Pine Moon", "Rosé Pine Dawn", "Catppuccin Latte", "Catppuccin Frappé",
            "Catppuccin Macchiato", "Catppuccin Mocha", "One Dark", "One Light", "Dracula", "Night Owl",
            "Night Owl Light", "Tokyo Night",
        ])
    }

    /// The pick is kept under the existing phone-theme key by the id the computer's theme line uses.
    @Test func keepsABuiltInThemeUnderTheComputersId() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        PhoneLook.theme(.dracula).save(in: defaults)
        #expect(defaults.string(forKey: PhoneLook.key) == "dracula")
        defaults.set("tokyo-night", forKey: PhoneLook.key)
        #expect(PhoneLook.saved(in: defaults) == .theme(.tokyoNight))
    }

    /// Yours on the phone (INF-6888's part 3): a pick of the person's own theme is kept by the computer's `own-` id, and
    /// the last list the computer sent survives the next launch whole. Fixture: the plan trial's old green terminal, as
    /// the computer's own-themes read answers it, cut to three of its tokens.
    @Test func keepsAnOwnThemePickAndTheLastListAcrossLaunches() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        PhoneLook.own("own-old-terminal").save(in: defaults)
        #expect(defaults.string(forKey: PhoneLook.key) == "own-old-terminal")
        #expect(PhoneLook.saved(in: UserDefaults(suiteName: name)!) == .own("own-old-terminal"))
        #expect(PhoneOwnThemes.saved(in: defaults).isEmpty)
        let answer = Data(##"{"themes":[{"id":"own-old-terminal","name":"Old terminal","base":"dark","tokens":{"--bg-0":"#020a03","--accent":"#8dff9c","--line-1":"rgba(131, 202, 141, 0.2)"}}]}"##.utf8)
        let themes = (try? JSONDecoder().decode(PhoneOwnThemes.Answer.self, from: answer).themes) ?? []
        PhoneOwnThemes.save(themes, in: defaults)
        #expect(PhoneOwnThemes.saved(in: UserDefaults(suiteName: name)!) == [PhoneOwnTheme(
            id: "own-old-terminal", name: "Old terminal", base: "dark",
            tokens: ["--bg-0": "#020a03", "--accent": "#8dff9c", "--line-1": "rgba(131, 202, 141, 0.2)"])])
    }
}
