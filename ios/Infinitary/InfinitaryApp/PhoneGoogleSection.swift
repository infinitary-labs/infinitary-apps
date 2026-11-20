import InfinitaryKit
import SafariServices
import SwiftUI

/// INF-3454's phone part, the captain's choices where=settings ("A Google row in the phone's Settings, showing who is
/// signed in, with Sign in and Sign out") and how=catch ("Catch it in the app, with pasting the address as the
/// fallback, like the computers"); docs/ios.md, "Google in Settings". The sign-in and Google's keys stay on the
/// computer: this row shows its notice and page, and passes the browser's return back.
struct PhoneGoogleSection: View {
    let session: ReadOnlySession
    @Bindable var google: PhoneGoogle
    @State private var address = ""
    @State private var confirmingSignOut = false

    private var mac: String { session.mac.name }
    private var noticeUp: Binding<Bool> {
        Binding(get: { google.stage == .notice }, set: { if !$0 { google.declineNotice() } })
    }
    private var pageUp: Binding<Bool> {
        Binding(get: { google.showing != nil }, set: { if !$0 { google.showing = nil } })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneGoogleWords.name).font(PhoneFont.headline)
            switch google.stage {
            case .waiting(let page, let caught): waiting(page: page, caught: caught)
            case .idle, .notice: standing
            }
            if let problem = google.problem {
                Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                    .accessibilityIdentifier("google-problem")
            }
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("google-section")
        .sheet(isPresented: noticeUp) { PhoneGoogleNotice(google: google) }
        .sheet(isPresented: pageUp) {
            if let url = google.showing { PhoneSignInPageView(url: url).ignoresSafeArea() }
        }
    }

    @ViewBuilder private var standing: some View {
        if let row = google.row {
            Text(row.account.map { PhoneMessages.phoneGoogleSignedInAs(account: $0, computer: mac) } ?? PhoneMessages.phoneGoogleSignedIn(computer: mac))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                .accessibilityIdentifier("google-account")
            if row.health == "needs_reauth" {
                Text(PhoneMessages.phoneGoogleSignInAgainNeeded()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
            }
            PhoneChoiceRow {
                if row.health == "needs_reauth" { signIn(PhoneMessages.phoneGoogleSignInAgain()) }
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
                PhoneChoiceRow { signIn(PhoneMessages.phoneGoogleSignIn()) }
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
