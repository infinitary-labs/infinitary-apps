import InfinitaryKit
import SwiftUI

/// The accepted phone Settings plan: the desktop's section names and order, each opening in this same sheet.
/// Leave and Forget stay with the computer in its sheet; Theme and approvals keep their existing owners.
/// INF-3563: Projects, Intelligence, Runbooks, Usage and Automation are the computer's own pages in the computer's
/// words (docs/ios.md, "Settings pages in the computer's words"); signing in stays on the computer.
struct PhoneSettingsSheet: View {
    let session: ReadOnlySession
    @Environment(\.dismiss) private var dismiss
    @Environment(PhoneSecrets.self) private var secrets: PhoneSecrets?
    @Environment(PhoneAppearance.self) private var appearance: PhoneAppearance?
    @Environment(PhoneGoogle.self) private var google: PhoneGoogle?
    @Environment(PhoneSettings.self) private var settings: PhoneSettings?
    @Environment(PhonePushes.self) private var pushes: PhonePushes?
    @FocusState private var themeFocused: Bool
    @FocusState private var languageFocused: Bool
    @FocusState private var foldFocused: Bool
    @Environment(\.openURL) private var openURL
    @State private var section: Section?
    /// The pages opened inside a section, outermost first: an automation, its review, a project.
    @State private var path: [Detail] = []
    @State private var lastSection: Section = .general
    @State private var browsing = false
    /// The page last read for, so a page reads at once as it opens and a burst of changes reads once.
    @State private var followed: Place?

    private enum Section: String, CaseIterable {
        case general, appearance, projects, intelligence, runbooks, usage, automation, integrations, devices
        var id: String { rawValue }

        /// The section's name: the phone's own word for its four sections, and for each of the computer's pages the
        /// computer's own name for that Settings tab.
        var title: String {
            switch self {
            case .general: PhoneMessages.phoneSettingsGeneral()
            case .appearance: PhoneMessages.phoneSettingsAppearance()
            case .projects: PhoneMessages.panelSettingsProjects()
            case .intelligence: PhoneMessages.panelSettingsIntelligence()
            case .runbooks: PhoneMessages.panelSettingsRunbooks()
            case .usage: PhoneMessages.panelSettingsUsage()
            case .automation: PhoneMessages.panelSettingsAutomation()
            case .integrations: PhoneMessages.phoneSettingsIntegrations()
            case .devices: PhoneMessages.phoneSettingsDevices()
            }
        }

        /// The computer's page behind the section, where it has one.
        var live: PhoneSettings.Section? {
            switch self {
            case .projects: .projects
            case .intelligence: .intelligence
            case .runbooks: .runbooks
            case .usage: .usage
            case .automation: .automation
            case .general, .appearance, .integrations, .devices: nil
            }
        }

        /// How often the computer's own page reads again with nothing said: its accounts and its automations.
        var readsEvery: Duration? {
            switch self {
            case .intelligence: .seconds(10)
            case .automation: .seconds(30)
            default: nil
            }
        }
    }

    private enum Detail: Hashable { case rule(String), review(String), project(String) }

    private struct Place: Hashable {
        let section: Section?
        let detail: Detail?
    }

    /// What the open page reads again on: where it is, the computer coming into reach, and what the computer said changed.
    private struct Watch: Hashable {
        let place: Place
        let contact: String
        let settings: Int
        let work: Int
    }

    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? PhoneMessages.phoneSettingsThisIpad() : PhoneMessages.phoneSettingsThisPhone() }
    /// The same device inside a sentence: lowercasing the heading would read "this ipad".
    private var thisDevice: String { UIDevice.current.userInterfaceIdiom == .pad ? PhoneMessages.phoneSettingsThisIpadInline() : PhoneMessages.phoneSettingsThisPhoneInline() }
    /// The name this device offers with its approval key, the same one it joined with.
    private var label: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    /// The version the person would read back to someone, as the app was built: the marketing version and its build.
    static var version: String { PhoneAppVersion.current ?? "0 (0)" }

    var body: some View {
        NavigationStack {
            // One navigation content owner keeps exactly one close button on every page, with no inherited toolbar items.
            ZStack { content }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .phoneTitle(title)
                .toolbar {
                    ToolbarItem(placement: closePlacement) { closeButton }
                    if section != nil {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { back() } label: { backLook }
                            .keyboardShortcut("[", modifiers: .command)
                            .accessibilityLabel(backLabel)
                            .accessibilityIdentifier("phone-settings-back")
                        }
                    }
                }
        }
        // INF-3454: Integrations shows once the computer answered its connections; one that cannot hides it.
        .task(id: session.contact) { await google?.refresh() }
        .task(id: watch) { await follow() }
        // A page the computer stopped answering leaves the list, and the sheet with it.
        .onChange(of: shown) { _, shown in
            if let section, !shown.contains(section) { path = []; settings?.closeRule(); self.section = nil }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        // Nine sections do not fit half a screen: Settings opens at full height, with no half stop on the way down.
        .presentationDragIndicator(.visible).phoneSheetSurface()
    }

    @ViewBuilder private var content: some View {
        if let section {
            if section.live == nil {
                page { own(section) }
            } else if let settings {
                live(section, settings)
            }
        } else {
            // The list is longer than half a screen: the ring a key moves brings its row into view.
            ScrollViewReader { proxy in
                page { sections }
                    .onChange(of: lastSection) { _, section in
                        if browsing { withAnimation(.easeOut(duration: PhoneTheme.fadeSeconds)) { proxy.scrollTo(section) } }
                    }
            }
        }
    }

    /// The sections this phone draws itself.
    @ViewBuilder private func own(_ section: Section) -> some View {
        switch section {
        case .general:
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                Text("Infinitary").font(PhoneFont.headline)
                Text(PhoneMessages.phoneSettingsVersion(version: Self.version)).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                    .accessibilityIdentifier("app-version")
                // INF-4012's direction 1: Infinitary on the computer, its version and update, where it answers them.
                if session.homeUpdates { PhoneHomeUpdateControls(session: session, row: true).padding(.top, PhoneTheme.space3) }
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
                if let pushes { PhonePushSection(session: session, pushes: pushes).padding(.top, PhoneTheme.space3) }
            }
        case .projects, .intelligence, .runbooks, .usage, .automation:
            EmptyView()
        }
    }

    /// The computer's own pages, each drawn from what its row rules answered.
    @ViewBuilder private func live(_ section: Section, _ settings: PhoneSettings) -> some View {
        switch section {
        case .intelligence:
            if let page = settings.intelligence { PhoneIntelligenceView(page: page, back: back) }
        case .usage:
            if let page = settings.usage { PhoneUsageView(page: page, settings: settings, back: back) }
        case .runbooks:
            if let page = settings.runbooks { PhoneRunbooksView(page: page, settings: settings, back: back) }
        case .projects:
            if case .project(let id) = detail, let project = settings.projects?.projects.first(where: { $0.id == id }) {
                PhoneProjectView(project: project, settings: settings, back: back)
            } else if let page = settings.projects {
                PhoneProjectsView(page: page, open: { open(.project($0)) }, back: back)
            }
        case .automation:
            if case .review = detail, let rule = settings.rule, let review = rule.review {
                PhoneRuleReviewView(page: rule, review: review, settings: settings, back: back)
            } else if case .rule = detail, let rule = settings.rule {
                PhoneRuleView(page: rule, settings: settings, review: { open(.review(rule.id), over: true) }, back: back)
            } else if let page = settings.automation {
                PhoneAutomationView(page: page, settings: settings, open: { open(.rule($0)) }, review: { open(.review($0)) }, back: back)
            }
        case .general, .appearance, .integrations, .devices:
            EmptyView()
        }
    }

    /// The page under the top bar: the deepest opened one the computer's answers still hold, so a rule deleted or a
    /// project removed on the computer falls back to its list.
    private var detail: Detail? {
        path.last { detail in
            switch detail {
            case .rule(let id): settings?.rule?.id == id
            case .review(let id): settings?.rule?.id == id && settings?.rule?.review != nil
            case .project(let id): settings?.projects?.projects.contains(where: { $0.id == id }) == true
            }
        }
    }

    /// Settings saves each choice as it is made, so on iOS 26 the sheet closes with the system's X circle, matching
    /// Apple's own sheets; iOS 18 keeps the word Done.
    @ViewBuilder private var closeButton: some View {
        if #available(iOS 26, *) {
            // The X takes the text colour, as Back's chevron does, rather than the accent.
            Button(role: .close) { dismiss() }.tint(PhoneTheme.text).accessibilityIdentifier("close-phone-settings")
        } else {
            Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-phone-settings")
        }
    }

    /// Where the close button sits. On iOS 26 a confirmation slot fills its button with the tint, which would draw
    /// the X as a solid circle beside Back's clear one; the plain trailing slot keeps the two circles alike.
    private var closePlacement: ToolbarItemPlacement {
        if #available(iOS 26, *) { return .topBarTrailing }
        return .confirmationAction
    }

    /// Back as the bar draws it: on iOS 26 the chevron alone, a circle matching the close button, still speaking where
    /// it goes; on iOS 18 the chevron and that place's name.
    @ViewBuilder private var backLook: some View {
        if #available(iOS 26, *) {
            PhoneSymbol.rowChevron.rotationEffect(.degrees(180))
        } else {
            HStack(spacing: PhoneTheme.space2) {
                PhoneSymbol.rowChevron.rotationEffect(.degrees(180))
                // The page's own title keeps the room: a long parent name, or a long word in another language, cuts off first.
                CappedWidth(most: 88) { Text(parent ?? PhoneMessages.shellTopBarBack()).lineLimit(1) }
            }
        }
    }

    /// The top bar names Settings or the section. A page under a section leads with its own name instead, where a
    /// long one wraps; between Back and the close button the bar would cut it short.
    private var title: String {
        guard let section else { return PhoneMessages.phoneCommonSettings() }
        return detail == nil ? section.title : ""
    }

    /// Where Back goes, as the top bar names it: Settings or the section. From a page under a page it names
    /// nothing, and the bar reads plain Back.
    private var parent: String? {
        guard let section else { return PhoneMessages.phoneCommonSettings() }
        guard let detail, let index = path.lastIndex(of: detail) else {
            return PhoneMessages.phoneCommonSettings()
        }
        return index == 0 ? section.title : nil
    }

    /// Back's spoken name: where it goes, or plain Back from a page under a page.
    private var backLabel: String {
        guard detail != nil else { return PhoneMessages.phoneSettingsBack() }
        return parent.map { PhoneMessages.phoneSettingsBackTo(place: $0) } ?? PhoneMessages.shellTopBarBack()
    }

    /// One page back: out of the page under the top bar, or out of the section.
    private func back() {
        settings?.problem = nil
        if let detail, let index = path.lastIndex(of: detail) {
            path.removeSubrange(index...)
        } else if !path.isEmpty {
            path = []
        } else {
            section = nil
        }
        if !path.contains(where: { if case .project = $0 { false } else { true } }) { settings?.closeRule() }
    }

    private func open(_ detail: Detail, over: Bool = false) {
        settings?.problem = nil
        switch detail {
        case .rule(let id), .review(let id): if !over { settings?.openRule(id) }
        case .project: break
        }
        path = over ? path + [detail] : [detail]
    }

    private var watch: Watch {
        Watch(place: Place(section: section, detail: path.last), contact: session.contact,
              settings: session.settingsRevision, work: section == .usage ? session.workRevision : 0)
    }

    /// Reads what the page under the top bar shows: at once as it opens, once after a burst of changes settles, and
    /// again as often as the computer's own page does. The list reads every page, for its one-line summaries.
    private func follow() async {
        guard let settings else { return }
        let place = watch.place
        if followed == place {
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
        }
        followed = place
        guard let section else { await settings.refresh(); return }
        guard let live = section.live else { return }
        await settings.refresh(live)
        while let wait = section.readsEvery {
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }
            await settings.refresh(live)
        }
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
                .accessibilityIdentifier("phone-settings-\(section.id)").id(section)
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

    /// Sections with nothing to show stay off the list: Integrations waits for the computer's connections, and each
    /// of the computer's own pages for the computer's answer. Those five arrive together, once each has been asked
    /// for, so the list changes under a finger once and not five times.
    private var shown: [Section] {
        Section.allCases.filter { section in
            switch section {
            case .integrations: google?.read == true
            case .projects: settings?.read == true && settings?.projects != nil
            case .intelligence: settings?.read == true && settings?.intelligence != nil
            case .runbooks: settings?.read == true && settings?.runbooks != nil
            case .usage: settings?.read == true && settings?.usage != nil
            case .automation: settings?.read == true && settings?.automation != nil
            case .general, .appearance, .devices: true
            }
        }
    }

    private func summary(_ section: Section) -> String {
        switch section {
        case .general: PhoneMessages.phoneSettingsVersion(version: Self.version)
        case .appearance: PhoneMessages.phoneSettingsThemeSummary(theme: appearance?.look.words ?? PhoneLook.device.words)
        case .projects: settings?.projects?.summary ?? ""
        case .intelligence: settings?.intelligence?.summary ?? ""
        case .runbooks: settings?.runbooks?.summary ?? ""
        case .usage: settings?.usage?.summary ?? ""
        case .automation: settings?.automation?.summary ?? ""
        case .integrations: PhoneMessages.phoneSettingsGoogleSummary(account: google?.row.map { $0.account ?? PhoneMessages.phoneSettingsGoogleSignedIn() } ?? PhoneMessages.phoneSettingsGoogleSignedOut())
        case .devices: device
        }
    }

    private func open(_ section: Section) {
        lastSection = section
        path = []
        settings?.problem = nil
        self.section = section
    }

    private func moveSection(by offset: Int) {
        let sections = shown
        let index = sections.firstIndex(of: lastSection) ?? 0
        if sections.indices.contains(index + offset) { lastSection = sections[index + offset] }
    }

    private func page<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space5, content: content)
                .padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
        }
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
            .onKeyPress(.downArrow) { languageFocused = true; return .handled }
            .onAppear { themeFocused = true }
            textSize
            language
            if appearance.foldSeen { foldSplit(appearance) }
        }
    }

    /// The captain's Approve and build (INF-4713): Infinitary, cards and panels included, follows the device's own Text
    /// Size, so Appearance names where it is set rather than offering a size of its own (docs/ios.md, "Text size").
    private var textSize: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneSettingsTextSize()).font(PhoneFont.headline)
            Text(PhoneMessages.phoneSettingsTextSizeScope(device: label))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("phone-text-size")
        }
        .padding(.top, PhoneTheme.space3)
    }

    /// The captain, on an iPhone Duo open like a book: "is there a way for the user to not split the view, but instead
    /// see what an ipad would see?" Split at the fold is this device's own switch (`PhoneFoldSplit`), on by default and
    /// shown once the device has shown a fold. Tab, or the down arrow from Language, reaches it; Return or Space turns it,
    /// and the up arrow goes back to Language.
    private func foldSplit(_ appearance: PhoneAppearance) -> some View {
        @Bindable var appearance = appearance
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            HStack(spacing: PhoneTheme.space3) {
                Text(PhoneMessages.phoneSettingsFoldSplit()).font(PhoneFont.headline)
                Spacer(minLength: 0)
                Toggle(PhoneMessages.phoneSettingsFoldSplit(), isOn: $appearance.splitAtFold)
                    .labelsHidden().tint(PhoneTheme.accent)
                    .focusable().focused($foldFocused)
                    .onKeyPress(.return) { appearance.splitAtFold.toggle(); return .handled }
                    .onKeyPress(.space) { appearance.splitAtFold.toggle(); return .handled }
                    .onKeyPress(.upArrow) { languageFocused = true; return .handled }
                    .overlay { if foldFocused { Capsule().strokeBorder(PhoneTheme.accent, lineWidth: 1.5).padding(-3) } }
                    .accessibilityIdentifier("phone-fold-split")
            }
            .padding(.top, PhoneTheme.space3)
            Text(PhoneMessages.phoneSettingsFoldSplitScope())
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The captain's Approve and build (the phone's languages, piece 4): the phone speaks its own language, which iOS
    /// sets on Infinitary's page in its Settings, so the row names it and opens that page, as Theme is this device's own.
    /// Tab, or the down arrow from Theme, reaches it; Return or Space opens it, and the up arrow goes back to Theme.
    private var language: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.settingsLanguage()).font(PhoneFont.headline).padding(.top, PhoneTheme.space3)
            Text(PhoneMessages.phoneSettingsLanguageScope(computer: session.mac.name, device: label))
                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("phone-language-scope")
            PhoneList {
                Button(action: openLanguage) {
                    PhoneRow(title: PhoneFormats.languageName, line: PhoneMessages.phoneSettingsLanguageOpen(), chevron: true)
                }
                .buttonStyle(PhoneRowStyle())
                .focusable().focused($languageFocused)
                .onKeyPress(.return) { openLanguage(); return .handled }
                .onKeyPress(.space) { openLanguage(); return .handled }
                .onKeyPress(.upArrow) { themeFocused = true; return .handled }
                .onKeyPress(.downArrow) {
                    guard appearance?.foldSeen == true else { return .ignored }
                    foldFocused = true; return .handled
                }
                .accessibilityIdentifier("phone-language")
            }
            .overlay { if languageFocused { RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous).strokeBorder(PhoneTheme.accent, lineWidth: 1.5) } }
        }
    }

    private func openLanguage() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
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

/// Offers its one view at most `most` points across, so a toolbar item, which offers any width, still cuts a long word off.
private struct CappedWidth: Layout {
    let most: CGFloat

    private func offer(_ proposal: ProposedViewSize) -> ProposedViewSize {
        ProposedViewSize(width: min(proposal.width ?? most, most), height: proposal.height)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(offer(proposal)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: offer(proposal))
    }
}
