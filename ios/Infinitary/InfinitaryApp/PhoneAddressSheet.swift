import InfinitaryKit
import SwiftUI
import UIKit

/// INF-1183: Join by its address. One field for the account and computer, such as kun@studio, and
/// an optional port; then, as the join needs them, the computer's fingerprint asked once, and the
/// password typed once or this phone's key to copy. The link the computer answers is never shown.
struct PhoneAddressSheet: View {
    @Bindable var model: PhoneModel
    let close: () -> Void
    @State private var address = ""
    @State private var port = ""
    @State private var password = ""
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                    if let join = model.addressJoin { step(join) } else { typing }
                }.padding(PhoneTheme.space5).frame(maxWidth: 468).frame(maxWidth: .infinity)
            }
            .phoneTitle("Join by its address")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.cancelAddressJoin(); close() } } }
        }.phoneSheetSurface()
    }

    private var typing: some View {
        Group {
            Text("Type your account and your computer, as you would sign in to it. Remote Login must be on in your Mac’s Sharing settings, or SSH on Linux.")
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            // Return in either field continues, as Continue does.
            TextField("kun@studio", text: $address)
                .textFieldStyle(.phone).keyboardType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.go).onSubmit(submit)
                .accessibilityIdentifier("ssh-address")
            TextField("Port (22)", text: $port)
                .textFieldStyle(.phone).keyboardType(.numberPad)
                .onSubmit(submit)
                .accessibilityIdentifier("ssh-port")
            prominent("Continue", enabled: !address.isEmpty, id: "ssh-continue", action: submit)
        }
    }

    private func submit() { if !address.isEmpty { model.joinByAddress(address, port: port) } }

    @ViewBuilder private func step(_ join: AddressJoin) -> some View {
        let host = join.address.host
        switch join.step {
        case .working:
            ProgressView("Signing in to \(host)…").frame(maxWidth: .infinity).accessibilityIdentifier("ssh-working")
        case .trust(let key):
            Text("Is this \(host)?").font(PhoneFont.headline)
            Text("This phone has not signed in to \(host) before. Its fingerprint is:")
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            Text(key.fingerprint).font(PhoneFont.data).textSelection(.enabled)
                .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading).phoneInput()
                .accessibilityIdentifier("ssh-fingerprint")
            Text("Only continue on your own network or with your own computer. This phone asks once, and stops if the fingerprint ever changes.")
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            prominent("Trust \(host)", enabled: true, id: "ssh-trust") { model.trustHome() }
            plain("Not this one", id: "ssh-not-this-one") { model.cancelAddressJoin(); close() }
        case .keyRefused(let takesPassword):
            if takesPassword {
                Text("\(host) has not let this phone’s key in yet. Type your password there once, and Infinitary lets the key in. It keeps none of the password.")
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                SecureField("Your password on \(host)", text: $password)
                    .textFieldStyle(.phone).textContentType(.password)
                    .accessibilityIdentifier("ssh-password")
                prominent("Sign in once", enabled: !password.isEmpty, id: "ssh-send-password") {
                    let typed = password; password = ""; model.sendPassword(typed)
                }
                Text("Or copy this phone’s key to your account there, then try again.")
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            } else {
                Text("\(host) did not let this phone’s key in, and it takes no password. Add this key to your account’s authorized keys there, then try again.")
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            }
            if let line = model.sshKeyLine {
                Text(line).font(PhoneFont.micro).textSelection(.enabled).lineLimit(4)
                    .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading).phoneInput()
                    .accessibilityIdentifier("ssh-public-key")
                plain(copied ? "Copied" : "Copy this phone’s key", id: "ssh-copy-key") {
                    UIPasteboard.general.string = line; copied = true
                }
            }
            plain("Try again", id: "ssh-try-again") { model.tryAddressAgain() }
        case .stopped:
            plain("Try again", id: "ssh-try-again") { model.tryAddressAgain() }
        }
        if let problem = join.problem {
            Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                .accessibilityIdentifier("ssh-problem")
        }
    }

    private func prominent(_ label: String, enabled: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).foregroundStyle(enabled ? PhoneTheme.onAccent : PhoneTheme.muted).frame(maxWidth: .infinity, minHeight: 44)
        }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!enabled).accessibilityIdentifier(id)
    }

    private func plain(_ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle()) }
            .buttonStyle(.borderless).controlSize(.large).accessibilityIdentifier(id)
    }
}
