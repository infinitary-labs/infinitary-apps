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
    @State private var linkText = ""
    @State private var details = false
    @State private var keyboardVisible = false

    var body: some View {
        NavigationStack {
            Group {
                if model.removed {
                    ContentUnavailableView {
                        Label("Removed from your computer", systemImage: "iphone.slash")
                    } description: {
                        Text("This device no longer shows your computer. Make a new link in Devices on your computer to join again.")
                    } actions: {
                        Button("Join again") { model.dismissRemoved() }.accessibilityIdentifier("join-again")
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
                if keyboardVisible {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done", action: dismissPhoneKeyboard)
                            .frame(minWidth: 44, minHeight: 44)
                            .keyboardShortcut("k", modifiers: [.command, .shift])
                            .accessibilityIdentifier("dismiss-phone-keyboard")
                    }
                }
                if model.connection == nil || model.removed {
                    ToolbarItem(placement: .principal) { Text("Infinitary").font(PhoneFont.headline).accessibilityAddTraits(.isHeader) }
                }
                if let session = model.connection, !model.removed {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 2) {
                            Text(session.mac.name).font(PhoneFont.headline).accessibilityIdentifier("home-name")
                            PhoneReach(session: session)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { details = true } label: { PhoneSymbol.computer.image.frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel("Your computer").accessibilityIdentifier("computer-details")
                            .keyboardShortcut("i", modifiers: .command)
                    }
                }
            }
            .sheet(isPresented: $details) {
                if let session = model.connection {
                    PhoneComputerSheet(session: session, leave: { Task { await model.leave() } }, forget: { model.forgetMac() })
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                keyboardVisible = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardVisible = false
            }
            .onChange(of: model.connection == nil || model.removed) { _, unavailable in
                if unavailable { details = false }
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

    private var joinScreen: some View {
        ScrollView {
            VStack(spacing: PhoneTheme.space5) {
                PhoneCharacter().frame(width: 150, height: 150)
                VStack(spacing: PhoneTheme.space3) {
                    Text("Infinitary is on another computer").font(PhoneFont.display)
                        .foregroundStyle(PhoneTheme.text)
                    Text("Your first mate, its tasks and conversation stay on your computer. Join it to read your cards and Activity here.")
                        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                }.multilineTextAlignment(.center)
                if model.busy { ProgressView("Joining your computer…").accessibilityIdentifier("joining") }
                VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                    Text("NEARBY").font(PhoneFont.micro).tracking(1).foregroundStyle(PhoneTheme.muted)
                    VStack(spacing: 0) {
                        if model.nearby.macs.isEmpty {
                            Text(model.nearby.problem ?? "Open A phone in Devices on your computer to find it here.")
                                .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(PhoneTheme.space4)
                        }
                        ForEach(model.nearby.macs) { mac in
                            Button { scanning = true } label: {
                                HStack(spacing: PhoneTheme.space3) {
                                    Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6)
                                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                                        Text(mac.name).foregroundStyle(PhoneTheme.text)
                                        Text("Scan its code").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    PhoneSymbol.scan.image
                                }.padding(PhoneTheme.space4).frame(minHeight: 44)
                            }.buttonStyle(.plain).accessibilityLabel("Scan the code on \(mac.name)")
                        }
                    }
                    .background(PhoneTheme.panel, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
                    .overlay(RoundedRectangle(cornerRadius: PhoneTheme.controlRadius).stroke(PhoneTheme.line, lineWidth: 1))
                }
                VStack(spacing: PhoneTheme.space3) {
                    Button { scanning = true } label: { Text("Scan the code").foregroundStyle(PhoneTheme.onAccent).frame(maxWidth: .infinity, minHeight: 44) }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("scan-code")
                    Button { pasting = true } label: { Text("Paste its link").frame(maxWidth: .infinity, minHeight: 44) }
                        .buttonStyle(.bordered).accessibilityIdentifier("paste-link")
                }.controlSize(.large)
            }.disabled(model.busy).padding(PhoneTheme.space5).frame(maxWidth: 468)
                .frame(maxWidth: .infinity)
        }
    }

    private func connected(_ session: ReadOnlySession) -> some View {
        VStack(spacing: 0) {
            if session.contact != "in-reach" {
                Text(session.contact == "reaching" ? "Waiting for \(session.mac.name)." : "\(session.mac.name) is out of reach. Changes are off until it is back.")
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading)
                    .background(PhoneTheme.panel).accessibilityIdentifier("reach-notice")
            }
            PhoneWorkspace(session: session, stage: PhoneCards(session: session),
                tasks: PhoneTasks(session: session), composer: MessageComposer(session: session))
                .id(session.mac.deviceID)
        }
    }

}
