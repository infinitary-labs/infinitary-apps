import InfinitaryKit
import SwiftUI

/// Settings → Runbooks on the phone: the crew's guidance, built in and the person's own, each with the computer's own
/// switch. Writing a runbook and opening its folder need the computer and stay there.
struct PhoneRunbooksView: View {
    let page: PhoneRunbooksPage
    let settings: PhoneSettings
    let back: () -> Void

    private var stops: [PhoneStop] {
        page.groups.flatMap { group in
            group.books.map { book in PhoneStop(id: "runbook-\(book.id)", press: { set(book, !book.enabled) }) }
        }
    }

    var body: some View {
        PhoneStopsPage(stops: stops, back: back) { ring in
            PhoneNoteLine(page.lead)
            ForEach(page.groups) { group in
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    PhoneSectionLabel(group.label)
                    if let empty = group.empty {
                        PhoneNoteLine(empty, color: PhoneTheme.muted).accessibilityIdentifier("runbooks-empty-\(group.id)")
                    }
                    if !group.books.isEmpty {
                        PhoneList {
                            ForEach(group.books) { book in row(book).phoneStop("runbook-\(book.id)", ring) }
                        }
                    }
                }
                .accessibilityElement(children: .contain).accessibilityIdentifier("runbooks-group-\(group.id)")
            }
            PhoneProblemLine(problem: settings.problem)
            PhoneNoteLine(page.foot).accessibilityIdentifier("runbooks-foot")
        }
    }

    private func row(_ book: PhoneRunbooksPage.Book) -> some View {
        HStack(alignment: .center, spacing: PhoneTheme.space3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(book.name).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                if !book.description.isEmpty {
                    Text(book.description).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let error = book.error {
                    Text(error).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("runbook-error-\(book.id)")
                }
            }
            Spacer(minLength: 0)
            Toggle(book.name, isOn: Binding(get: { book.enabled }, set: { set(book, $0) }))
                .labelsHidden().tint(PhoneTheme.accent)
                .disabled(!settings.canChange || settings.changing.contains(book.id))
                .accessibilityIdentifier("runbook-\(book.id)")
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    private func set(_ book: PhoneRunbooksPage.Book, _ on: Bool) {
        guard settings.canChange, !settings.changing.contains(book.id), on != book.enabled else { return }
        Task { await settings.setRunbook(book.id, on: on) }
    }
}
