import InfinitaryKit
import SwiftUI
import UIKit

/// INF-1183: Join by its address. One field for the account and computer, such as kun@studio, and
/// an optional port, with the computers on this network under them (INF-1312); then, as the join needs them, the computer's fingerprint asked once, and the
/// password typed once or this phone's key to copy. The link the computer answers is never shown.
struct PhoneAddressSheet: View {
    @Bindable var model: PhoneModel
    let close: () -> Void
    @State private var address = ""
    @State private var port = ""
    @State private var account = ""
    @State private var password = ""
    @State private var copied = false
    @State private var nearby = NearbyComputers()
    @State private var askingSweep = false
    @Environment(\.scenePhase) private var phase

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                    if let join = model.addressJoin { step(join) } else { typing }
                }.padding(PhoneTheme.space5).frame(maxWidth: 468).frame(maxWidth: .infinity)
            }
            .phoneTitle(PhoneMessages.phoneJoinAddressTitle())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(PhoneMessages.phoneCommonCancel()) { model.cancelAddressJoin(); close() } } }
            // INF-1312: the list looks only while the person is typing an address with the app in front.
            .onChange(of: phase == .active && model.addressJoin == nil, initial: true) { _, typing in
                if typing { nearby.start() } else { nearby.stop() }
            }
            .onDisappear { nearby.stop() }
            .alert(PhoneMessages.phoneAddressSweepAsk(), isPresented: $askingSweep) {
                Button(PhoneMessages.phoneAddressSweepLook()) { nearby.sweepNetwork() }.accessibilityIdentifier("ssh-sweep-confirm")
                Button(PhoneMessages.phoneCommonCancel(), role: .cancel) {}
            } message: {
                Text(PhoneMessages.phoneAddressSweepWarning())
            }
        }.phoneSheetSurface()
    }

    private var typing: some View {
        Group {
            Text(PhoneMessages.phoneAddressTypingHelp())
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            // Return in either field continues, as Continue does.
            TextField("kun@studio", text: $address)
                .textFieldStyle(.phone).keyboardType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.go).onSubmit(submit)
                .accessibilityIdentifier("ssh-address")
            TextField(PhoneMessages.phoneAddressPortField(), text: $port)
                .textFieldStyle(.phone).keyboardType(.numberPad)
                .onSubmit(submit)
                .accessibilityIdentifier("ssh-port")
            onThisNetwork
            PhoneChoiceRow {
                Button(PhoneMessages.phoneCommonContinue(), action: submit).buttonStyle(PhoneChoiceStyle(.primary))
                    .disabled(address.isEmpty).accessibilityIdentifier("ssh-continue")
            }
        }
    }

    /// INF-1312, the captain's answers on INF-1312: the computers here with Remote Login on, under a field for the
    /// account so a tap fills the whole address, and a sweep of the other addresses only after a yes.
    private var onThisNetwork: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneAddressOnThisNetwork()).font(PhoneFont.micro).textCase(.uppercase).foregroundStyle(PhoneTheme.secondary)
                .accessibilityAddTraits(.isHeader)
            let computers = nearby.computers
            if computers.isEmpty {
                Text(lookingWords).font(PhoneFont.caption)
                    .foregroundStyle(nearby.looking == .notAllowed ? PhoneTheme.warning : PhoneTheme.secondary)
                    .accessibilityIdentifier("nearby-ssh-state")
            } else {
                TextField(PhoneMessages.phoneAddressAccountField(), text: $account)
                    .textFieldStyle(.phone)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("ssh-account")
                Text(PhoneMessages.phoneAddressAccountHelp())
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                PhoneList {
                    ForEach(computers) { computer in
                        Button { pick(computer) } label: {
                            PhoneRow(symbol: .computer, title: computer.name,
                                     line: computer.swept ? PhoneMessages.phoneAddressSweptLine() : computer.host,
                                     lineFont: computer.swept ? PhoneFont.caption : PhoneFont.data)
                        }.accessibilityIdentifier("nearby-ssh-" + computer.id)
                    }
                }.buttonStyle(PhoneRowStyle()).disabled(account.isEmpty)
            }
            switch nearby.sweep {
            case .idle:
                Button(PhoneMessages.phoneAddressSweepOffer()) { askingSweep = true }
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.accent).buttonStyle(.borderless).frame(minHeight: 44)
                    .accessibilityIdentifier("ssh-sweep")
            case .sweeping(let addresses):
                HStack(spacing: PhoneTheme.space2) {
                    ProgressView()
                    Text(PhoneMessages.phoneAddressSweeping(count: addresses)).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                }.frame(minHeight: 44).accessibilityIdentifier("ssh-sweeping")
            case .done:
                if !nearby.computers.contains(where: \.swept) {
                    Text(PhoneMessages.phoneAddressSweptNone())
                        .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("ssh-swept")
                }
            case .noNetwork:
                Text(PhoneMessages.phoneAddressNoNetwork())
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("ssh-swept")
            }
        }
    }

    /// The Mac's own list's words (`nearbyMacsWords`, src/shared/nearbyMacs.ts), with the phone's Settings.
    private var lookingWords: String {
        switch nearby.looking {
        case .looking: PhoneMessages.phoneAddressLooking()
        case .notAllowed: PhoneMessages.phoneAddressLookingNotAllowed()
        case .failed: PhoneMessages.phoneAddressLookingFailed()
        }
    }

    private func pick(_ computer: NearbyComputer) {
        address = "\(account.trimmingCharacters(in: .whitespaces))@\(computer.host)"
        port = computer.port == 22 ? "" : String(computer.port)
    }

    private func submit() { if !address.isEmpty { model.joinByAddress(address, port: port) } }

    // INF-1312: each step says what it has to say, then its reason, then its buttons in one row, the default last.
    @ViewBuilder private func step(_ join: AddressJoin) -> some View {
        let host = join.address.host
        switch join.step {
        case .working:
            ProgressView(PhoneMessages.phoneAddressSigningIn(computer: host)).frame(maxWidth: .infinity).accessibilityIdentifier("ssh-working")
        case .trust(let key):
            Text(PhoneMessages.phoneAddressTrustAsk(computer: host)).font(PhoneFont.headline)
            Text(PhoneMessages.phoneAddressTrustLine(computer: host))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            Text(key.fingerprint).font(PhoneFont.data).textSelection(.enabled)
                .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading).phoneInput()
                .accessibilityIdentifier("ssh-fingerprint")
            Text(PhoneMessages.phoneAddressTrustWarning())
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            problem(join)
            PhoneChoiceRow {
                Button(PhoneMessages.phoneAddressNotThisOne()) { model.cancelAddressJoin(); close() }
                    .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("ssh-not-this-one")
                Button(PhoneMessages.phoneAddressTrustNamed(computer: host)) { model.trustHome() }
                    .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("ssh-trust")
            }
        case .keyRefused(let takesPassword):
            if takesPassword {
                Text(PhoneMessages.phoneAddressKeyRefusedPassword(computer: host))
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                SecureField(PhoneMessages.phoneAddressPasswordField(computer: host), text: $password)
                    .textFieldStyle(.phone).textContentType(.password)
                    .accessibilityIdentifier("ssh-password")
                Text(PhoneMessages.phoneAddressCopyKeyInstead())
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            } else {
                Text(PhoneMessages.phoneAddressKeyRefused(computer: host))
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            }
            if let line = model.sshKeyLine {
                // The key box carries its copy mark at its edge.
                HStack(alignment: .top, spacing: PhoneTheme.space2) {
                    Text(line).font(PhoneFont.micro).textSelection(.enabled).lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("ssh-public-key")
                    Button { UIPasteboard.general.string = line; copied = true } label: {
                        PhoneSymbol.copy.image.frame(minWidth: 44, minHeight: 44)
                    }.buttonStyle(.borderless)
                        .accessibilityLabel(copied ? PhoneMessages.phoneCommonCopied() : PhoneMessages.phoneAddressCopyKey()).accessibilityIdentifier("ssh-copy-key")
                }.padding(.leading, PhoneTheme.space3).padding(.top, PhoneTheme.space3).padding(.bottom, 2).phoneInput()
            }
            problem(join)
            PhoneChoiceRow {
                Button(PhoneMessages.phoneCommonTryAgain()) { model.tryAddressAgain() }
                    .buttonStyle(PhoneChoiceStyle(takesPassword ? .secondary : .primary)).accessibilityIdentifier("ssh-try-again")
                if takesPassword {
                    Button(PhoneMessages.phoneAddressSignInOnce()) { let typed = password; password = ""; model.sendPassword(typed) }
                        .buttonStyle(PhoneChoiceStyle(.primary)).disabled(password.isEmpty)
                        .accessibilityIdentifier("ssh-send-password")
                }
            }
        case .stopped:
            problem(join)
            PhoneChoiceRow {
                Button(PhoneMessages.phoneCommonTryAgain()) { model.tryAddressAgain() }
                    .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("ssh-try-again")
            }
        }
    }

    @ViewBuilder private func problem(_ join: AddressJoin) -> some View {
        if let problem = join.problem {
            Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                .accessibilityIdentifier("ssh-problem")
        }
    }
}
