import Testing
@testable import InfinitaryKit

/// INF-6295's piece B: a panel's `point.openSettings` opens the phone's Settings where the phone has the section, by the
/// desktop's section ids (src/shared/showActions.ts) and the items the Automation panel passes (src/panels/automation/panel.tsx).
struct PhoneSettingsPlaceTests {
    @Test func aRuleOpensItsOwnPageInAutomation() {
        #expect(PhoneSettingsPlace(section: "automation", item: "rule-7")?.detail == .rule("rule-7"))
        #expect(PhoneSettingsPlace(section: "automation", item: nil)?.detail == nil)
    }

    @Test func aKeptJobOpensAutomationSinceThePhoneListsNoKeptJobs() {
        let place = PhoneSettingsPlace(section: "automation", item: "kept:INF-12-backup")
        #expect(place?.section == .automation)
        #expect(place?.detail == nil)
    }

    @Test func theDesktopsIntelligenceIdOpensIntelligence() {
        #expect(PhoneSettingsPlace(section: "subscriptions", item: nil)?.section == .intelligence)
    }

    @Test func aSectionThePhoneDoesNotHaveOpensNothing() {
        for section in ["panels", "keyboard", "secrets", "observe", "intelligence", "my-plugin"] {
            #expect(PhoneSettingsPlace(section: section, item: nil) == nil, "\(section)")
        }
    }
}
