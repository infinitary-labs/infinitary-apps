import InfinitaryKit
import SwiftUI

/// INF-4012's direction 1: the computer's own update, seen and started from the phone (docs/ios.md, "Updating the
/// computer"). The line under the message box shows while the versions differ or an update is under way; Settings,
/// General always shows the row. Update asks first, naming the work that finishes before the restart.
struct PhoneHomeUpdateControls: View {
    let session: ReadOnlySession
    /// The line under the message box, or the row in Settings, General.
    var row = false
    @State private var confirming = false
    @State private var busy = false
    @State private var problem: String?

    private var update: PhoneHomeUpdate? { session.homeUpdate }
    private var name: String { session.mac.name }
    private var restarting: Bool { session.homeRestartingSince != nil || session.homeNotBack }

    /// Under the message box the line shows only while the versions differ or the update moves or failed.
    private var shownUnderBox: Bool {
        guard session.homeUpdateLine != nil else { return false }
        return restarting || session.access != "full" || update?.underWay == true || update?.step == "failed"
    }

    var body: some View {
        Group {
            if row { rowView } else if shownUnderBox { lineView }
        }
        .task(id: session.homeUpdates && session.contact == "in-reach") {
            guard session.homeUpdates, session.contact == "in-reach" else { return }
            try? await session.readHomeUpdate()
        }
        .task(id: session.homeUpdatePolls) {
            while session.homeUpdatePolls, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                try? await session.readHomeUpdate()
            }
        }
        .confirmationDialog(confirmTitle, isPresented: $confirming, titleVisibility: .visible) {
            Button(PhoneMessages.viewHomeUpdateButton(name: name)) { press { try await session.installHomeUpdate() } }
                .accessibilityIdentifier("home-update-confirm")
            Button(PhoneMessages.viewHomeUpdateNotNow(), role: .cancel) {}
        } message: {
            Text((update?.confirmLines(name: name) ?? []).joined(separator: "\n"))
        }
    }

    private var confirmTitle: String {
        PhoneMessages.viewHomeUpdateConfirmTitle(name: name, version: update?.offered ?? update?.version ?? "")
    }

    private var lineView: some View {
        VStack(spacing: PhoneTheme.space2) {
            if let words = session.homeUpdateLine {
                Text(words).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    .accessibilityIdentifier("home-update-line")
            }
            buttons
        }
    }

    private var rowView: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(PhoneMessages.viewHomeUpdateRow(name: name)).font(PhoneFont.headline)
            Text(rowStatus).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                .accessibilityIdentifier("home-update-status")
            buttons
        }
    }

    private var rowStatus: String {
        if restarting, let line = session.homeUpdateLine { return line }
        return update?.status(name: name) ?? ""
    }

    @ViewBuilder private var buttons: some View {
        if !restarting, let update, update.offersUpdate || update.offersLater {
            PhoneChoiceRow {
                if update.offersUpdate {
                    Button(update.step == "failed" ? PhoneMessages.viewHomeUpdateTryAgain() : PhoneMessages.viewHomeUpdateButton(name: name)) {
                        arm()
                    }
                    .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(busy)
                    .accessibilityIdentifier("home-update")
                }
                if update.offersLater {
                    Button(PhoneMessages.viewHomeUpdateLater()) { press { try await session.laterHomeUpdate() } }
                        .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(busy)
                        .accessibilityIdentifier("home-update-later")
                }
            }
        }
        if let problem {
            Text(problem).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                .accessibilityIdentifier("home-update-problem")
        }
    }

    /// The confirmation names what the restart stops now, so Update reads the computer again first.
    private func arm() {
        busy = true
        problem = nil
        Task {
            do { try await session.readHomeUpdate() } catch { problem = error.localizedDescription }
            busy = false
            if problem == nil, session.homeUpdate?.offersUpdate == true { confirming = true }
        }
    }

    private func press(_ ask: @escaping () async throws -> Void) {
        busy = true
        problem = nil
        Task {
            do { try await ask() } catch { problem = error.localizedDescription }
            busy = false
        }
    }
}
