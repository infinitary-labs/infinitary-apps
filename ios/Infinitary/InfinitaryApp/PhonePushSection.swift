import InfinitaryKit
import SwiftUI

/// INF-4794: Notifications under Devices, saying whether this phone gets a notification for each card while
/// Infinitary is closed, with iOS's own Settings as the one switch (docs/ios.md, "Card pushes").
struct PhonePushSection: View {
    let session: ReadOnlySession
    let pushes: PhonePushes
    @Environment(\.openURL) private var openURL

    private var mac: String { session.mac.name }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneSettingsNotifications()).font(PhoneFont.headline)
            Text(line).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                .accessibilityIdentifier("push-state")
            if session.homeTakesPushes {
                PhoneChoiceRow {
                    if pushes.permission == .notAsked {
                        Button(PhoneMessages.phonePushTurnOn()) { Task { await pushes.turnOn() } }
                            .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("push-settings-turn-on")
                    } else {
                        Button(PhoneMessages.phoneSettingsNotificationsOpen()) {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }.buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("push-open-settings")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("push-section")
    }

    private var line: String {
        guard session.homeTakesPushes else { return PhoneMessages.phoneSettingsNotificationsUpdate(computer: mac) }
        switch pushes.permission {
        case .on: return PhoneMessages.phoneSettingsNotificationsOn(computer: mac, device: phoneDeviceName)
        case .off: return PhoneMessages.phoneSettingsNotificationsOff(computer: mac, device: phoneDeviceName)
        case .notAsked, nil: return PhoneMessages.phoneSettingsNotificationsNotAsked(computer: mac)
        }
    }
}
