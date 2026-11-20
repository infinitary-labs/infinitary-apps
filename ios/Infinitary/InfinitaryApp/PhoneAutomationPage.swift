import InfinitaryKit
import SwiftUI

/// Settings → Automation on the phone: each rule with its state, schedule and next run in the computer's words, and
/// the computer's own Pause, Resume and Pause all. A rule opens to what it is and what it ran; a draft turns on after
/// the computer's review. Making, changing and deleting a rule stay on the computer.
struct PhoneAutomationView: View {
    let page: PhoneAutomationPage
    let settings: PhoneSettings
    let open: (String) -> Void
    let review: (String) -> Void
    let back: () -> Void
    @State private var confirmingPauseAll = false

    private var stops: [PhoneStop] {
        page.rules.flatMap { rule in
            [PhoneStop(id: "rule-\(rule.id)", press: { open(rule.id) })]
                + (rule.action.map { action in [PhoneStop(id: "rule-action-\(rule.id)", press: { act(rule.id, action) })] } ?? [])
        } + (page.rules.isEmpty ? [] : [PhoneStop(id: "pause-all", press: { if canPauseAll { confirmingPauseAll = true } })])
    }

    private var canPauseAll: Bool { page.pauseAll.enabled && settings.canChange && !settings.changing.contains("pause-all") }

    var body: some View {
        PhoneStopsPage(stops: stops, back: back) { ring in
            PhoneNoteLine(page.lead)
            if let unreadable = page.unreadable {
                PhoneNoteLine(unreadable, color: PhoneTheme.warning).accessibilityIdentifier("automation-unreadable")
            }
            if let empty = page.empty {
                PhoneNoteLine(empty, color: PhoneTheme.muted).accessibilityIdentifier("automation-empty")
            }
            if !page.rules.isEmpty {
                PhoneList {
                    ForEach(page.rules) { rule in
                        Button { open(rule.id) } label: { label(rule) }
                            .buttonStyle(PhoneRowStyle()).phoneStop("rule-\(rule.id)", ring)
                            .accessibilityIdentifier("automation-rule-\(rule.id)")
                            // The rule's one action is drawn over the room its row keeps for it, so the rest of the
                            // row still opens the rule.
                            .overlay(alignment: .bottomTrailing) {
                                if let action = rule.action {
                                    choice(rule, action)
                                        .phoneStop("rule-action-\(rule.id)", ring)
                                        .accessibilityIdentifier("automation-\(action.id)-\(rule.id)")
                                        .padding(.trailing, PhoneTheme.space4).padding(.bottom, PhoneTheme.space3 - Self.touchMargin)
                                }
                            }
                    }
                }
                PhoneChoiceRow {
                    Button(page.pauseAll.label) { confirmingPauseAll = true }
                        .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(!canPauseAll)
                        .phoneStop("pause-all", ring)
                        .accessibilityIdentifier("automation-pause-all")
                }
                .confirmationDialog(page.pauseAll.ask, isPresented: $confirmingPauseAll, titleVisibility: .visible) {
                    Button(page.pauseAll.label) { Task { await settings.pauseAll() } }
                        .accessibilityIdentifier("automation-pause-all-confirm")
                }
            }
            PhoneProblemLine(problem: settings.problem)
            PhoneNoteLine(page.foot).accessibilityIdentifier("automation-foot")
        }
    }

    /// How far a choice's touch area reaches past its drawn shape, above and below.
    private static let touchMargin = (44 - PhoneChoiceRow.drawnHeight) / 2

    /// A rule's row: its name across the whole width, then its schedule over its next run or its state, with room
    /// beside those two lines for its one action.
    private func label(_ rule: PhoneAutomationPage.Rule) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2 / 2) {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                PhoneDot(tone: rule.tone).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 3 }
                Text(rule.title).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: PhoneTheme.space2)
                // The chevron sits level with the middle of the name's capitals.
                PhoneSymbol.rowChevron.foregroundStyle(PhoneTheme.muted).accessibilityHidden(true)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            }
            HStack(alignment: .center, spacing: PhoneTheme.space3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(rule.when).foregroundStyle(PhoneTheme.secondary)
                    next(rule.next)
                }
                .font(PhoneFont.caption).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                // The room the action's drawn shape takes, so every row keeps one gap under its name; the action
                // itself is drawn over it, outside this button, with its touch area reaching past that room.
                if let action = rule.action {
                    choice(rule, action).hidden().allowsHitTesting(false).accessibilityHidden(true)
                        .padding(.vertical, -Self.touchMargin)
                }
            }
            // The two lines start under the name, past the dot.
            .padding(.leading, 8 + PhoneTheme.space2)
        }
        .multilineTextAlignment(.leading)
        .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }

    /// The next run beside its term, or under it when a date with its time zone is too long for the line; a rule
    /// with no next run says its state alone.
    @ViewBuilder private func next(_ next: PhoneAutomationPage.Next) -> some View {
        let value = Text(next.value).foregroundStyle(PhoneTheme.secondary)
        if let term = next.term {
            let term = Text(term).foregroundStyle(PhoneTheme.muted)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2 / 2) { term; value }.lineLimit(1)
                VStack(alignment: .leading, spacing: 2) { term; value }
            }
        } else {
            value
        }
    }

    private func choice(_ rule: PhoneAutomationPage.Rule, _ action: PhoneRuleAction) -> some View {
        Button(action.label) { act(rule.id, action) }
            .buttonStyle(PhoneChoiceStyle(action.id == "review" ? .primary : .secondary))
            .disabled(!settings.canChange || settings.changing.contains(rule.id))
    }

    private func act(_ id: String, _ action: PhoneRuleAction) {
        guard settings.canChange, !settings.changing.contains(id) else { return }
        if action.id == "review" { review(id) } else { Task { await settings.setRule(id, action.id) } }
    }
}

/// One automation: its state, what it is as the computer lists it, the prompt as the first mate gets it, its one
/// action and what it ran.
struct PhoneRuleView: View {
    let page: PhoneRulePage
    let settings: PhoneSettings
    let review: () -> Void
    let back: () -> Void
    @State private var shownPrompts: Set<Int> = []
    @Environment(\.layoutDirection) private var layoutDirection

    private var stops: [PhoneStop] {
        (page.action.map { action in [PhoneStop(id: "action", press: { act(action) })] } ?? [])
            + page.history.runs.map { run in PhoneStop(id: "run-\(run.id)", press: { toggle(run.id) }) }
    }

    var body: some View {
        PhoneStopsPage(stops: stops, back: back) { ring in
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                PhonePageName(page.title)
                HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                    PhoneDot(tone: page.tone).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 2 }
                    Text(page.state).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
                        .accessibilityIdentifier("rule-state")
                }
                ForEach(page.notes, id: \.self) { note in PhoneNoteLine(note) }
            }
            PhoneFacts(facts: page.facts, name: "rule")
            if let action = page.action {
                PhoneChoiceRow {
                    Button(action.label) { act(action) }
                        .buttonStyle(PhoneChoiceStyle(action.id == "pause" ? .secondary : .primary))
                        .disabled(!settings.canChange || settings.changing.contains(page.id))
                        .phoneStop("action", ring)
                        .accessibilityIdentifier("rule-\(action.id)")
                }
            }
            PhoneProblemLine(problem: settings.problem)
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                PhoneSectionLabel(page.history.title)
                if page.history.runs.isEmpty {
                    if page.history.read {
                        PhoneNoteLine(page.history.empty, color: PhoneTheme.muted).accessibilityIdentifier("rule-history-empty")
                    }
                } else {
                    PhoneList {
                        ForEach(page.history.runs) { run in
                            self.run(run).phoneStop("run-\(run.id)", ring)
                                .accessibilityElement(children: .contain).accessibilityIdentifier("rule-run-\(run.id)")
                        }
                    }
                }
            }
            PhoneNoteLine(page.foot)
        }
    }

    private func run(_ run: PhoneRulePage.Run) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2 / 2) {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                PhoneDot(tone: run.tone).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 3 }
                Text(run.state).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
            }
            Text(run.line).font(PhoneFont.data).foregroundStyle(PhoneTheme.secondary)
            if let note = run.note {
                Text(note).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !run.led.isEmpty {
                Text(page.history.ledTo).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted).padding(.top, 2)
                ForEach(run.led, id: \.self) { led in
                    Text(led).font(PhoneFont.caption).foregroundStyle(PhoneTheme.text).fixedSize(horizontal: false, vertical: true)
                }
            }
            Button { toggle(run.id) } label: {
                HStack(spacing: PhoneTheme.space2) {
                    // The chevron points the way a line reads, so it turns down clockwise left to right and the other way right to left.
                    PhoneSymbol.rowChevron.rotationEffect(.degrees(shownPrompts.contains(run.id) ? (layoutDirection == .rightToLeft ? -90 : 90) : 0))
                    Text(run.promptTitle)
                }
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                .frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("rule-run-prompt-\(run.id)")
            if shownPrompts.contains(run.id) {
                Text(run.prompt).font(PhoneFont.data).foregroundStyle(PhoneTheme.text)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading)
                    .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
            }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func toggle(_ id: Int) {
        if shownPrompts.contains(id) { shownPrompts.remove(id) } else { shownPrompts.insert(id) }
    }

    private func act(_ action: PhoneRuleAction) {
        guard settings.canChange, !settings.changing.contains(page.id) else { return }
        if action.id == "review" { review() } else { Task { await settings.setRule(page.id, action.id) } }
    }
}

/// The computer's review before a draft turns on: when it runs, where, its next runs and the prompt the first mate
/// gets, in the review's own words. Turn on saves it through the computer's own action; Back leaves it a draft.
struct PhoneRuleReviewView: View {
    let page: PhoneRulePage
    let review: PhoneRulePage.Review
    let settings: PhoneSettings
    let back: () -> Void

    private var canTurnOn: Bool { review.canTurnOn && settings.canChange && !settings.changing.contains(page.id) }

    var body: some View {
        PhoneStopsPage(stops: [PhoneStop(id: "back", press: back), PhoneStop(id: "turn-on", press: turnOn)], back: back) { ring in
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                PhonePageName(review.title)
                Text(page.title).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("review-rule")
            }
            PhoneFacts(facts: review.facts, name: "review")
            PhoneChoiceRow {
                Button(review.back, action: back).buttonStyle(PhoneChoiceStyle(.secondary))
                    .phoneStop("back", ring).accessibilityIdentifier("review-back")
                Button(review.turnOn, action: turnOn).buttonStyle(PhoneChoiceStyle(.primary)).disabled(!canTurnOn)
                    .phoneStop("turn-on", ring).accessibilityIdentifier("review-turn-on")
            }
            PhoneProblemLine(problem: settings.problem)
        }
    }

    private func turnOn() {
        guard canTurnOn else { return }
        Task { if await settings.turnOn() { back() } }
    }
}
