import Foundation

/// Where a panel's `point.openSettings` opens the phone's Settings (docs/ios.md, "Panels"): a section the phone's Settings
/// has, by the desktop's section id, and the page under it the item names, where the phone has that page. A section the
/// phone has no page for opens nothing, as the desktop opens nothing for a section its window does not offer; an item the
/// phone has no page for is ignored and the section opens, as a desktop section ignores an item it does not know
/// (`PanelPoint.openSettings` in src/shared/personal/contracts.ts).
public struct PhoneSettingsPlace: Equatable, Sendable {
    /// The phone's Settings sections, by the raw value the sheet's own sections carry.
    public enum Section: String, Sendable { case general, appearance, projects, intelligence, runbooks, usage, automation, integrations, devices }
    public enum Detail: Equatable, Sendable { case rule(String), project(String) }

    public let section: Section
    public let detail: Detail?

    /// The desktop's id for each section the phone has (`SETTINGS_SECTION_NAMES` in src/shared/showActions.ts): every
    /// one is the phone's own name but Intelligence, which the desktop registers as `subscriptions`.
    private static let sections: [String: Section] = [
        "general": .general, "appearance": .appearance, "projects": .projects, "subscriptions": .intelligence,
        "runbooks": .runbooks, "usage": .usage, "automation": .automation, "integrations": .integrations, "devices": .devices,
    ]

    /// The item that names a kept job in Automation (`KEPT_ITEM_PREFIX` in src/shared/keptJobs.ts); the phone lists no kept jobs.
    private static let keptPrefix = "kept:"

    public init?(section: String, item: String?) {
        guard let known = Self.sections[section] else { return nil }
        self.section = known
        switch (known, item) {
        case (.automation, let id?) where !id.hasPrefix(Self.keptPrefix): detail = .rule(id)
        case (.projects, let id?): detail = .project(id)
        default: detail = nil
        }
    }
}
