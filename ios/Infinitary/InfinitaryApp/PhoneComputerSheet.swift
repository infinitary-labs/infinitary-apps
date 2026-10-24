import InfinitaryKit
import SwiftUI

struct PhoneReach: View {
    let session: ReadOnlySession
    /// INF-589 item 17: on one line the time it was last heard follows the state.
    var oneLine = false
    var body: some View {
        (oneLine ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2)) : AnyLayout(VStackLayout(spacing: 2))) {
            HStack(spacing: PhoneTheme.space2) {
                Circle().fill(session.contact == "in-reach" ? PhoneTheme.accent : PhoneTheme.warning)
                    .frame(width: 6, height: 6).accessibilityHidden(true)
                Text(session.reachWords).accessibilityIdentifier("contact")
            }
            if let time = session.reachTime { Text("as of \(time)") }
        }.font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
    }
}

extension ReadOnlySession {
    /// The reach, in the words the reach line and the computer button share.
    var reachWords: String {
        switch contact {
        case "in-reach": "In reach"
        case "reaching": "Reaching your computer…"
        default: "Out of reach"
        }
    }

    /// When the computer was last heard, shown only while it is not in reach.
    var reachTime: String? {
        guard contact != "in-reach", let heardAt else { return nil }
        return heardAt.formatted(date: .omitted, time: .shortened)
    }

    /// INF-1062: the computer button in the top bar says the reach to VoiceOver, with its time while out of reach.
    var reachLine: String {
        guard let reachTime else { return reachWords }
        return "\(reachWords), as of \(reachTime)"
    }

    /// INF-589 item 11: the reach line says out of reach, so the one line where changes are made says only that
    /// they are off, in the Mac's words (`changesOffWords`, src/renderer/src/devices/viewWords.ts). None while first reaching.
    var changesOffLine: String? {
        switch contact {
        case "in-reach": changeRefusal
        case "reaching": nil
        default: "Changes are off until \(mac.name) is back."
        }
    }
}

/// INF-1062: the computer's own sheet, with its name, reach and address, and Leave or Forget at its foot.
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
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    Text(session.mac.name).font(PhoneFont.title).accessibilityIdentifier("home-name")
                    Text("Your first mate lives here.").foregroundStyle(PhoneTheme.secondary)
                    PhoneReach(session: session)
                    if let address = session.reachedAddress {
                        Text(address).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                            .accessibilityIdentifier("reached-address")
                    }
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .safeAreaInset(edge: .bottom) {
                exitControls.padding(PhoneTheme.space4).background(PhoneTheme.panel)
                    .overlay(alignment: .top) { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
            }
            .phoneTitle("Your computer")
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }.accessibilityIdentifier("close-computer-details")
            } }
            // Alerts keep the cancel choice in view; a popover from the foot would hide it.
            .alert("Leave \(session.mac.name)?", isPresented: $leaving) {
                Button("Leave this computer", role: .destructive) { dismiss(); leave() }.accessibilityIdentifier("confirm-leave")
                Button("Keep it", role: .cancel) {}
            } message: { Text("This device forgets the computer. To come back, use a new link.") }
            .alert("Forget this computer?", isPresented: $forgetting) {
                Button("Forget this computer", role: .destructive) { dismiss(); forget() }.accessibilityIdentifier("confirm-forget")
                Button("Keep it", role: .cancel) {}
            } message: { Text("You’ll need a new link to join again. Your computer may still list this device.") }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.large]).presentationDragIndicator(.visible).phoneSheetSurface()
    }

    // Close the sheet on confirmation so any failure remains visible in the root's problem notice.
    private var exitControls: some View {
        VStack(spacing: PhoneTheme.space3) {
            if session.contact == "in-reach" {
                Button(role: .destructive) { leaving = true } label: {
                    Text("Leave \(session.mac.name)").foregroundStyle(PhoneTheme.danger).frame(maxWidth: .infinity, minHeight: 44)
                }.accessibilityIdentifier("leave")
                Text("This device stops showing it. To come back, scan a new code.")
            } else {
                Button(role: .destructive) { forgetting = true } label: {
                    Text("Forget this computer").foregroundStyle(PhoneTheme.danger).frame(maxWidth: .infinity, minHeight: 44)
                }.accessibilityIdentifier("forget-mac")
                Text("Clears this computer from this device. \(session.mac.name) may still list it.")
            }
        }.buttonStyle(.bordered).tint(PhoneTheme.danger)
            .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
    }
}
