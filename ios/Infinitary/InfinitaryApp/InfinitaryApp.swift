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
    }
}

struct PhoneView: View {
    @Bindable var model: PhoneModel
    @State private var scanning = false
    @State private var pasting = false
    @State private var linkText = ""
    @State private var leaving = false
    @State private var forgetting = false

    var body: some View {
        NavigationStack {
            Group {
                if model.removed {
                    ContentUnavailableView {
                        Label("Removed from your Mac", systemImage: "iphone.slash")
                    } description: {
                        Text("This phone no longer shows your Mac. Make a new link in Devices on your Mac to join again.")
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
                if model.connection != nil && !model.removed {
                    ToolbarItem(placement: .topBarTrailing) {
                        if model.connection?.contact == "in-reach" {
                            Button("Leave") { leaving = true }.accessibilityIdentifier("leave")
                        } else {
                            Button("Forget this Mac") { forgetting = true }.accessibilityIdentifier("forget-mac")
                        }
                    }
                }
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
                        .navigationTitle("Scan your Mac’s code")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
                }
            }
            .sheet(isPresented: $pasting) {
                NavigationStack {
                    Form {
                        Text("On your Mac, open Settings → Devices → A phone, then copy its link.")
                        TextField("Your Mac’s link", text: $linkText, axis: .vertical)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .privacySensitive().accessibilityIdentifier("join-link")
                        PasteButton(payloadType: String.self) { strings in linkText = strings.first ?? "" }
                        Button("Continue") {
                            let text = linkText; linkText = ""; pasting = false; model.propose(text)
                        }.disabled(linkText.isEmpty).accessibilityIdentifier("read-link")
                    }
                    .navigationTitle("Paste its link")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { linkText = ""; pasting = false } } }
                }
            }
            .confirmationDialog("Join \(model.proposal?.computer ?? "your Mac")?", isPresented: Binding(
                get: { model.proposal != nil && !model.busy },
                set: { if !$0 && !model.busy { model.proposal = nil } }
            ), titleVisibility: .visible) {
                Button("Join this Mac") { model.join() }.accessibilityIdentifier("confirm-join")
                Button("Cancel", role: .cancel) { model.proposal = nil }
            } message: {
                Text("Your first mate stays on this computer. This phone will show its cards and Activity. Only join your own computer.")
            }
            .confirmationDialog("Leave \(model.connection?.mac.name ?? "your Mac")?", isPresented: $leaving, titleVisibility: .visible) {
                Button("Leave this Mac", role: .destructive) { Task { await model.leave() } }
                Button("Keep it", role: .cancel) {}
            } message: { Text("This phone forgets the Mac. To come back, use a new link.") }
            .confirmationDialog("Forget this Mac?", isPresented: $forgetting, titleVisibility: .visible) {
                Button("Forget this Mac", role: .destructive) { model.forgetMac() }.accessibilityIdentifier("confirm-forget")
                Button("Keep it", role: .cancel) {}
            } message: { Text("You’ll need a new link to join again. Your Mac may still list this phone.") }
        }
    }

    private var joinScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space5) {
                Text("Infinitary is on another computer").font(PhoneFont.title).fontWeight(.medium)
                Text("Your first mate, its tasks and conversation stay on your Mac. Join it to read your cards and Activity here.")
                    .foregroundStyle(PhoneTheme.secondary)
                if model.busy { ProgressView("Joining your Mac…").accessibilityIdentifier("joining") }
                VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                    Text("Nearby").font(PhoneFont.headline)
                    if model.nearby.macs.isEmpty {
                        Text(model.nearby.problem ?? "Open A phone in Devices on your Mac to find it here.")
                            .foregroundStyle(PhoneTheme.secondary)
                    }
                    ForEach(model.nearby.macs) { mac in
                        Button { scanning = true } label: {
                            VStack(alignment: .leading) {
                                Text(mac.name)
                                Text("Tap to scan its code").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding()
                        }.background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
                    }
                }
                Button("Scan the code") { scanning = true }.buttonStyle(.borderedProminent).controlSize(.large)
                    .accessibilityIdentifier("scan-code")
                Button("Paste its link") { pasting = true }.buttonStyle(.bordered).controlSize(.large)
                    .accessibilityIdentifier("paste-link")
            }.disabled(model.busy).padding(PhoneTheme.space5).frame(maxWidth: 750)
                .frame(maxWidth: .infinity)
        }
    }

    private func connected(_ session: ReadOnlySession) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                Text("Reading Infinitary on \(session.mac.name)").font(PhoneFont.headline)
                    .accessibilityIdentifier("home-name")
                HStack {
                    Circle().fill(session.contact == "in-reach" ? PhoneTheme.accent : PhoneTheme.warning).frame(width: 6, height: 6)
                    Text(session.contact == "in-reach" ? "In reach" : session.contact == "reaching" ? "Reaching your Mac…" : "Out of reach")
                        .accessibilityIdentifier("contact")
                    if session.contact != "in-reach", let date = session.heardAt {
                        Text("· as of \(date.formatted(date: .omitted, time: .shortened))")
                    }
                }.font(.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption))
                Text("Read-only for now. Answer cards on your Mac.").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
            }.padding()
            TabView {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: PhoneTheme.space3) {
                        if session.cards.isEmpty { Text("No cards to read yet.").foregroundStyle(PhoneTheme.secondary) }
                        ForEach(session.cards) { card in
                            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                                if card.reviewTaskId != nil {
                                    Text("Review finding").font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                                }
                                Text(card.title).font(PhoneFont.headline)
                                Text(card.author == "firstmate" ? "Your first mate" : card.author == "host" ? "Infinitary" : "Crewmate")
                                    .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                                if let meta = card.meta, meta != card.author {
                                    Text(meta).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                                }
                            }.padding().frame(maxWidth: .infinity, alignment: .leading)
                                .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.cardRadius))
                                .accessibilityElement(children: .combine)
                        }
                    }.padding().frame(maxWidth: 750).frame(maxWidth: .infinity)
                }.background(PhoneTheme.background).accessibilityIdentifier("cards-list").tabItem { Label("Cards", systemImage: "rectangle.stack") }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: PhoneTheme.space4) {
                        if session.activity.isEmpty { Text("No activity yet.").foregroundStyle(PhoneTheme.secondary) }
                        ForEach(Array(session.activity.reversed().enumerated()), id: \.offset) { _, line in
                            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                                Text(line.text).accessibilityIdentifier("activity-text")
                                Text(Date(timeIntervalSince1970: line.at / 1000).formatted(date: .abbreviated, time: .shortened))
                                    .font(.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption2))
                                    .foregroundStyle(PhoneTheme.secondary)
                            }
                            Divider().overlay(PhoneTheme.line)
                        }
                    }.padding().frame(maxWidth: 750).frame(maxWidth: .infinity)
                }.background(PhoneTheme.background).accessibilityIdentifier("activity-list").tabItem { Label("Activity", systemImage: "list.bullet") }
            }
        }
    }
}
