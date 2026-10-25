import InfinitaryKit
import SwiftUI

@main struct InfinitaryApp: App {
    @State private var model = PhoneModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            PhoneView(model: model)
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
                Button("Hide keyboard", action: dismissPhoneKeyboard).keyboardShortcut("k", modifiers: [.command, .shift])
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
                    // INF-589 item 11: Removed takes the first screen's shape, with one prominent Join again.
                    firstScreen("Removed from your computer",
                        "This device no longer shows your computer. Make a new link in Devices on your computer to join again.") {
                        Button { model.dismissRemoved() } label: {
                            Text("Join again").foregroundStyle(PhoneTheme.onAccent).frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("join-again")
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
                if keyboardVisible {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done", action: dismissPhoneKeyboard)
                            .frame(minWidth: 44, minHeight: 44)
                            .keyboardShortcut("k", modifiers: [.command, .shift])
                            .accessibilityIdentifier("dismiss-phone-keyboard")
                    }
                } else if model.connection != nil, !model.removed {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { settings = true } label: { PhoneSymbol.settings.image.frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel("Settings").accessibilityIdentifier("phone-settings")
                            .keyboardShortcut(",", modifiers: .command)
                    }
                }
                if model.connection == nil || model.removed {
                    ToolbarItem(placement: .principal) { Text("Infinitary").font(PhoneFont.headline).accessibilityAddTraits(.isHeader) }
                }
                if let session = model.connection, !model.removed {
                    ToolbarItem(placement: .topBarTrailing) {
                        // The computer's name lives in its sheet; the glyph's dot says the reach, and VoiceOver hears the words.
                        Button { details = true } label: {
                            PhoneSymbol.computer.image
                                .overlay(alignment: .topTrailing) {
                                    Circle().fill(session.contact == "in-reach" ? PhoneTheme.accent : PhoneTheme.warning)
                                        .frame(width: 7, height: 7).offset(x: 3, y: -3)
                                }
                                .frame(minWidth: 44, minHeight: 44)
                        }
                            .accessibilityLabel("Your computer").accessibilityValue(session.reachLine)
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
                if let session = model.connection { PhoneSettingsSheet(session: session) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                keyboardVisible = true
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
                        .phoneTitle("Scan the code")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
                }
            }
            .sheet(isPresented: $pasting) {
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                            Text("On your computer, open Settings → Devices → A phone, then copy its link.")
                                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                            TextField("Your computer’s link", text: $linkText, axis: .vertical)
                                .textFieldStyle(.phone)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .privacySensitive().accessibilityIdentifier("join-link")
                            PasteButton(payloadType: String.self) { strings in linkText = strings.first ?? "" }
                            Button {
                                let text = linkText; linkText = ""; pasting = false; model.propose(text)
                            } label: { Text("Continue").foregroundStyle(linkText.isEmpty ? PhoneTheme.muted : PhoneTheme.onAccent).frame(maxWidth: .infinity, minHeight: 44) }
                                .buttonStyle(.borderedProminent).controlSize(.large)
                                .disabled(linkText.isEmpty).accessibilityIdentifier("read-link")
                        }.padding(PhoneTheme.space5).frame(maxWidth: 468).frame(maxWidth: .infinity)
                    }
                    .phoneTitle("Paste its link")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { linkText = ""; pasting = false } } }
                }.phoneSheetSurface()
            }
            .sheet(isPresented: Binding(get: { addressing || model.addressJoin != nil },
                                        set: { if !$0 { model.cancelAddressJoin(); addressing = false } })) {
                PhoneAddressSheet(model: model, close: { addressing = false })
            }
            // Once the computer answers its link, the sheet closes and the phone joins with it.
            .onChange(of: model.busy) { _, busy in if busy { addressing = false } }
            // An alert keeps Cancel beside Join; the link may come from a scan, a paste or another app, with no button to anchor to.
            .alert("Join \(model.proposal?.computer ?? "your computer")?", isPresented: Binding(
                get: { model.proposal != nil && !model.busy },
                set: { if !$0 && !model.busy { model.proposal = nil } }
            )) {
                Button("Join \(model.proposal?.computer ?? "your computer")") { model.join() }.accessibilityIdentifier("confirm-join")
                Button("Cancel", role: .cancel) { model.proposal = nil }
            } message: {
                Text("Your first mate stays on this computer. This phone will show its cards and Activity. Only join your own computer.")
            }

        }
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
        firstScreen("Welcome aboard Infinitary", "Your first mate lives on your Mac. Join it to read your cards and Activity here.") {
            if model.busy { ProgressView("Joining your computer…").accessibilityIdentifier("joining") }
            // Nearby is one plain line: the way to find a computer, or each computer announcing Infinitary.
            VStack(spacing: 0) {
                if model.nearby.macs.isEmpty {
                    Text(model.nearby.problem ?? "Open A phone in Devices on your computer to find it here.")
                        .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).multilineTextAlignment(.center)
                }
                ForEach(model.nearby.macs) { mac in
                    Button { scanning = true } label: {
                        HStack(spacing: PhoneTheme.space2) {
                            Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6)
                            Text(mac.name).foregroundStyle(PhoneTheme.text)
                            Text("Scan its code").foregroundStyle(PhoneTheme.secondary)
                        }.font(PhoneFont.callout).frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Scan the code on \(mac.name)")
                }
            }.disabled(model.busy)
            VStack(spacing: PhoneTheme.space3) {
                Button { scanning = true } label: { Text("Scan the code").foregroundStyle(PhoneTheme.onAccent).frame(maxWidth: .infinity, minHeight: 44) }
                    .buttonStyle(.borderedProminent).accessibilityIdentifier("scan-code")
                // A plain secondary, with no fill under it.
                Button { pasting = true } label: { Text("Paste its link").frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.borderless).accessibilityIdentifier("paste-link")
                // INF-1183: a computer away from this network, reached by the address its person signs in with.
                Button { addressing = true } label: { Text("Join by its address").frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.borderless).accessibilityIdentifier("join-by-address")
            }.controlSize(.large).disabled(model.busy)
        }
    }

    // INF-589 item 11: out of reach is said once, by the reach line under the bar; no strip repeats it.
    private func connected(_ session: ReadOnlySession) -> some View {
        PhoneWorkspace(session: session, stage: PhoneCards(session: session),
            tasks: PhoneTasks(session: session), composer: MessageComposer(session: session))
            .id(session.mac.deviceID)
            // INF-589 item 12: a soft tap when the computer comes back after it was lost.
            .sensoryFeedback(.phone, trigger: session.returns)
    }

}
