import InfinitaryKit
import LocalAuthentication
import SwiftUI

/// INF-4207 piece 9: Take over on the computer's sheet while the home is out of reach (docs/devices.md, "Taking over
/// from a phone"; design skill `components/devices/PhoneView`, "Taking over"). Each computer that keeps a copy is
/// read live: when its copy is from, where the home stands as it hears it, and every other copy with whether it may
/// be newer, as its own window shows them. Take over asks once in place, then Face ID or the passcode, and that
/// computer takes over as its own window would. The phone then finds the home there with no new code.
struct PhoneTakeOverSection: View {
    let session: ReadOnlySession
    let standbys: [PhoneStandby]
    @State private var offers: [String: Read] = [:]
    @State private var asking: PhoneStandby?
    @State private var taking: String?
    /// One ask per confirmation, so the same ask sent again after a dropped link is the same takeover.
    @State private var ask: (standby: String, id: UUID)?
    @State private var said: [String: String] = [:]

    enum Read: Equatable {
        case reading
        case read(PhoneTakeOverOffer)
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.phoneTakeOverHeading()).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
            Text(PhoneMessages.phoneTakeOverExplain(computer: session.mac.name))
            ForEach(standbys) { standby in row(standby) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
        // A container of its own, so each computer's row keeps its own name instead of taking the section's.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("take-over")
        .alert(asking.map { PhoneMessages.phoneTakeOverAsk(name: $0.name) } ?? "", isPresented: Binding(
            get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            Button(PhoneMessages.phoneTakeOverButton(), role: .destructive) {
                if let standby = asking { Task { await takeOver(standby) } }
            }.accessibilityIdentifier("confirm-take-over")
            Button(PhoneMessages.phoneTakeOverNotNow(), role: .cancel) {}
        } message: {
            if let standby = asking {
                Text(PhoneMessages.phoneTakeOverAskDetail(computer: session.mac.name, name: standby.name))
            }
        }
    }

    private func row(_ standby: PhoneStandby) -> some View {
        let state = offers[standby.deviceID] ?? .reading
        let offer: PhoneTakeOverOffer? = if case .read(let offer) = state { offer } else { nil }
        let running = taking == standby.deviceID || offer?.asked?.state == .running
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            HStack(spacing: PhoneTheme.space2) {
                Circle().fill(offer?.canTakeOver == true ? PhoneTheme.accent : PhoneTheme.warning)
                    .frame(width: 6, height: 6).accessibilityHidden(true)
                Text(standby.name).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
            }
            ForEach(Array(lines(state).enumerated()), id: \.offset) { _, line in
                Text(line.text).font(line.newer ? PhoneFont.micro : PhoneFont.callout)
                    .foregroundStyle(line.newer ? PhoneTheme.warning : PhoneTheme.secondary)
            }
            if let words = said[standby.deviceID] ?? (offer?.asked.map { $0.state == .running ? nil : $0.text } ?? nil) {
                Text(words).foregroundStyle(PhoneTheme.text).accessibilityIdentifier("take-over-said")
            }
            PhoneChoiceRow {
                Button(running ? PhoneMessages.phoneTakeOverTaking() : PhoneMessages.phoneTakeOverButton()) {
                    asking = standby
                }
                .buttonStyle(PhoneChoiceStyle(.secondary))
                .disabled(running || offer?.canTakeOver != true)
                .accessibilityIdentifier("take-over-\(standby.deviceID)")
            }
        }
        .padding(PhoneTheme.space4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
        .overlay(RoundedRectangle(cornerRadius: PhoneTheme.controlRadius).strokeBorder(PhoneTheme.line, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("standby-\(standby.deviceID)")
        // Each computer is read on its own, so one out of reach never holds up the others. While a takeover runs
        // there, as one this phone asked before this row appeared, it is read again until that computer answered it.
        .task(id: standby) { if taking != standby.deviceID { await readUntilAnswered(standby) } }
    }

    /// What that computer says Take over rests on, in the order its own window says it.
    private func lines(_ read: Read) -> [(text: String, newer: Bool)] {
        switch read {
        case .reading: return [(PhoneMessages.phoneTakeOverAsking(), false)]
        case .failed(let words): return [(words, false)]
        case .read(let offer):
            let home = offer.homeName ?? session.mac.name
            var lines: [(text: String, newer: Bool)] = [(offer.copyAt.map { PhoneMessages.phoneTakeOverCopyFrom(time: PhoneFormats.since($0)) }
                ?? PhoneMessages.phoneTakeOverCopyNone(), false)]
            switch offer.contact {
            case .inReach: lines.append((PhoneMessages.phoneTakeOverHomeInReach(computer: home), false))
            case .closed: lines.append((PhoneMessages.phoneTakeOverHomeQuit(computer: home), false))
            case .lost, .reaching:
                lines.append((offer.slept ? PhoneMessages.phoneTakeOverHomeSlept(computer: home)
                    : PhoneMessages.phoneTakeOverHomeLost(computer: home), false))
            }
            for copy in offer.copies {
                lines.append((copy.copyAt.map { PhoneMessages.phoneTakeOverOtherCopy(name: copy.name, time: PhoneFormats.since($0)) }
                    ?? PhoneMessages.phoneTakeOverOtherCopyNone(name: copy.name), false))
                if copy.newer { lines.append((PhoneMessages.phoneTakeOverNewer(), true)) }
            }
            if !offer.ready { lines.append((PhoneMessages.phoneTakeOverNeverTold(computer: home), false)) }
            return lines
        }
    }

    /// Reads that computer, and again while a takeover runs there, until it answered it.
    private func readUntilAnswered(_ standby: PhoneStandby) async {
        while !Task.isCancelled {
            offers[standby.deviceID] = await read(standby)
            guard case .read(let offer)? = offers[standby.deviceID] else { return }
            // Its own answer replaces what this phone said when the link dropped, and one it answered is never asked again.
            if let asked = offer.asked {
                said[standby.deviceID] = nil
                if asked.state != .running, ask?.standby == standby.deviceID { ask = nil }
            }
            guard offer.asked?.state == .running else { return }
            try? await Task.sleep(for: ReadOnlySession.pingEvery)
        }
    }

    private func read(_ standby: PhoneStandby) async -> Read {
        do { return .read(try await session.takeOverOffer(standby)) }
        catch { return .failed(Self.words(error, standby: standby)) }
    }

    private func takeOver(_ standby: PhoneStandby) async {
        said[standby.deviceID] = nil
        guard await Self.confirm(reason: PhoneMessages.phoneTakeOverReason(name: standby.name)) else { return }
        let id = ask?.standby == standby.deviceID ? ask!.id : UUID()
        ask = (standby.deviceID, id)
        taking = standby.deviceID
        do {
            let answer = try await session.takeOver(standby, id: id)
            said[standby.deviceID] = answer.text
            if answer.state != .running { ask = nil }
            // Once it started the first mate that computer keeps no copy: its answer is the last word here, and its
            // row stays taking over until the phone finds the home there.
            if answer.state == .started { return }
        } catch {
            said[standby.deviceID] = Self.words(error, standby: standby, failed: true)
        }
        taking = nil
        // A link that dropped while the takeover ran there is read again until that computer answered it.
        await readUntilAnswered(standby)
    }

    private static func words(_ error: Error, standby: PhoneStandby, failed: Bool = false) -> String {
        switch error as? StandbyLinkError {
        case .needsUpdate: PhoneMessages.phoneTakeOverNeedsUpdate()
        case .notListed: PhoneMessages.phoneTakeOverNotListed()
        case .refused(let words) where !words.isEmpty: words
        case .unreachable where !failed: PhoneMessages.phoneTakeOverUnreachable()
        default: PhoneMessages.phoneTakeOverFailed(name: standby.name)
        }
    }

    /// The person confirms it is them on this phone, as Touch ID or the password does on the computer's own window.
    /// A fresh check each time: no earlier confirmation is reused.
    private static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true
    }
}
