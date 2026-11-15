import InfinitaryKit
import SwiftUI

@main struct InfinitaryApp: App {
    @State private var model = PhoneModel()
    @State private var appearance = PhoneAppearance()
    @Environment(\.scenePhase) private var phase

    init() {
        #if targetEnvironment(simulator)
        // The rest part's Secrets journey asks the disposable simulator for a damaged approval record at launch.
        let environment = ProcessInfo.processInfo.environment
        if environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1", environment["INFINITARY_DAMAGED_APPROVAL"] == "1" {
            ApprovalKey.damageForPhoneCheck()
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            PhoneView(model: model)
                // This device's own Theme (PhoneAppearance), set on the window so every sheet and the keyboard follow it.
                .background(PhoneWindowLook(look: appearance.look))
                .environment(appearance)
                .font(PhoneFont.body)
                .tint(PhoneTheme.accent)
                .foregroundStyle(PhoneTheme.text)
                .onChange(of: phase, initial: true) { _, phase in
                    if phase == .active { model.active(true) }
                    else if phase == .background { model.active(false) }
                }
                .onOpenURL { model.propose($0.absoluteString) }
        }
        .commands {
            CommandGroup(after: .textEditing) {
                Button(PhoneMessages.phoneAppHideKeyboard(), action: dismissPhoneKeyboard).keyboardShortcut("k", modifiers: [.command, .shift])
            }
        }
    }
}

@MainActor func dismissPhoneKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

struct PhoneView: View {
    @Bindable var model: PhoneModel
    @State private var scanning = false
    @State private var pasting = false
    @State private var addressing = false
    @State private var linkText = ""
    @State private var details = false
    @State private var settings = false
    @State private var keyboardVisible = false

    var body: some View {
        NavigationStack {
            Group {
                if model.removed {
                    // INF-589 item 11: Removed takes the first screen's shape, with one Join again, fitted and centered (INF-1312).
                    firstScreen(PhoneMessages.phoneJoinRemovedTitle(),
                        PhoneMessages.phoneJoinRemovedLine()) {
                        Button(PhoneMessages.phoneJoinAgain()) { model.dismissRemoved() }
                            .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("join-again")
                    }
                } else if let session = model.connection {
                    connected(session)
                } else {
                    joinScreen
                }
            }
            .background(PhoneTheme.background)
            .navigationTitle("Infinitary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // INF-1062, the captain's one-row bar: Settings at the left, the strip in the middle (PhoneWorkspace),
                // the computer at the right. While the keyboard is open, Done takes Settings' place.
                // INF-1517: the one-icon buttons take the system's own 44-point circle, with no wider frame of ours.
                if keyboardVisible {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(PhoneMessages.phoneCommonDone(), action: dismissPhoneKeyboard)
                            .frame(minWidth: 44, minHeight: 44)
                            .keyboardShortcut("k", modifiers: [.command, .shift])
                            .accessibilityIdentifier("dismiss-phone-keyboard")
                    }
                } else if model.connection != nil, !model.removed {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { settings = true } label: { PhoneSymbol.settings.image }
                            .accessibilityLabel(PhoneMessages.phoneCommonSettings()).accessibilityIdentifier("phone-settings")
                            .keyboardShortcut(",", modifiers: .command)
                    }
                }
                if model.connection == nil || model.removed {
                    ToolbarItem(placement: .principal) { Text("Infinitary").font(PhoneFont.headline).accessibilityAddTraits(.isHeader) }
                }
                if let session = model.connection, !model.removed {
                    ToolbarItem(placement: .topBarTrailing) {
                        // The computer's name lives in its sheet, and VoiceOver hears the reach as words.
                        // INF-1328: a dot asks for attention, so it shows only while the computer is out of reach.
                        Button { details = true } label: {
                            PhoneSymbol.computer.image
                                .overlay(alignment: .topTrailing) {
                                    if session.reach == "lost" {
                                        Circle().fill(PhoneTheme.warning).frame(width: 7, height: 7).offset(x: 3, y: -3)
                                    }
                                }
                        }
                            .accessibilityLabel(PhoneMessages.phoneAppYourComputer()).accessibilityValue(session.reachLine)
                            .accessibilityIdentifier("computer-details")
                            .keyboardShortcut("i", modifiers: .command)
                    }
                }
            }
            .sheet(isPresented: $details) {
                if let session = model.connection {
                    PhoneComputerSheet(session: session, leave: { Task { await model.leave() } }, forget: { model.forgetMac() })
                }
            }
            .sheet(isPresented: $settings) {
                if let session = model.connection { PhoneSettingsSheet(session: session).environment(model.secrets).environment(model.google).environment(model.settings) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
                if phoneKeyboardArrives(note) { keyboardVisible = true }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardVisible = false
            }
            .onChange(of: model.connection == nil || model.removed) { _, unavailable in
                if unavailable { details = false; settings = false }
            }
            .safeAreaInset(edge: .bottom) {
                if let problem = model.problem {
                    Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                        .padding().frame(maxWidth: .infinity).background(PhoneTheme.surface)
                        .accessibilityIdentifier("problem")
                }
            }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    CodeScanner(scanned: { value in scanning = false; model.propose(value) },
                                failed: { words in scanning = false; model.problem = words })
                        .phoneTitle(PhoneMessages.phoneJoinScanTitle())
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(PhoneMessages.phoneCommonCancel()) { scanning = false } } }
                }
            }
            .sheet(isPresented: $pasting) {
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                            Text(PhoneMessages.phoneJoinPasteHelp())
                                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                            TextField(PhoneMessages.phoneJoinPasteField(), text: $linkText, axis: .vertical)
                                .textFieldStyle(.phone)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .privacySensitive().accessibilityIdentifier("join-link")
                            // INF-1312: one row, Paste at the leading edge and Continue fitted at the trailing edge.
                            PhoneChoiceRow {
                                PasteButton(payloadType: String.self) { strings in linkText = strings.first ?? "" }
                                    .layoutValue(key: PhoneChoiceRow.Leading.self, value: true)
                                Button(PhoneMessages.phoneCommonContinue()) {
                                    let text = linkText; linkText = ""; pasting = false; model.propose(text)
                                }.buttonStyle(PhoneChoiceStyle(.primary))
                                    .disabled(linkText.isEmpty).accessibilityIdentifier("read-link")
                            }
                        }.padding(PhoneTheme.space5).frame(maxWidth: 468).frame(maxWidth: .infinity)
                    }
                    .phoneTitle(PhoneMessages.phoneJoinPasteTitle())
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(PhoneMessages.phoneCommonCancel()) { linkText = ""; pasting = false } } }
                }.phoneSheetSurface()
            }
            .sheet(isPresented: Binding(get: { addressing || model.addressJoin != nil },
                                        set: { if !$0 { model.cancelAddressJoin(); addressing = false } })) {
                PhoneAddressSheet(model: model, close: { addressing = false })
            }
            // Once the computer answers its link, the sheet closes and the phone joins with it.
            .onChange(of: model.busy) { _, busy in if busy { addressing = false } }
            // An alert keeps Cancel beside Join; the link may come from a scan, a paste or another app, with no button to anchor to.
            .alert(joinWords.title, isPresented: Binding(
                get: { model.proposal != nil && !model.busy },
                set: { if !$0 && !model.busy { model.proposal = nil } }
            )) {
                Button(joinWords.button) { model.join() }.accessibilityIdentifier("confirm-join")
                Button(PhoneMessages.phoneCommonCancel(), role: .cancel) { model.proposal = nil }
            } message: {
                Text(PhoneMessages.phoneJoinConfirmLine())
            }

        }
    }

    /// The join alert's title and button, naming the computer its link proposes.
    private var joinWords: (title: String, button: String) {
        guard let computer = model.proposal?.computer else {
            return (PhoneMessages.phoneJoinConfirmTitle(), PhoneMessages.phoneJoinConfirm())
        }
        return (PhoneMessages.phoneJoinConfirmTitleNamed(computer: computer), PhoneMessages.phoneJoinConfirmNamed(computer: computer))
    }

    /// The first screen's shape, as the Mac's first launch: the first mate above a heading and the line under it, then its controls.
    private func firstScreen(_ heading: String, _ line: String, @ViewBuilder controls: () -> some View) -> some View {
        ScrollView {
            VStack(spacing: PhoneTheme.space5) {
                PhoneCharacter().frame(width: 150, height: 150)
                VStack(spacing: PhoneTheme.space3) {
                    Text(heading).font(PhoneFont.display).foregroundStyle(PhoneTheme.text)
                    Text(line).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                }.multilineTextAlignment(.center)
                controls()
            }.padding(PhoneTheme.space5).frame(maxWidth: 468)
                .frame(maxWidth: .infinity)
        }
    }

    // INF-589 item 13: a welcome, in the Mac's first-launch words, rather than a sentence that reads as a fault.
    private var joinScreen: some View {
        firstScreen(PhoneMessages.phoneJoinWelcomeTitle(), PhoneMessages.phoneJoinWelcomeLine()) {
            if model.busy { ProgressView(PhoneMessages.phoneJoinJoining()).accessibilityIdentifier("joining") }
            // INF-1312: the three ways in are rows in one list, each with its symbol and one line of guidance.
            PhoneList {
                Button { scanning = true } label: {
                    PhoneRow(symbol: .scan, title: PhoneMessages.phoneJoinScanTitle(), line: PhoneMessages.phoneJoinScanLine(), chevron: true)
                }.accessibilityIdentifier("scan-code")
                Button { pasting = true } label: {
                    PhoneRow(symbol: .link, title: PhoneMessages.phoneJoinPasteTitle(), line: PhoneMessages.phoneJoinPasteLine(), chevron: true)
                }.accessibilityIdentifier("paste-link")
                // INF-1183: a computer away from this network, reached by the address its person signs in with.
                Button { addressing = true } label: {
                    PhoneRow(symbol: .at, title: PhoneMessages.phoneJoinAddressTitle(), line: PhoneMessages.phoneJoinAddressLine(), chevron: true)
                }.accessibilityIdentifier("join-by-address")
            }.buttonStyle(PhoneRowStyle()).disabled(model.busy)
            // Nearby is one plain line: the way to find a computer, or each computer announcing Infinitary.
            VStack(spacing: 0) {
                if model.nearby.macs.isEmpty {
                    Text(model.nearby.problem ?? PhoneMessages.phoneJoinNearbyEmpty())
                        .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).multilineTextAlignment(.center)
                }
                ForEach(model.nearby.macs) { mac in
                    Button { scanning = true } label: {
                        HStack(spacing: PhoneTheme.space2) {
                            Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6)
                            Text(mac.name).foregroundStyle(PhoneTheme.text)
                            Text(PhoneMessages.phoneJoinNearbyScan()).foregroundStyle(PhoneTheme.secondary)
                        }.font(PhoneFont.callout).frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(PhoneMessages.phoneJoinNearbyScanLabel(computer: mac.name))
                }
            }.disabled(model.busy)
        }
    }

    // INF-589 item 11: out of reach is said once, by the reach line under the bar; no strip repeats it.
    private func connected(_ session: ReadOnlySession) -> some View {
        PhoneWorkspace(session: session, stage: PhoneCards(session: session),
            tasks: PhoneTasks(session: session), composer: MessageComposer(session: session))
            .environment(model.secrets)
            .id(session.mac.deviceID)
            // INF-589 item 12: a soft tap when the computer comes back after it was lost.
            .sensoryFeedback(.phone, trigger: session.returns)
    }

}
