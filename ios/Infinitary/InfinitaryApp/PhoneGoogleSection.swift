import InfinitaryKit
import SafariServices
import SwiftUI
import UniformTypeIdentifiers

/// INF-3454's phone part, the captain's choices where=settings ("A Google row in the phone's Settings, showing who is
/// signed in, with Sign in and Sign out") and how=catch ("Catch it in the app, with pasting the address as the
/// fallback, like the computers"); docs/ios.md, "Google in Settings". The sign-in and Google's keys stay on the
/// computer: this row shows its notice and page, and passes the browser's return back. INF-6342, the captain's choice
/// setup-on-phone ("Bring the client file setup to the phone itself"): the row shows the computer's client states, and
/// its setup opens Google's page and hands the client file it makes to the computer, which keeps its secret.
struct PhoneGoogleSection: View {
    let session: ReadOnlySession
    @Bindable var google: PhoneGoogle
    @State private var address = ""
    @State private var confirmingSignOut = false

    private var mac: String { session.mac.name }
    /// The setup and Google's notice share one sheet, so a kept file swaps one for the other.
    private var sheet: Binding<PhoneGoogleSheet?> {
        Binding(get: {
            switch google.stage {
            case .setup: .setup
            case .notice: .notice
            default: nil
            }
        }, set: { if $0 == nil { google.declineSetup(); google.declineNotice() } })
    }
    private var pageUp: Binding<Bool> {
        Binding(get: { google.showing != nil }, set: { if !$0 { google.showing = nil } })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneGoogleWords.name).font(PhoneFont.headline)
            switch google.stage {
            case .waiting(let page, let caught): waiting(page: page, caught: caught)
            case .idle, .notice, .setup: standing
            }
            if let problem = google.problem {
                Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                    .accessibilityIdentifier("google-problem")
            }
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("google-section")
        .sheet(item: sheet) { shown in
            switch shown {
            case .setup: PhoneGoogleSetup(google: google, computer: mac)
            case .notice: PhoneGoogleNotice(google: google)
            }
        }
        .sheet(isPresented: pageUp) {
            if let url = google.showing { PhoneSignInPageView(url: url).ignoresSafeArea() }
        }
    }

    @ViewBuilder private var standing: some View {
        if let row = google.row {
            Text(row.account.map { PhoneMessages.phoneGoogleSignedInAs(account: $0, computer: mac) } ?? PhoneMessages.phoneGoogleSignedIn(computer: mac))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                .accessibilityIdentifier("google-account")
            if let state = google.clientState {
                Text(state.words).font(PhoneFont.callout)
                    .foregroundStyle(state.tone == .danger ? PhoneTheme.danger : PhoneTheme.warning)
                    .accessibilityIdentifier("google-client-state")
                Text(state.detail).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("google-client-detail")
            } else if row.health == "needs_reauth" {
                Text(PhoneMessages.phoneGoogleSignInAgainNeeded()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
            }
            PhoneChoiceRow {
                if let state = google.clientState {
                    Button(state.nextWords) {
                        address = ""
                        if state.next == .signIn { google.begin() } else { google.beginSetup() }
                    }
                    .buttonStyle(PhoneChoiceStyle(.primary))
                    .disabled(google.busy || !session.canChange || !google.homeTakesReturn)
                    .accessibilityIdentifier("google-client-next")
                } else if row.health == "needs_reauth" { signIn(PhoneMessages.phoneGoogleSignInAgain()) }
                Button(PhoneMessages.phoneGoogleSignOut()) { confirmingSignOut = true }
                    .buttonStyle(PhoneChoiceStyle(.secondary))
                    .disabled(google.busy || !session.canChange)
                    .accessibilityIdentifier("google-sign-out")
            }
            .confirmationDialog(PhoneMessages.phoneGoogleSignOutAsk(computer: mac), isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button(PhoneMessages.phoneGoogleSignOut(), role: .destructive) { Task { await google.signOut() } }
                    .accessibilityIdentifier("google-sign-out-confirm")
            } message: {
                Text(PhoneMessages.phoneGoogleSignOutWarning())
            }
        } else {
            Text(PhoneMessages.phoneGoogleInvite(computer: mac))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            if google.homeTakesReturn {
                PhoneChoiceRow {
                    if google.needsSetup {
                        Button(PhoneMessages.integrationsGoogleSetUp()) { address = ""; google.begin() }
                            .buttonStyle(PhoneChoiceStyle(.primary))
                            .disabled(google.busy || !session.canChange)
                            .accessibilityIdentifier("google-set-up")
                    } else {
                        signIn(PhoneMessages.phoneGoogleSignIn())
                    }
                }
            } else {
                Text(PhoneGoogleWords.updateThere(mac)).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("google-update-there")
            }
        }
    }

    private func signIn(_ words: String) -> some View {
        Button(words) { address = ""; google.begin() }
            .buttonStyle(PhoneChoiceStyle(.primary))
            .disabled(google.busy || !session.canChange || !google.homeTakesReturn)
            .accessibilityIdentifier("google-sign-in")
    }

    @ViewBuilder private func waiting(page: PhoneSignInPage?, caught: Bool) -> some View {
        Text(PhoneGoogleWords.waiting).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            .accessibilityIdentifier("google-waiting")
        PhoneChoiceRow {
            Button(PhoneGoogleWords.again) { google.openAgain() }
                .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(page == nil)
                .accessibilityIdentifier("google-open-again")
            Button(PhoneGoogleWords.stop) { Task { await google.cancel() } }
                .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(google.busy)
                .accessibilityIdentifier("google-cancel")
        }
        if page != nil, !caught {
            Text(PhoneGoogleWords.pasteLead).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            TextField(PhoneGoogleWords.pastePlaceholder, text: $address)
                .textFieldStyle(.phone).keyboardType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.send).onSubmit(send)
                .accessibilityLabel(PhoneGoogleWords.pasteLabel)
                .accessibilityIdentifier("google-paste")
            if let refused = google.refused {
                Text(refused).font(PhoneFont.callout).foregroundStyle(PhoneTheme.danger)
                    .accessibilityIdentifier("google-paste-refused")
            }
            PhoneChoiceRow {
                Button(PhoneGoogleWords.send(mac), action: send)
                    .buttonStyle(PhoneChoiceStyle(.primary))
                    .disabled(google.busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("google-paste-send")
            }
        }
    }

    private func send() { Task { await google.paste(address) } }
}

private enum PhoneGoogleSheet: Identifiable {
    case setup, notice
    var id: Self { self }
}

/// The setup of the person's own Google client, in the computer's Settings words: Google's page opens in the browser,
/// where the person makes a Desktop app client, and the file Google gives for it is chosen or pasted here. The file
/// goes to the computer whole, which keeps its secret in Secrets; the field clears either way.
private struct PhoneGoogleSetup: View {
    let google: PhoneGoogle
    let computer: String
    @Environment(\.openURL) private var openURL
    @State private var file = ""
    @State private var chosen: String?
    @State private var choosing = false
    @State private var unread: String?

    private var refused: Bool { google.client?.refused != nil }
    private var filled: Bool { !file.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                    if refused {
                        Text(PhoneMessages.integrationsGoogleStoppedDetail()).font(PhoneFont.callout)
                            .foregroundStyle(PhoneTheme.danger).accessibilityIdentifier("google-setup-refused")
                    }
                    Text(PhoneMessages.integrationsGoogleSetupLead()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    step(1, PhoneMessages.integrationsGoogleSetupStepPage())
                    PhoneChoiceRow {
                        Button(PhoneMessages.integrationsGoogleSetupOpenPage()) {
                            if let url = URL(string: PhoneGoogleWords.setupPage) { openURL(url) }
                        }
                        .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("google-setup-page")
                    }
                    step(2, PhoneMessages.phoneGoogleSetupStepFile())
                    SecureField(PhoneMessages.integrationsGoogleSetupField(), text: $file)
                        .textFieldStyle(.phone).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: file) { if chosen != nil, $1.isEmpty { chosen = nil } }
                        .accessibilityLabel(PhoneMessages.integrationsGoogleSetupField())
                        .accessibilityIdentifier("google-setup-file")
                    PhoneChoiceRow {
                        Button(PhoneMessages.integrationsGoogleSetupChoose()) { choosing = true }
                            .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(google.busy)
                            .accessibilityIdentifier("google-setup-choose")
                    }
                    if let chosen {
                        Text(PhoneMessages.integrationsGoogleSetupChosen(name: chosen)).font(PhoneFont.callout)
                            .foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("google-setup-chosen")
                    }
                    if let problem = unread ?? google.setupProblem {
                        Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.danger)
                            .accessibilityIdentifier("google-setup-problem")
                    }
                    Text(PhoneMessages.phoneGoogleSetupStays(computer: computer)).font(PhoneFont.callout)
                        .foregroundStyle(PhoneTheme.secondary)
                    PhoneChoiceRow {
                        Button(google.busy ? PhoneMessages.integrationsGoogleSetupKeeping() : PhoneMessages.integrationsGoogleSetupKeep()) {
                            let text = file
                            file = ""; chosen = nil; unread = nil
                            Task { await google.keepClient(text) }
                        }
                        .buttonStyle(PhoneChoiceStyle(.primary)).disabled(!filled || google.busy)
                        .accessibilityIdentifier("google-setup-keep")
                        Button(PhoneMessages.integrationsSignInCancel()) { google.declineSetup() }
                            .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("google-setup-cancel")
                    }
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .phoneTitle(PhoneMessages.integrationsGoogleSetupTitle())
        }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.json]) { take($0) }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDragIndicator(.visible).phoneSheetSurface()
    }

    private func step(_ number: Int, _ words: String) -> some View {
        (Text("\(number). ").bold() + Text(words)).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
    }

    /// Google's client file is a few hundred bytes; a larger file is not one, and is never read.
    private func take(_ result: Result<URL, Error>) {
        unread = nil
        guard case .success(let url) = result else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= PhoneGoogleWords.clientFileBytes, let text = try? String(contentsOf: url, encoding: .utf8) else {
            unread = PhoneMessages.integrationsGoogleClientFileNotJson()
            return
        }
        file = text
        chosen = url.lastPathComponent
    }
}

/// Google's notice, word for word as the computer's Settings shows it; nothing is asked of the computer until Accept.
private struct PhoneGoogleNotice: View {
    let google: PhoneGoogle

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                    Text(PhoneGoogleWords.noticeLead).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    ForEach(PhoneGoogleWords.noticeGroups, id: \.heading) { group in
                        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                            Text(group.heading).font(PhoneFont.headline)
                            ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
                                (item.name.map { Text("\($0). ").bold() } ?? Text("")) + Text(item.text)
                            }
                            .font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
                        }
                    }
                    Text(PhoneGoogleWords.noticeClosing).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    PhoneChoiceRow {
                        Button(PhoneGoogleWords.accept) { google.accept() }
                            .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("google-accept")
                        Button(PhoneGoogleWords.cancel) { google.declineNotice() }
                            .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("google-notice-cancel")
                    }
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .phoneTitle(PhoneGoogleWords.noticeTitle)
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDragIndicator(.visible).phoneSheetSurface()
    }
}

/// Google's page in a browser inside the app, so the app stays open to catch the return. Google refuses its sign-in in
/// an app's own web view, so this is the system's browser view.
private struct PhoneSignInPageView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
