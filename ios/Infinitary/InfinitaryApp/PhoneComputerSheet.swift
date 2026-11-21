import InfinitaryKit
import SwiftUI

struct PhoneReach: View {
    let session: ReadOnlySession
    /// INF-589 item 17: on one line the time it was last heard follows the state.
    var oneLine = false
    var body: some View {
        (oneLine ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2)) : AnyLayout(VStackLayout(spacing: 2))) {
            HStack(spacing: PhoneTheme.space2) {
                Circle().fill(session.reach == "in-reach" ? PhoneTheme.accent : PhoneTheme.warning)
                    .frame(width: 6, height: 6).accessibilityHidden(true)
                Text(session.reachWords).accessibilityIdentifier("contact")
            }
            if let time = session.reachTime { Text(PhoneMessages.phoneReachSince(time: time)) }
        }.font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
    }
}

extension ReadOnlySession {
    /// The reach, in the words the reach line and the computer button share. INF-2668: they follow the patient
    /// `reach`, so a redial the computer answers within the captain's 20 s says nothing. INF-4207 piece 2: Live once
    /// every change is shown, and a catch-up says whether it replays what was missed or reads everything again.
    var reachWords: String {
        switch reach {
        case "in-reach": PhoneMessages.phoneReachLive()
        case "reaching": PhoneMessages.phoneReachReaching()
        case "catching-up":
            catchingUp == "replay" ? PhoneMessages.phoneReachCatchingUp() : PhoneMessages.phoneReachReadingAgain()
        default: PhoneMessages.phoneReachOutOfReach()
        }
    }

    /// Since when the computer is out of reach, naming the day when it was not today; reaching it again needs no time.
    var reachTime: String? {
        guard reach != "in-reach", reach != "reaching", reach != "catching-up", let heardAt else { return nil }
        return PhoneFormats.since(heardAt)
    }

    /// INF-1062: the computer button in the top bar says the reach to VoiceOver, with its time while out of reach.
    var reachLine: String {
        guard let reachTime else { return reachWords }
        return PhoneMessages.phoneReachLineSince(reach: reachWords, time: reachTime)
    }

    /// INF-589 item 11: the reach line says out of reach, so the one line where changes are made says only that
    /// they are off, in the Mac's words (`changesOffWords`, src/renderer/src/devices/viewWords.ts). None while first reaching,
    /// nor while the words still say In reach during a redial (INF-2668).
    var changesOffLine: String? {
        switch reach {
        case "in-reach": contact == "in-reach" ? changeRefusal : nil
        case "reaching": nil
        case "catching-up": contact == "in-reach" ? changeRefusal : nil
        default: PhoneMessages.phoneReachChangesOff(computer: mac.name)
        }
    }
}

/// INF-1062: the computer's own sheet, with its name, reach and address, then Leave or Forget under its own heading.
/// INF-1517, the captain's pick: it opens at half height on the system's glass with Settings' headings and spacing.
/// This device's own facts live in `PhoneSettingsSheet`.
/// INF-5265: under them, the other kept computers, each marked when it answers; Add another computer comes last, after
/// Leave, so a phone that keeps one computer finds Leave where it always was, at every Text Size.
struct PhoneComputerSheet: View {
    let session: ReadOnlySession
    let model: PhoneModel
    /// INF-5265: each acts on the computer its confirmation named, even when another shows by the time it is answered.
    let leave: (ReadOnlySession) -> Void
    let forget: (String) -> Void
    /// Opens a way in to join one more computer, after this sheet closes.
    let add: (PhoneAddWay) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var leaving = false
    @State private var forgetting = false
    /// The computer the open confirmation names.
    @State private var named: ReadOnlySession?
    @State private var choosingWay = false
    @FocusState private var focusedRow: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space5) {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        Text(session.mac.name).font(PhoneFont.headline).accessibilityIdentifier("home-name")
                        Text(PhoneMessages.phoneComputerFirstMateHere()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                        PhoneReach(session: session)
                        if let address = session.reachedAddress {
                            Text(address).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted)
                                .accessibilityIdentifier("reached-address")
                        }
                    }
                    // INF-4207 piece 9: while the home is out of reach, a computer that keeps a copy can take over. It
                    // stays through a reopen's Reaching, as Face ID makes, so a takeover under way keeps its row.
                    if session.homeLost, let standbys = session.mac.standbys, !standbys.isEmpty {
                        PhoneTakeOverSection(session: session, standbys: standbys)
                    }
                    otherComputers
                    exitControls
                    addComputer
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            .onAppear { model.lookAtOthers() }
            // Another computer showing closes a confirmation that named the one before.
            .onChange(of: session.mac.pin) { leaving = false; forgetting = false; named = nil }
            .phoneTitle(PhoneMessages.phoneComputerTitle())
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-computer-details")
            } }
            // Alerts keep the cancel choice in view; a popover from the button would hide it.
            .alert(PhoneMessages.phoneComputerLeaveAsk(computer: session.mac.name), isPresented: $leaving) {
                Button(PhoneMessages.phoneComputerLeaveConfirm(), role: .destructive) {
                    dismiss(); if let named { leave(named) }
                }.accessibilityIdentifier("confirm-leave")
                Button(PhoneMessages.phoneComputerKeep(), role: .cancel) {}
            } message: { Text(PhoneMessages.phoneComputerLeaveWarning()) }
            .alert(PhoneMessages.phoneComputerForgetAsk(), isPresented: $forgetting) {
                Button(PhoneMessages.phoneComputerForgetConfirm(), role: .destructive) {
                    dismiss(); if let named { forget(named.mac.pin) }
                }.accessibilityIdentifier("confirm-forget")
                Button(PhoneMessages.phoneComputerKeep(), role: .cancel) {}
            } message: { Text(PhoneMessages.phoneComputerForgetWarning()) }
            .confirmationDialog(PhoneMessages.phoneComputerAddTitle(), isPresented: $choosingWay, titleVisibility: .visible) {
                Button(PhoneMessages.phoneJoinScanTitle()) { pick(.scan) }.accessibilityIdentifier("add-scan-code")
                Button(PhoneMessages.phoneJoinPasteTitle()) { pick(.paste) }.accessibilityIdentifier("add-paste-link")
                Button(PhoneMessages.phoneJoinAddressTitle()) { pick(.address) }.accessibilityIdentifier("add-by-address")
                Button(PhoneMessages.phoneCommonCancel(), role: .cancel) {}
            }
        }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).phoneSheetSurface()
    }

    private func pick(_ way: PhoneAddWay) {
        add(way)
        dismiss()
    }

    /// The other kept computers. A tap shows a computer: the phone never switches by itself (the captain's pick,
    /// Stay), so a mark only says which one answers now. On an iPad keyboard the arrows move among the rows, on to Add
    /// another computer, and Return or Space presses one; a press with Command held is left to the app's own commands.
    @ViewBuilder private var otherComputers: some View {
        if !model.kept.others.isEmpty {
            let rows = model.kept.others.map(\.pin) + [Self.addRow]
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                Text(PhoneMessages.phoneComputerOthersHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                PhoneList {
                    ForEach(model.kept.others, id: \.pin) { mac in
                        Button { dismiss(); model.show(mac.pin) } label: {
                            PhoneRow(symbol: .computer, title: mac.name, line: answerWords(mac.pin), chevron: true)
                                .overlay(alignment: .leading) {
                                    if model.answering[mac.pin] == true {
                                        Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6)
                                            .offset(x: PhoneTheme.space2).accessibilityHidden(true)
                                    }
                                }
                        }
                        .accessibilityLabel(mac.name).accessibilityValue(answerWords(mac.pin))
                        .accessibilityHint(PhoneMessages.phoneComputerShowHint())
                        .accessibilityIdentifier("kept-computer")
                        .focusable().focused($focusedRow, equals: mac.pin)
                        .onPlainKey(.return) { dismiss(); model.show(mac.pin) }
                        .onPlainKey(.space) { dismiss(); model.show(mac.pin) }
                        .onPlainKey(.downArrow) { focusedRow = step(rows, from: mac.pin, by: 1) }
                        .onPlainKey(.upArrow) { focusedRow = step(rows, from: mac.pin, by: -1) }
                    }
                }.buttonStyle(PhoneRowStyle())
            }.frame(maxWidth: .infinity, alignment: .leading)
                // The sheet opens with the first row focused, so a keyboard's arrows and Return reach the list at once.
                .onAppear { focusedRow = rows.first }
        }
    }

    /// Add another computer, the last row of the sheet.
    private var addComputer: some View {
        PhoneList {
            Button { choosingWay = true } label: {
                PhoneRow(symbol: .plus, title: PhoneMessages.phoneComputerAddTitle(),
                         line: PhoneMessages.phoneComputerAddLine(), chevron: true)
            }
            .accessibilityIdentifier("add-computer")
            .focusable().focused($focusedRow, equals: Self.addRow)
            .onPlainKey(.return) { choosingWay = true }
            .onPlainKey(.space) { choosingWay = true }
            .onPlainKey(.upArrow) {
                if let last = model.kept.others.last { focusedRow = last.pin }
            }
        }.buttonStyle(PhoneRowStyle()).frame(maxWidth: .infinity, alignment: .leading)
    }

    private static let addRow = "add-computer" // i18n-exempt: a focus name, not shown

    private func step(_ rows: [String], from row: String, by offset: Int) -> String {
        guard let index = rows.firstIndex(of: row) else { return row }
        return rows[min(max(index + offset, 0), rows.count - 1)]
    }

    /// Whether another kept computer answered the phone's last look, in the reach line's words.
    private func answerWords(_ pin: String) -> String {
        switch model.answering[pin] {
        case true: PhoneMessages.phoneComputerAnswers()
        case false: PhoneMessages.phoneComputerNotAnswering()
        default: PhoneMessages.phoneComputerLooking()
        }
    }

    // Close the sheet on confirmation so any failure remains visible in the root's problem notice.
    // INF-1312: the sentence first, then one fitted button in the Mac's red outline at the trailing edge.
    // INF-1517: a section of its own, headed Leave, or Forget while the computer is out of reach.
    private var exitControls: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if session.contact == "in-reach" {
                Text(PhoneMessages.phoneComputerLeaveHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                Text(PhoneMessages.phoneComputerLeaveExplain())
                PhoneChoiceRow {
                    Button(PhoneMessages.phoneComputerLeaveButton(computer: session.mac.name)) { named = session; leaving = true }
                        .buttonStyle(PhoneChoiceStyle(.danger)).accessibilityIdentifier("leave")
                }
            } else {
                Text(PhoneMessages.phoneComputerForgetHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                Text(PhoneMessages.phoneComputerForgetExplain(computer: session.mac.name))
                PhoneChoiceRow {
                    Button(PhoneMessages.phoneComputerForgetButton()) { named = session; forgetting = true }
                        .buttonStyle(PhoneChoiceStyle(.danger)).accessibilityIdentifier("forget-mac")
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
    }
}

/// INF-5265: the ways in Add another computer offers, the first screen's three.
enum PhoneAddWay { case scan, paste, address }

private extension View {
    /// A key pressed alone; with Command, Option or Control held it is left to the app's own commands, such as
    /// Command-Return, which never presses a row behind it (INF-499).
    func onPlainKey(_ key: KeyEquivalent, _ action: @escaping () -> Void) -> some View {
        onKeyPress(keys: [key], phases: .down) { press in
            guard press.modifiers.isDisjoint(with: [.command, .option, .control]) else { return .ignored }
            action()
            return .handled
        }
    }
}
