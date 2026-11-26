import InfinitaryKit
import SwiftUI

/// A button in a panel's status mark, as the desktop's details offer it.
enum PhonePanelStatusPress: Equatable {
    case retry
    case update
    case askFirstmate
    case askAgain(integration: String, action: String)

    func key(_ panel: String) -> String {
        switch self {
        case .retry: "\(panel)/retry"
        case .update: "\(panel)/update"
        case .askFirstmate: "\(panel)/ask-firstmate"
        case .askAgain(let integration, let action): "\(panel)/ask-again/\(integration)/\(action)"
        }
    }
}

/// The small dot by a panel's title for what the computer knows about it and its code cannot say (docs/ios.md,
/// "Panels"; design skill Panel.prompt.md, "The status mark"): the desktop's mark, tone and order. A tap opens the
/// same details as a popover, each section with the desktop's sentence and button; VoiceOver reads the most urgent line.
struct PhonePanelStatusMark: View {
    let panel: PhonePanel
    let pressing: (PhonePanelStatusPress) -> Bool
    let press: (PhonePanelStatusPress) -> Void
    @State private var open = false

    var body: some View {
        let sections = panel.statusSections
        if let first = sections.first {
            Button { open = true } label: {
                Circle().fill(Self.color(first.tone)).frame(width: 6, height: 6)
                    // The tap area is wider than the dot; the title's own gap sits between the name and the dot.
                    .frame(width: 28, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, -8)
            .accessibilityLabel(Self.restWords(first))
            .accessibilityIdentifier("panel-status-\(panel.id)")
            .popover(isPresented: $open) {
                PhonePanelStatusDetails(panel: panel, sections: sections, pressing: pressing, press: press)
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    static func color(_ tone: String) -> Color {
        switch tone {
        case "warn": PhoneTheme.warning
        case "captain": PhoneTheme.captain
        default: PhoneTheme.idle
        }
    }

    /// The one line the desktop's mark says on rest: its most urgent section's.
    static func restWords(_ section: PhonePanelStatus) -> String {
        switch section {
        case .stopped: PhoneMessages.panelMarkStopped()
        case .failing(let rows): PhoneMessages.panelMarkFailing(time: since(rows.first?.since ?? ""))
        case .asking(let asks): PhoneMessages.panelMarkAsking(place: asks.first?.place ?? "")
        case .paused: PhoneMessages.panelMarkPaused()
        case .declined(let asks): PhoneMessages.panelMarkDeclined(place: asks.first?.place ?? "")
        }
    }

    /// A time today alone, or with its date when it is not today, as the desktop writes it.
    static func since(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        return Calendar.current.isDateInToday(date) ? PhoneFormats.time(date) : PhoneFormats.dateTime(date)
    }
}

/// The open details: each section's sentence and its button, most urgent first.
private struct PhonePanelStatusDetails: View {
    let panel: PhonePanel
    let sections: [PhonePanelStatus]
    let pressing: (PhonePanelStatusPress) -> Bool
    let press: (PhonePanelStatusPress) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                ForEach(sections, id: \.key) { section in
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) { content(section) }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("panel-status-\(panel.id)-\(section.key)")
                }
            }
            .padding(PhoneTheme.space4)
            .frame(width: 320, alignment: .leading)
        }
        .accessibilityLabel(PhoneMessages.panelMarkDetails(title: panel.title))
    }

    @ViewBuilder private func content(_ section: PhonePanelStatus) -> some View {
        switch section {
        case .stopped(let exited):
            words(exited ? PhoneMessages.panelBackgroundExited() : PhoneMessages.panelBackgroundStopped())
            button(PhoneMessages.panelRetry(), .retry)
        case .failing(let rows):
            Text(PhoneMessages.panelFailingHeading()).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                words("\(Self.failingLine(row)) \(PhoneMessages.panelFailingStillShows())")
                if !row.answer.isEmpty {
                    Text(row.answer).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                        .padding(.leading, PhoneTheme.space2)
                        .overlay(alignment: .leading) { Rectangle().fill(PhoneTheme.lineStrong).frame(width: 2) }
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(PhoneMessages.panelFailingClears()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if rows.allSatisfy(\.asked) {
                Button(PhoneMessages.panelFailingAsked()) {}.buttonStyle(PhoneChoiceStyle(.secondary)).disabled(true)
                Text(PhoneMessages.panelFailingLooking()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
            } else {
                button(PhoneMessages.panelFailingAsk(), .askFirstmate)
            }
        case .asking(let asks), .declined(let asks):
            ForEach(Array(asks.enumerated()), id: \.offset) { _, ask in
                words(ask.state == "asking"
                      ? PhoneMessages.panelIntegrationAsking(action: Self.lowerFirst(ask.label), place: ask.place)
                      : PhoneMessages.panelIntegrationDeclined(action: Self.lowerFirst(ask.label), place: ask.place))
                button(PhoneMessages.panelIntegrationAskAgain(), .askAgain(integration: ask.integration, action: ask.action))
            }
        case .paused(let asked):
            words(PhoneMessages.panelBackgroundPaused())
            Button(PhoneMessages.panelBackgroundUpdate()) { press(.update) }
                .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(asked || pressing(.update))
        }
    }

    private func words(_ text: String) -> some View {
        Text(text).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func button(_ label: String, _ what: PhonePanelStatusPress) -> some View {
        Button(label) { press(what) }.buttonStyle(PhoneChoiceStyle(.secondary)).disabled(pressing(what))
            .accessibilityIdentifier(what.key("panel-status-\(panel.id)"))
    }

    static func failingLine(_ row: PhonePanel.FailingRead) -> String {
        let time = PhonePanelStatusMark.since(row.since)
        return row.read.kind == "background"
            ? PhoneMessages.panelFailingJob(count: row.tries, job: row.read.task ?? "", time: time)
            : PhoneMessages.panelFailingPlace(count: row.tries, place: row.read.place ?? "", time: time)
    }

    static func lowerFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.lowercased() + text.dropFirst()
    }
}
