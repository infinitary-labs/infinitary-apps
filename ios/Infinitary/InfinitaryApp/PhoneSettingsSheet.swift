import InfinitaryKit
import SwiftUI

/// The accepted phone Settings plan: the desktop's section names and order, each opening in this same sheet.
/// Leave and Forget stay with the computer in its sheet; Theme and approvals keep their existing owners.
struct PhoneSettingsSheet: View {
    let session: ReadOnlySession
    @Environment(\.dismiss) private var dismiss
    @Environment(PhoneSecrets.self) private var secrets: PhoneSecrets?
    @Environment(PhoneAppearance.self) private var appearance: PhoneAppearance?
    @Environment(PhoneGoogle.self) private var google: PhoneGoogle?
    @FocusState private var themeFocused: Bool
    @State private var section: Section?
    @State private var lastSection: Section = .general
    @State private var browsing = false

    private enum Section: String, CaseIterable {
        // i18n-exempt: raw values name each section's accessibility identifier; `title` is shown
        case general = "General", appearance = "Appearance", integrations = "Integrations", devices = "Devices"
        var id: String { rawValue.lowercased() }
        var title: String {
            switch self {
            case .general: PhoneMessages.phoneSettingsGeneral()
            case .appearance: PhoneMessages.phoneSettingsAppearance()
            case .integrations: PhoneMessages.phoneSettingsIntegrations()
            case .devices: PhoneMessages.phoneSettingsDevices()
            }
        }
    }

    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? PhoneMessages.phoneSettingsThisIpad() : PhoneMessages.phoneSettingsThisPhone() }
    /// The same device inside a sentence: lowercasing the heading would read "this ipad".
    private var thisDevice: String { UIDevice.current.userInterfaceIdiom == .pad ? PhoneMessages.phoneSettingsThisIpadInline() : PhoneMessages.phoneSettingsThisPhoneInline() }
    /// The name this device offers with its approval key, the same one it joined with.
    private var label: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    /// The version the person would read back to someone, as the app was built: the marketing version and its build.
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    var body: some View {
        NavigationStack {
            page(section?.title ?? PhoneMessages.phoneCommonSettings()) {
                if let section {
                    switch section {
                    case .general:
                        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                            Text("Infinitary").font(PhoneFont.headline)
                            Text(PhoneMessages.phoneSettingsVersion(version: Self.version)).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                                .accessibilityIdentifier("app-version")
                        }
                    case .appearance:
                        if let appearance { theme(appearance) }
                    case .integrations:
                        // INF-3454's phone part: Google's row, under Integrations as on the computer.
                        if let google { PhoneGoogleSection(session: session, google: google) }
                    case .devices:
                        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                            Text(device).font(PhoneFont.headline)
                            Text(capability).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                            Text(PhoneMessages.phoneSettingsConversationStays()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                            if let secrets, secrets.standing != .unavailable { approvals(secrets) }
                        }
                    }
                } else {
                    sections
                }
            }
            // One navigation content owner keeps exactly one Done on every page, with no inherited toolbar items.
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-phone-settings")
                }
                if section != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { section = nil } label: {
                            HStack(spacing: PhoneTheme.space2) {
                                PhoneSymbol.chevron.image.rotationEffect(.degrees(180))
                                Text(PhoneMessages.phoneCommonSettings())
                            }
                        }
                        .keyboardShortcut("[", modifiers: .command)
                        .accessibilityLabel(PhoneMessages.phoneSettingsBack())
                        .accessibilityIdentifier("phone-settings-back")
                    }
                }
            }
        }
        // INF-3454: Integrations shows once the computer answered its connections; one that cannot hides it.
        .task(id: session.contact) { await google?.refresh() }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).phoneSheetSurface()
    }

    private var sections: some View {
        PhoneList {
            ForEach(shown, id: \.self) { section in
                Button { open(section) } label: {
                    PhoneRow(title: section.title, line: summary(section), chevron: true)
                }
                .buttonStyle(PhoneRowStyle())
                .overlay {
                    if browsing, section == lastSection {
                        RoundedRectangle(cornerRadius: PhoneTheme.controlRadius)
                            .strokeBorder(PhoneTheme.accent, lineWidth: 1.5)
                    }
                }
                .accessibilityIdentifier("phone-settings-\(section.id)")
            }
        }
        // The list reuses the scene's native keyboard owner, so a card behind the sheet never keeps its keys.
        .background(PhoneBrowsingKeys(active: section == nil, returnOpens: true) { key in
            browsing = true
            switch key {
            case .up: moveSection(by: -1)
            case .down, .next: moveSection(by: 1)
            case .open: open(lastSection)
            case .stop: dismiss()
            case .left, .right: break
            }
        })
    }

    private var capability: String {
        session.contact == "in-reach" && session.access != "full"
            ? PhoneMessages.phoneSettingsCapabilityRead(update: PhoneUpdate.side(phone: PhoneContract.version, computer: session.homeVersion).words)
            : PhoneMessages.phoneSettingsCapabilityFull()
    }

    /// Sections with nothing to show stay off the list: Integrations waits for the computer's connections.
    private var shown: [Section] {
        Section.allCases.filter { $0 != .integrations || google?.read == true }
    }

    private func summary(_ section: Section) -> String {
        switch section {
        case .general: PhoneMessages.phoneSettingsVersion(version: Self.version)
        case .appearance: PhoneMessages.phoneSettingsThemeSummary(theme: appearance?.look.words ?? PhoneLook.device.words)
        case .integrations: PhoneMessages.phoneSettingsGoogleSummary(account: google?.row.map { $0.account ?? PhoneMessages.phoneSettingsGoogleSignedIn() } ?? PhoneMessages.phoneSettingsGoogleSignedOut())
        case .devices: device
        }
    }

    private func open(_ section: Section) {
        lastSection = section
        self.section = section
    }

    private func moveSection(by offset: Int) {
        let sections = shown
        let index = sections.firstIndex(of: lastSection) ?? 0
        if sections.indices.contains(index + offset) { lastSection = sections[index + offset] }
    }

    private func page<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space5, content: content)
                .padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
        }
        .phoneTitle(title)
    }

    /// The captain's Approve and build: this device's own Theme, in Apple's segmented control like the computer's Dark
    /// and Light pills, worded Device, Dark and Light. The computer's Theme is never read or changed.
    private func theme(_ appearance: PhoneAppearance) -> some View {
        @Bindable var appearance = appearance
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneSettingsTheme()).font(PhoneFont.headline)
            Text(PhoneMessages.phoneSettingsThemeScope(computer: session.mac.name, device: label))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("phone-theme-scope")
            Picker(PhoneMessages.phoneSettingsTheme(), selection: $appearance.look) {
                ForEach(PhoneLook.allCases, id: \.self) { look in Text(look.words).tag(look) }
            }
            .pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("phone-theme")
            // A segmented control takes no keys of its own, and an unseen shortcut under a sheet never hears an unmodified
            // arrow. So the control holds focus while Appearance is open and its arrows move the choice, with no command.
            .focusable().focused($themeFocused)
            .onKeyPress(.leftArrow) { appearance.step(by: -1); return .handled }
            .onKeyPress(.rightArrow) { appearance.step(by: 1); return .handled }
            .onAppear { themeFocused = true }
        }
    }

    /// INF-1109's phone approvals (docs/secrets.md, "Remote decisions"): only while the computer offers Secrets.
    /// INF-1690 piece 4: one switch, Approves secret uses, the same one Settings → Devices shows beside this phone on
    /// the computer. Turning it on offers this phone's key, and the computer's code comparison stays the one
    /// confirmation. Turning it off is the computer's, which confirms that too, so here it says where.
    private func approvals(_ secrets: PhoneSecrets) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneSettingsSecretsApprovals()).font(PhoneFont.headline)
            if secrets.standing == .damaged {
                // INF-1109: a record this phone reads but cannot decode. Only this choice replaces it, under a new
                // device name, so the computer confirms the new key like a first one and keeps any earlier one.
                // Short enough that the button stays in view at the sheet's medium height on an iPad.
                Text(PhoneMessages.phoneSettingsApprovalDamaged(computer: session.mac.name, device: device))
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("approval-damaged")
                setUp(secrets, PhoneMessages.phoneSettingsSetUpAgain(), again: true)
                Text(PhoneMessages.phoneSettingsApprovalEarlierListed(computer: session.mac.name, device: thisDevice))
                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            } else {
                approvalSwitch(secrets)
                switch secrets.standing {
                case .offered:
                    Text(PhoneMessages.phoneSettingsApprovalConfirmOn(computer: session.mac.name))
                        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    Text(secrets.key?.code ?? "").font(PhoneFont.title.monospacedDigit()).foregroundStyle(PhoneTheme.text)
                        .accessibilityLabel(PhoneMessages.phoneSettingsApprovalCode(code: secrets.key?.code ?? "")).accessibilityIdentifier("approval-code")
                    Text(PhoneMessages.phoneSettingsApprovalCodesDiffer()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                case .enrolled:
                    Text(PhoneMessages.phoneSettingsApprovalEnrolled(confirmation: ApprovalKey.confirmation, device: device))
                        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("approval-enrolled")
                    Text(PhoneMessages.phoneSettingsApprovalCode(code: secrets.key?.code ?? "")).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                    Text(PhoneMessages.phoneSettingsApprovalTurnOff(computer: session.mac.name)).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                case .replaced:
                    Text(PhoneMessages.phoneSettingsApprovalReplaced(computer: session.mac.name, device: thisDevice))
                        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                case .none, .unavailable, .damaged:
                    Text(PhoneMessages.phoneSettingsApprovalOffer(computer: session.mac.name, confirmation: ApprovalKey.confirmation, device: thisDevice))
                        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                }
            }
            if let problem = secrets.problem {
                Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("approval-problem")
            }
        }
    }

    /// On while this phone approves or waits for the computer's confirmation; only turning it on acts here.
    private func approvalSwitch(_ secrets: PhoneSecrets) -> some View {
        let on = secrets.standing == .enrolled || secrets.standing == .offered
        return HStack(spacing: PhoneTheme.space3) {
            Text(PhoneMessages.phoneSettingsApprovesSecretUses()).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
            Spacer(minLength: 0)
            Toggle(PhoneMessages.phoneSettingsApprovesSecretUses(), isOn: Binding(get: { on }, set: { turnedOn in
                if turnedOn, !on { Task { await secrets.setUp(label: label) } }
            }))
            .labelsHidden().tint(PhoneTheme.accent)
            .disabled(on || secrets.busy || !session.canChange)
            .accessibilityIdentifier("approval-switch")
        }
    }

    private func setUp(_ secrets: PhoneSecrets, _ words: String, again: Bool = false) -> some View {
        Button(words) { Task { if again { await secrets.setUpAgain(label: label) } else { await secrets.setUp(label: label) } } }
            .buttonStyle(PhoneChoiceStyle(.primary))
            .disabled(secrets.busy || !session.canChange)
            .accessibilityIdentifier("approval-set-up")
    }
}
