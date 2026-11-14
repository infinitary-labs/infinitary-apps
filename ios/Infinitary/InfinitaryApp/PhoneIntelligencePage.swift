import InfinitaryKit
import SwiftUI

/// Settings → Intelligence on the phone: every account the computer's Intelligence lists, in its order and its words,
/// grouped by the computer it is signed in on, each with its allowance windows and its one verdict. It only shows:
/// signing in, pausing and removing stay on the computer, and a row that waits for a sign-in says where.
struct PhoneIntelligenceView: View {
    let page: PhoneIntelligencePage
    let back: () -> Void

    private var stops: [PhoneStop] {
        page.groups.flatMap { group in group.rows.map { PhoneStop(id: Self.stop(group, $0)) } }
    }

    private static func stop(_ group: PhoneIntelligencePage.Group, _ row: PhoneIntelligencePage.Row) -> String {
        "account-\(group.id)-\(row.id)"
    }

    var body: some View {
        PhoneStopsPage(stops: stops, back: back) { ring in
            HStack(alignment: .firstTextBaseline) {
                Text(page.summary).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("intelligence-summary")
                Spacer(minLength: PhoneTheme.space3)
                if let asOf = page.asOf {
                    Text(asOf).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted).accessibilityIdentifier("intelligence-as-of")
                }
            }
            ForEach(page.groups) { group in
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    if let label = group.label {
                        HStack(alignment: .firstTextBaseline) {
                            PhoneSectionLabel(label)
                            Spacer(minLength: PhoneTheme.space3)
                            if let note = group.note {
                                Text(note).font(PhoneFont.micro).foregroundStyle(PhoneTheme.warning)
                                    .accessibilityIdentifier("intelligence-away-\(group.id)")
                            }
                        }
                    }
                    if let line = group.line {
                        Text(line).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let empty = group.empty {
                        PhoneNoteLine(empty, color: PhoneTheme.muted)
                    } else {
                        PhoneList {
                            ForEach(group.rows) { row in
                                PhoneAccountRow(row: row).phoneStop(Self.stop(group, row), ring)
                                    .accessibilityElement(children: .contain)
                                    .accessibilityIdentifier("intelligence-account-\(row.id)")
                            }
                        }
                    }
                }
                .accessibilityElement(children: .contain).accessibilityIdentifier("intelligence-group-\(group.id)")
            }
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                ForEach(page.marks, id: \.mark) { mark in
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        PhoneAccountMark(mark: mark.mark)
                        Text(mark.words).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    }
                }
                PhoneNoteLine(page.foot).accessibilityIdentifier("intelligence-foot")
            }
        }
    }
}

/// A mark beside an account's name: the crew's preferred account in the accent, the first mate's as a small tag.
private struct PhoneAccountMark: View {
    let mark: String
    var body: some View {
        if mark.count == 1 {
            Text(mark).font(PhoneFont.callout).foregroundStyle(PhoneTheme.accent)
        } else {
            Text(mark).font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay { Capsule().strokeBorder(PhoneTheme.line) }
        }
    }
}

/// One account: its dot, provider and marks with the verdict opposite, who it is, then each allowance window, or
/// the one sentence a row with no window says.
private struct PhoneAccountRow: View {
    let row: PhoneIntelligencePage.Row

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                PhoneDot(tone: row.dot).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 3 }
                Text(row.provider).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                ForEach(row.marks, id: \.self) { mark in PhoneAccountMark(mark: mark) }
                Spacer(minLength: PhoneTheme.space2)
                if let verdict = row.verdict {
                    Text(verdict.text).font(PhoneFont.data).foregroundStyle(Self.tone(verdict.tone))
                        .multilineTextAlignment(.trailing).accessibilityIdentifier("intelligence-verdict-\(row.id)")
                }
            }
            Text([row.name, row.sub].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(PhoneFont.data).foregroundStyle(PhoneTheme.secondary).lineLimit(2)
            ForEach(row.meters) { meter in PhoneAllowanceMeter(meter: meter) }
            if let state = row.state {
                Text(state.text).font(PhoneFont.callout).foregroundStyle(state.danger ? PhoneTheme.danger : PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("intelligence-state-\(row.id)")
            }
            if let signIn = row.signIn {
                Text(signIn).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("intelligence-sign-in-\(row.id)")
            }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func tone(_ tone: String) -> Color {
        switch tone {
        case "ok": PhoneTheme.ok
        case "warn": PhoneTheme.warning
        case "danger": PhoneTheme.danger
        default: PhoneTheme.secondary
        }
    }
}

/// One allowance window, as the computer's micro meter: its name, how much is left as a bar and a number, where the
/// reset clock stands as a tick on the bar, and when it resets. The colors are the computer's own tones.
private struct PhoneAllowanceMeter: View {
    let meter: PhoneIntelligencePage.Meter

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: PhoneTheme.space2) {
                Text(meter.label).font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
                    .frame(width: 64, alignment: .leading).lineLimit(1).minimumScaleFactor(0.8)
                GeometryReader { box in
                    ZStack(alignment: .leading) {
                        Capsule().fill(PhoneTheme.line)
                        Capsule().fill(Self.bar(meter.bar)).frame(width: box.size.width * meter.fill / 100)
                        if let clock = meter.clock {
                            Rectangle().fill(PhoneTheme.text).frame(width: 1.5, height: 8)
                                .offset(x: min(box.size.width - 1.5, box.size.width * clock / 100))
                        }
                    }
                    .frame(height: box.size.height)
                }
                .frame(height: 4).frame(height: 8)
                Text(meter.text).font(PhoneFont.data).foregroundStyle(Self.figure(meter.figure))
                    .frame(width: 40, alignment: .trailing)
            }
            if let reset = meter.reset {
                Text(reset).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).padding(.leading, 64 + PhoneTheme.space2)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([meter.label, meter.text, meter.reset].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("intelligence-meter-\(meter.id)")
    }

    static func bar(_ token: String) -> Color {
        switch token {
        case "warn": PhoneTheme.warning
        case "accent": PhoneTheme.accent
        case "ok": PhoneTheme.ok
        case "danger": PhoneTheme.danger
        default: PhoneTheme.idle
        }
    }

    static func figure(_ token: String) -> Color {
        switch token {
        case "fg-1": PhoneTheme.text
        case "warn": PhoneTheme.warning
        case "danger": PhoneTheme.danger
        default: PhoneTheme.muted
        }
    }
}
