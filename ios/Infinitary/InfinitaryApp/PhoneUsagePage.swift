import InfinitaryKit
import SwiftUI

/// Settings → Usage on the phone: the period's total, its days, its models and where it went, in the computer's own
/// figures and words. It only shows; the period and the unit are the two things a person changes here, and neither
/// changes anything on the computer.
struct PhoneUsageView: View {
    let page: PhoneUsagePage
    let settings: PhoneSettings
    let back: () -> Void

    private var stops: [PhoneStop] {
        [
            PhoneStop(id: "period", step: { offset in
                if let next = PhonePills.step(page.periods, from: page.period, by: offset) { Task { await settings.setUsage(period: next) } }
            }),
            PhoneStop(id: "unit", step: { offset in
                if let next = PhonePills.step(page.units, from: page.unit, by: offset) { settings.setUsage(unit: next) }
            }),
        ] + (page.empty == nil ? ["readouts", "daily", "models", "where"] : []).map { PhoneStop(id: $0) } + [PhoneStop(id: "milestone")]
    }

    var body: some View {
        PhoneStopsPage(stops: stops, back: back) { ring in
            VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                PhonePills(name: "Period", choices: page.periods, value: page.period) { period in
                    Task { await settings.setUsage(period: period) }
                }
                .phoneStop("period", ring, outset: 3).accessibilityIdentifier("usage-period")
                PhonePills(name: "Unit", choices: page.units, value: page.unit) { settings.setUsage(unit: $0) }
                    .phoneStop("unit", ring, outset: 3).accessibilityIdentifier("usage-unit")
                Text(page.label).font(PhoneFont.data).foregroundStyle(PhoneTheme.muted).accessibilityIdentifier("usage-label")
            }
            if let empty = page.empty {
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    Text(empty.title).font(PhoneFont.headline)
                    PhoneNoteLine(empty.line)
                }
                .accessibilityElement(children: .combine).accessibilityIdentifier("usage-empty")
            } else {
                readouts.phoneStop("readouts", ring, outset: 4)
                daily.phoneStop("daily", ring, outset: 4)
                models.phoneStop("models", ring, outset: 4)
                places.phoneStop("where", ring, outset: 4)
            }
            VStack(alignment: .leading, spacing: PhoneTheme.space2 / 2) {
                Text(page.milestone.title).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text)
                Text(page.milestone.note).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .phoneStop("milestone", ring, outset: 4).accessibilityElement(children: .combine).accessibilityIdentifier("usage-milestone")
            PhoneNoteLine(page.foot).accessibilityIdentifier("usage-foot")
        }
    }

    private var readouts: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space3) {
            if let total = page.readouts.first {
                VStack(alignment: .leading, spacing: 2) {
                    Text(total.label).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    Text(total.value).font(PhoneFont.display).foregroundStyle(PhoneTheme.text)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text(total.note).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                }
                .accessibilityElement(children: .combine).accessibilityIdentifier("usage-total")
            }
            // The two tiles stand as tall as the taller one, so a note that wraps in one leaves them level.
            HStack(alignment: .top, spacing: PhoneTheme.space3) {
                ForEach(page.readouts.dropFirst()) { readout in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(readout.label).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                        Text(readout.value).font(PhoneFont.title).foregroundStyle(PhoneTheme.text)
                        Text(readout.note).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(PhoneTheme.space3).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(PhoneTheme.panel, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
                    .overlay { RoundedRectangle(cornerRadius: PhoneTheme.controlRadius).strokeBorder(PhoneTheme.line) }
                    .accessibilityElement(children: .combine)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One bar a day against the period's largest day, today last and lighter because it is still filling.
    private var daily: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            HStack(alignment: .firstTextBaseline) {
                PhoneSectionLabel(page.daily.title)
                Spacer(minLength: PhoneTheme.space3)
                Text(page.daily.note).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
            }
            Text(page.daily.peak).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
            Canvas { context, size in
                let bars = page.daily.bars
                guard !bars.isEmpty else { return }
                let gap: CGFloat = bars.count > 60 ? 0 : 2
                let width = max(1, (size.width - gap * CGFloat(bars.count - 1)) / CGFloat(bars.count))
                context.fill(Path(CGRect(x: 0, y: size.height - 1, width: size.width, height: 1)), with: .color(PhoneTheme.line))
                for (index, bar) in bars.enumerated() where bar.share > 0 {
                    let height = max(2, (size.height - 1) * bar.share)
                    let rect = CGRect(x: CGFloat(index) * (width + gap), y: size.height - 1 - height, width: width, height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: min(2, width / 2)),
                                 with: .color(PhoneTheme.accent.opacity(index == bars.count - 1 ? 0.45 : 1)))
                }
            }
            .frame(height: 72).accessibilityHidden(true)
            HStack {
                Text(page.daily.first)
                Spacer(minLength: PhoneTheme.space3)
                Text(page.daily.last)
            }
            .font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("usage-daily")
    }

    private var models: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            PhoneSectionLabel(page.models.title)
            PhoneList {
                ForEach(page.models.rows) { model in
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.name).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                            Text(model.line).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Text(model.value).font(PhoneFont.data).foregroundStyle(PhoneTheme.text)
                    }
                    .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("usage-model-\(model.id)")
                }
            }
        }
    }

    private var places: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            PhoneSectionLabel(page.where.title)
            PhoneList {
                ForEach(page.where.rows) { place in
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                        Text(place.name).font(place.depth == 0 ? PhoneFont.body : PhoneFont.callout)
                            .foregroundStyle(place.depth == 0 ? PhoneTheme.text : PhoneTheme.secondary)
                            .padding(.leading, place.depth == 0 ? 0 : PhoneTheme.space4)
                        Spacer(minLength: 0)
                        Text(place.value).font(PhoneFont.data).foregroundStyle(place.depth == 0 ? PhoneTheme.text : PhoneTheme.secondary)
                    }
                    .padding(.horizontal, PhoneTheme.space4).padding(.vertical, place.depth == 0 ? PhoneTheme.space3 : PhoneTheme.space2)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("usage-where-\(place.id)")
                }
            }
            Text(page.where.legend).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
