import InfinitaryKit
import SwiftUI

/// One keyboard stop of a Settings page (docs/ios.md, "Settings pages in the computer's words"): a row or a control
/// the ring rests on. Return or Space presses it; the left and right arrows step it where it holds a choice.
struct PhoneStop {
    let id: String
    var press: (() -> Void)?
    var step: ((Int) -> Void)?
}

/// Where the ring is, handed to a page's rows; nowhere until a key is pressed.
struct PhoneStopRing: Equatable {
    let at: String?
}

/// A Settings page with its keys: the up and down arrows and Tab walk its stops in order and keep the one under the
/// ring in view, Return or Space presses it, the left and right arrows step it, and Esc goes back one page.
/// `active` is false while a text field on the page holds the keyboard.
/// `uncovered` names a stop the person's own choice on the page has just uncovered: the page brings it into view as
/// it appears, the way the arrows do, since a sheet shorter than the page would uncover it out of sight.
struct PhoneStopsPage<Content: View>: View {
    let stops: [PhoneStop]
    var active = true
    var uncovered: String?
    let back: () -> Void
    @ViewBuilder let content: (PhoneStopRing) -> Content
    @State private var at: String?
    @State private var browsing = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space5) { content(PhoneStopRing(at: browsing ? at : nil)) }
                    .padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
            }
            // The page reuses the scene's native keyboard owner, as the Settings list does.
            .background(PhoneBrowsingKeys(active: active, returnOpens: true) { key in
                switch key {
                case .up: move(-1, proxy)
                case .down, .next: move(1, proxy)
                case .open: if browsing { current?.press?() }
                case .left: if browsing { current?.step?(-1) }
                case .right: if browsing { current?.step?(1) }
                case .stop: back()
                }
            })
            .onChange(of: uncovered) { _, stop in if let stop { show(stop, proxy) } }
        }
    }

    private var current: PhoneStop? { stops.first { $0.id == at } }

    private func move(_ offset: Int, _ proxy: ScrollViewProxy) {
        guard !stops.isEmpty else { return }
        let index = stops.firstIndex { $0.id == at }
        let next = browsing ? min(max((index ?? -1) + offset, 0), stops.count - 1) : index ?? 0
        browsing = true
        at = stops[next].id
        show(stops[next].id, proxy)
    }

    private func show(_ stop: String, _ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: PhoneTheme.fadeSeconds)) { proxy.scrollTo(stop, anchor: .center) }
    }
}

extension View {
    /// Marks a keyboard stop: the ring is drawn around it while the keyboard rests there, and arrows bring it into view.
    func phoneStop(_ id: String, _ ring: PhoneStopRing, outset: CGFloat = 0) -> some View {
        overlay {
            if ring.at == id {
                RoundedRectangle(cornerRadius: PhoneTheme.controlRadius)
                    .strokeBorder(PhoneTheme.accent, lineWidth: 1.5).padding(-outset)
                    .accessibilityIdentifier("phone-settings-ring-\(id)")
            }
        }
        .id(id)
    }
}

/// The computer's status dot (the design skill's StatusDot): one small dot a row, a hollow ring for nothing read yet.
struct PhoneDot: View {
    let tone: PhoneDotTone

    var body: some View {
        Circle().fill(tone == .ring ? Color.clear : Self.color(tone))
            .overlay { if tone == .ring { Circle().strokeBorder(PhoneTheme.secondary, lineWidth: 1) } }
            .frame(width: 8, height: 8).accessibilityHidden(true)
    }

    static func color(_ tone: PhoneDotTone) -> Color {
        switch tone {
        case .ok: PhoneTheme.ok
        case .warn: PhoneTheme.warning
        case .danger: PhoneTheme.danger
        case .idle, .ring: PhoneTheme.idle
        case .busy: PhoneTheme.hot
        case .captain: PhoneTheme.captain
        }
    }
}

/// A group's label above its rows, as the Mac draws a section label.
struct PhoneSectionLabel: View {
    let words: String
    init(_ words: String) { self.words = words }
    var body: some View {
        Text(words).font(PhoneFont.micro).textCase(.uppercase).tracking(1).foregroundStyle(PhoneTheme.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A quiet line under a page or a group: what it is, or where the rest is done.
struct PhoneNoteLine: View {
    let words: String
    var color = PhoneTheme.secondary
    init(_ words: String, color: Color = PhoneTheme.secondary) { self.words = words; self.color = color }
    var body: some View {
        Text(words).font(PhoneFont.callout).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
    }
}

/// The name a page under a section leads with: a rule's, a project's, or a review's question. It wraps, so a long
/// name is read whole where the top bar would cut it short.
struct PhonePageName: View {
    let words: String
    init(_ words: String) { self.words = words }
    var body: some View {
        Text(words).font(PhoneFont.title).foregroundStyle(PhoneTheme.text).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("phone-settings-page-name")
    }
}

/// A page's facts as the computer lists them: each term over its value, the prompt in its own box, and a value that
/// is a list one entry a line.
struct PhoneFacts: View {
    let facts: [PhoneFact]
    var name = "fact"

    var body: some View {
        PhoneList {
            ForEach(facts) { fact in
                VStack(alignment: .leading, spacing: PhoneTheme.space2 / 2) {
                    Text(fact.term).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    if fact.prompt == true {
                        Text(fact.value).font(PhoneFont.data).foregroundStyle(PhoneTheme.text)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            .padding(PhoneTheme.space3).frame(maxWidth: .infinity, alignment: .leading)
                            .background(PhoneTheme.surface, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
                    } else {
                        ForEach(fact.lines ?? [fact.value], id: \.self) { line in
                            Text(line).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(fact.prompt == true ? "\(name)-prompt" : "")
            }
        }
    }
}

/// A short set of choices in Apple's segmented control, as Appearance draws Theme: the computer's pills on a phone.
struct PhonePills: View {
    let name: String
    let choices: [PhoneChoice]
    let value: String
    var enabled = true
    let choose: (String) -> Void

    var body: some View {
        Picker(name, selection: Binding(get: { value }, set: { if $0 != value { choose($0) } })) {
            ForEach(choices) { choice in Text(choice.label).tag(choice.value) }
        }
        .pickerStyle(.segmented).labelsHidden().disabled(!enabled)
    }

    /// The choice one step along, for the left and right arrows; the ends hold.
    static func step(_ choices: [PhoneChoice], from value: String, by offset: Int) -> String? {
        guard let index = choices.firstIndex(where: { $0.value == value }), choices.indices.contains(index + offset) else { return nil }
        return choices[index + offset].value
    }
}

/// Why a change did not go through, in the computer's words, under the control that asked for it.
struct PhoneProblemLine: View {
    let problem: String?
    var body: some View {
        if let problem {
            Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("phone-settings-problem")
        }
    }
}
