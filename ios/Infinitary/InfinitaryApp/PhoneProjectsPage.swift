import InfinitaryKit
import SwiftUI

/// Settings → Projects on the phone: each project, with how it differs from a new one in the computer's row words.
/// Adding or removing a project, and its folder, need the computer and stay there.
struct PhoneProjectsView: View {
    let page: PhoneProjectsPage
    let open: (String) -> Void
    let back: () -> Void

    /// The projects the Settings row counts, then the personal workspace in a list of its own: it is not one of the
    /// counted projects, so the count reads as the first list's rows.
    private var groups: [[PhoneProjectsPage.Project]] {
        [page.projects.filter { !$0.personal }, page.projects.filter(\.personal)].filter { !$0.isEmpty }
    }

    var body: some View {
        PhoneStopsPage(stops: groups.joined().map { project in PhoneStop(id: "project-\(project.id)", press: { open(project.id) }) }, back: back) { ring in
            if let empty = page.empty {
                PhoneNoteLine(empty, color: PhoneTheme.muted).accessibilityIdentifier("projects-empty")
            }
            ForEach(groups, id: \.first?.id) { group in
                PhoneList {
                    ForEach(group) { project in
                        Button { open(project.id) } label: {
                            HStack(spacing: PhoneTheme.space3) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(project.name).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                                    if !project.line.isEmpty {
                                        Text(project.line).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                                    }
                                }
                                .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                                PhoneSymbol.rowChevron.foregroundStyle(PhoneTheme.muted).accessibilityHidden(true)
                            }
                            .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(PhoneRowStyle()).phoneStop("project-\(project.id)", ring)
                        .accessibilityIdentifier("project-\(project.id)")
                    }
                }
            }
            PhoneNoteLine(page.foot).accessibilityIdentifier("projects-foot")
        }
    }
}

/// One project's standing choices, the ones its row on the computer holds: where its changes go, whether it asks
/// before merging, its rigor and its cost limit. Each saves through the computer's own project settings as it is
/// chosen, and reads back what the computer kept.
struct PhoneProjectView: View {
    let project: PhoneProjectsPage.Project
    let settings: PhoneSettings
    let back: () -> Void
    @State private var amount = ""
    @State private var choseAmount = false
    @FocusState private var amountFocused: Bool

    private var waiting: Bool { settings.changing.contains(project.id) }
    private var canChange: Bool { settings.canChange && !waiting }

    private var stops: [PhoneStop] {
        var stops: [PhoneStop] = []
        if project.delivery.fixed == nil {
            stops += project.delivery.choices.map { choice in PhoneStop(id: "delivery-\(choice.value)", press: { choose(delivery: choice.value) }) }
        }
        if !project.asks.fixed { stops.append(PhoneStop(id: "asks", press: { setAsks(!project.asks.asksFirst) })) }
        if project.rigor.fixed == nil {
            stops.append(PhoneStop(id: "rigor", step: { offset in
                if let next = PhonePills.step(project.rigor.choices, from: project.rigor.value, by: offset) { choose(rigor: next) }
            }))
        }
        if let cost = project.cost {
            stops.append(PhoneStop(id: "cost", step: { offset in
                if let next = PhonePills.step(cost.choices, from: cost.value, by: offset) { choose(cost: next, cost) }
            }))
            if cost.value == "amount" { stops.append(PhoneStop(id: "amount", press: { amountFocused = true })) }
        }
        return stops
    }

    var body: some View {
        // Choosing an amount of its own uncovers the amount under the choice, at the page's foot.
        PhoneStopsPage(stops: stops, active: !amountFocused, uncovered: choseAmount && project.cost?.value == "amount" ? "amount" : nil,
                       back: back) { ring in
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                PhonePageName(project.name)
                if let path = project.path {
                    Text(path).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("project-path")
                }
            }
            delivery(ring)
            asks(ring)
            rigor(ring)
            if let cost = project.cost { self.cost(cost, ring) }
            PhoneProblemLine(problem: settings.problem)
        }
        .onChange(of: project.cost?.usd, initial: true) { _, usd in if let usd, !amountFocused { amount = Self.words(usd) } }
    }

    private func heading(_ title: String, _ description: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(PhoneFont.headline)
            Text(description).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func delivery(_ ring: PhoneStopRing) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            heading(project.delivery.title, project.delivery.description)
            if let fixed = project.delivery.fixed {
                Text(fixed).font(PhoneFont.callout).foregroundStyle(PhoneTheme.muted)
            } else {
                PhoneList {
                    ForEach(project.delivery.choices) { choice in
                        Button { choose(delivery: choice.value) } label: {
                            HStack(spacing: PhoneTheme.space3) {
                                Text(choice.label).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                                Spacer(minLength: 0)
                                PhoneRadio(on: choice.value == project.delivery.value)
                            }
                            .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(PhoneRowStyle()).disabled(!canChange)
                        .phoneStop("delivery-\(choice.value)", ring)
                        .accessibilityAddTraits(choice.value == project.delivery.value ? .isSelected : [])
                        .accessibilityIdentifier("project-delivery-\(choice.value)")
                    }
                }
            }
            ForEach(project.notes, id: \.text) { note in
                Text(note.text).font(PhoneFont.caption).foregroundStyle(note.warn ? PhoneTheme.warning : PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func asks(_ ring: PhoneStopRing) -> some View {
        HStack(alignment: .center, spacing: PhoneTheme.space3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.asks.title).font(PhoneFont.headline)
                Text(project.asks.label).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
                    .accessibilityIdentifier("project-asks-label")
                Text(project.asks.description).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("project-asks-words")
            }
            Spacer(minLength: 0)
            if !project.asks.fixed {
                Toggle(project.asks.title, isOn: Binding(get: { project.asks.asksFirst }, set: { setAsks($0) }))
                    .labelsHidden().tint(PhoneTheme.accent).disabled(!canChange)
                    .accessibilityIdentifier("project-asks")
                    // The switch is drawn a little past its own frame; this keeps it inside the page's edge.
                    .padding(.trailing, 3)
            }
        }
        .phoneStop("asks", ring, outset: 4)
    }

    private func rigor(_ ring: PhoneStopRing) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            heading(project.rigor.title, project.rigor.description)
            if let fixed = project.rigor.fixed {
                Text(fixed).font(PhoneFont.callout).foregroundStyle(PhoneTheme.muted)
            } else {
                PhonePills(name: project.rigor.title, choices: project.rigor.choices, value: project.rigor.value, enabled: canChange) { choose(rigor: $0) }
                    .phoneStop("rigor", ring, outset: 3).accessibilityIdentifier("project-rigor")
            }
        }
    }

    private func cost(_ cost: PhoneProjectsPage.Cost, _ ring: PhoneStopRing) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            heading(cost.title, cost.description)
            PhonePills(name: cost.title, choices: cost.choices, value: cost.value, enabled: canChange) { choose(cost: $0, cost) }
                .phoneStop("cost", ring, outset: 3).accessibilityIdentifier("project-cost")
            if cost.value == "amount" {
                HStack(spacing: PhoneTheme.space2) {
                    Text("$").font(PhoneFont.body).foregroundStyle(PhoneTheme.muted)
                    TextField(cost.amountLabel, text: $amount)
                        .textFieldStyle(.phone).keyboardType(Self.amountKeys).focused($amountFocused)
                        .frame(maxWidth: 140).disabled(!canChange)
                        .onSubmit { save(cost) }
                        .accessibilityLabel(cost.amountLabel).accessibilityIdentifier("project-cost-amount")
                    Spacer(minLength: 0)
                    // A phone's decimal pad has no Return, so the amount has its own way to be saved.
                    Button(cost.save) { save(cost) }
                        .buttonStyle(PhoneChoiceStyle(.secondary)).disabled(!canChange || entered == nil || entered == cost.usd)
                        .accessibilityIdentifier("project-cost-save")
                }
                .phoneStop("amount", ring, outset: 3)
            }
        }
    }

    /// An iPad shows a decimal pad as a popover beside the field, and a tap outside a popover only closes it, so the first
    /// tap on Save would save nothing. An iPad types the amount on its full keyboard's numbers, where Return saves too.
    private static var amountKeys: UIKeyboardType {
        UIDevice.current.userInterfaceIdiom == .pad ? .numbersAndPunctuation : .decimalPad
    }

    /// The amount as typed, when it is one the computer takes: more than nothing.
    private var entered: Double? {
        guard let usd = Double(amount.replacingOccurrences(of: ",", with: ".")), usd.isFinite, usd > 0 else { return nil }
        return usd
    }

    private static func words(_ usd: Double) -> String {
        usd == usd.rounded() ? String(Int(usd)) : String(usd)
    }

    private func choose(delivery: String) {
        guard canChange, delivery != project.delivery.value else { return }
        Task { await settings.configure(project.id, ["delivery": delivery]) }
    }

    private func setAsks(_ asksFirst: Bool) {
        guard canChange, !project.asks.fixed, asksFirst != project.asks.asksFirst else { return }
        Task { await settings.configure(project.id, ["autonomy": !asksFirst]) }
    }

    private func choose(rigor: String) {
        guard canChange, rigor != project.rigor.value else { return }
        Task { await settings.configure(project.id, ["rigor": rigor]) }
    }

    private func choose(cost value: String, _ cost: PhoneProjectsPage.Cost) {
        guard canChange, value != cost.value else { return }
        choseAmount = value == "amount"
        let limit: Any = value == "follow" ? NSNull() : value == "none" ? ["none": true] : ["usd": cost.usd]
        Task { await settings.configure(project.id, ["costLimit": limit]) }
    }

    private func save(_ cost: PhoneProjectsPage.Cost) {
        amountFocused = false
        guard canChange, let usd = entered, usd != cost.usd else { amount = Self.words(cost.usd); return }
        Task { await settings.configure(project.id, ["costLimit": ["usd": usd]]) }
    }
}

/// One choice's mark in a list where exactly one is chosen.
private struct PhoneRadio: View {
    let on: Bool
    var body: some View {
        Circle().strokeBorder(on ? PhoneTheme.accent : PhoneTheme.lineStrong, lineWidth: 1.5)
            .overlay { if on { Circle().fill(PhoneTheme.accent).padding(4.5) } }
            .frame(width: 20, height: 20).accessibilityHidden(true)
    }
}
