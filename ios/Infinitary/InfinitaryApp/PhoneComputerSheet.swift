import InfinitaryKit
import SwiftUI

struct PhoneReach: View {
    let session: ReadOnlySession
    /// INF-589 item 17: on one line the time it was last heard follows the state.
    var oneLine = false
    var body: some View {
        (oneLine ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2)) : AnyLayout(VStackLayout(spacing: 2))) {
            HStack(spacing: PhoneTheme.space2) {
                Circle().fill(session.reach == "in-reach" ? PhoneTheme.accent : PhoneTheme.warning)
                    .frame(width: 6, height: 6).accessibilityHidden(true)
                Text(session.reachWords).accessibilityIdentifier("contact")
            }
            if let time = session.reachTime { Text(PhoneMessages.phoneReachSince(time: time)) }
        }.font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
    }
}

extension ReadOnlySession {
    /// The reach, in the words the reach line and the computer button share. INF-2668: they follow the patient
    /// `reach`, so a redial the computer answers within the captain's 20 s says nothing. INF-4207 piece 2: Live once
    /// every change is shown, and a catch-up says whether it replays what was missed or reads everything again.
    var reachWords: String {
        switch reach {
        case "in-reach": PhoneMessages.phoneReachLive()
        case "reaching": PhoneMessages.phoneReachReaching()
        case "catching-up":
            catchingUp == "replay" ? PhoneMessages.phoneReachCatchingUp() : PhoneMessages.phoneReachReadingAgain()
        default: PhoneMessages.phoneReachOutOfReach()
        }
    }

    /// Since when the computer is out of reach, naming the day when it was not today; reaching it again needs no time.
    var reachTime: String? {
        guard reach != "in-reach", reach != "reaching", reach != "catching-up", let heardAt else { return nil }
        return PhoneFormats.since(heardAt)
    }

    /// INF-1062: the computer button in the top bar says the reach to VoiceOver, with its time while out of reach.
    var reachLine: String {
        guard let reachTime else { return reachWords }
        return PhoneMessages.phoneReachLineSince(reach: reachWords, time: reachTime)
    }

    /// INF-589 item 11: the reach line says out of reach, so the one line where changes are made says only that
    /// they are off, in the Mac's words (`changesOffWords`, src/renderer/src/devices/viewWords.ts). None while first reaching,
    /// nor while the words still say In reach during a redial (INF-2668).
    var changesOffLine: String? {
        switch reach {
        case "in-reach": contact == "in-reach" ? changeRefusal : nil
        case "reaching": nil
        case "catching-up": contact == "in-reach" ? changeRefusal : nil
        default: PhoneMessages.phoneReachChangesOff(computer: mac.name)
        }
    }
}

/// INF-1062: the computer's own sheet, with its name, reach and address, then Leave or Forget under its own heading.
/// INF-1517, the captain's pick: it opens at half height on the system's glass with Settings' headings and spacing.
/// This device's own facts live in `PhoneSettingsSheet`.
struct PhoneComputerSheet: View {
    let session: ReadOnlySession
    let leave: () -> Void
    let forget: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var leaving = false
    @State private var forgetting = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space5) {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        Text(session.mac.name).font(PhoneFont.headline).accessibilityIdentifier("home-name")
                        Text(PhoneMessages.phoneComputerFirstMateHere()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                        PhoneReach(session: session)
                        if let address = session.reachedAddress {
                            Text(address).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                                .accessibilityIdentifier("reached-address")
                        }
                    }
                    exitControls
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .phoneTitle(PhoneMessages.phoneComputerTitle())
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-computer-details")
            } }
            // Alerts keep the cancel choice in view; a popover from the button would hide it.
            .alert(PhoneMessages.phoneComputerLeaveAsk(computer: session.mac.name), isPresented: $leaving) {
                Button(PhoneMessages.phoneComputerLeaveConfirm(), role: .destructive) { dismiss(); leave() }.accessibilityIdentifier("confirm-leave")
                Button(PhoneMessages.phoneComputerKeep(), role: .cancel) {}
            } message: { Text(PhoneMessages.phoneComputerLeaveWarning()) }
            .alert(PhoneMessages.phoneComputerForgetAsk(), isPresented: $forgetting) {
                Button(PhoneMessages.phoneComputerForgetConfirm(), role: .destructive) { dismiss(); forget() }.accessibilityIdentifier("confirm-forget")
                Button(PhoneMessages.phoneComputerKeep(), role: .cancel) {}
            } message: { Text(PhoneMessages.phoneComputerForgetWarning()) }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).phoneSheetSurface()
    }

    // Close the sheet on confirmation so any failure remains visible in the root's problem notice.
    // INF-1312: the sentence first, then one fitted button in the Mac's red outline at the trailing edge.
    // INF-1517: a section of its own, headed Leave, or Forget while the computer is out of reach.
    private var exitControls: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if session.contact == "in-reach" {
                Text(PhoneMessages.phoneComputerLeaveHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                Text(PhoneMessages.phoneComputerLeaveExplain())
                PhoneChoiceRow {
                    Button(PhoneMessages.phoneComputerLeaveButton(computer: session.mac.name)) { leaving = true }
                        .buttonStyle(PhoneChoiceStyle(.danger)).accessibilityIdentifier("leave")
                }
            } else {
                Text(PhoneMessages.phoneComputerForgetHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                Text(PhoneMessages.phoneComputerForgetExplain(computer: session.mac.name))
                PhoneChoiceRow {
                    Button(PhoneMessages.phoneComputerForgetButton()) { forgetting = true }
                        .buttonStyle(PhoneChoiceStyle(.danger)).accessibilityIdentifier("forget-mac")
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
    }
}
