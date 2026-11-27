import InfinitaryKit
import SwiftUI

extension EnvironmentValues {
    /// Opens the Filter sheet, which the window that presents it supplies; with none, nothing opens.
    @Entry var phoneOpenFilter: @MainActor () -> Void = {}
}

/// INF-2820 piece 2, the captain's "Filter button": the top bar's trailing control, in the computer button's place. The
/// system's filter symbol, filled in the accent while a project is focused; the bar shows it only while the Filter has
/// two projects or more to offer (`PhoneProjectFocus.Pills.shown`).
struct PhoneFilterButton: View {
    let session: ReadOnlySession
    let open: () -> Void

    var body: some View {
        let focus = session.projectFocus
        Button(action: open) {
            Image(systemName: focus == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                .foregroundStyle(focus == nil ? PhoneTheme.text : PhoneTheme.accent)
        }
        .accessibilityLabel(PhoneMessages.phoneFilterTitle())
        .accessibilityValue(focus.flatMap { id in session.projectPills.projects.first { $0.id == id }?.name }
                            ?? PhoneMessages.shellProjectAll())
        .accessibilityIdentifier("project-filter")
    }
}

/// INF-2820 piece 2: the Filter sheet. Its Project section lists All projects, then each project the Mac's pill row
/// offers with what waits on the captain and what works, a check on the one focused; a pick applies at once and closes
/// the sheet. It opens just tall enough for its rows, never past half height, as the computer sheet did (INF-6131).
/// Sections stack in one scroller, so a Tags section can join under Project.
/// On a keyboard it opens with focus on the checked row: the arrows move, Return or Space picks and Escape closes.
struct PhoneFilterSheet: View {
    let session: ReadOnlySession
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focusedRow: String?
    /// The rows' own height, the height the scroll view shows them in, and the whole sheet's height: the sheet less the
    /// scroll view is its bar and edges, so the fitted sheet is the rows plus those.
    @State private var rows: CGFloat = 0
    @State private var shown: CGFloat = 0
    @State private var sheet: CGFloat = 0
    /// The height the sheet stands at, kept while the rows refit so a sheet pulled up stays up.
    @State private var detent = PresentationDetent.custom(PhoneFittedDetent.self)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space5) {
                    projects
                }.padding(PhoneTheme.space5).frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rows = $0 }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shown = $0 }
            .phoneTitle(PhoneMessages.phoneFilterTitle())
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(PhoneMessages.phoneCommonDone()) { dismiss() }.accessibilityIdentifier("close-project-filter")
            } }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height + $0.safeAreaInsets.top + $0.safeAreaInsets.bottom } action: { sheet = $0 }
        .font(PhoneFont.body).foregroundStyle(PhoneTheme.text).tint(PhoneTheme.accent)
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onPlainKey(.return) { pick(current) }
        .onPlainKey(.space) { pick(current) }
        .onPlainKey(.downArrow) { focusedRow = step(order, from: current, by: 1) }
        .onPlainKey(.upArrow) { focusedRow = step(order, from: current, by: -1) }
        .presentationDetents([.custom(PhoneFittedDetent.self), .large], selection: $detent).presentationDragIndicator(.visible)
        .presentationContentInteraction(.resizes)
        .environment(\.phoneSheetFit, rows > 0 && shown > 0 && sheet > shown ? rows + sheet - shown : 0).phoneSheetSurface()
    }

    private var projects: some View {
        let pills = session.projectPills
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            PhoneSectionLabel(PhoneMessages.phoneFilterProject())
            PhoneList {
                row(Self.allRow, title: PhoneMessages.shellProjectAll(), waiting: pills.waiting, working: pills.working)
                ForEach(pills.projects) { pill in
                    row(pill.id, title: pill.name, waiting: pill.waiting, working: pill.working)
                }
            }
        }
    }

    private func row(_ id: String, title: String, waiting: Int, working: Int) -> some View {
        let checked = (session.projectFocus ?? Self.allRow) == id
        let line = PhoneMessages.phoneFilterCounts(waiting: PhoneProjectFilterWords.count(waiting),
                                                   working: PhoneProjectFilterWords.count(working))
        return Button { pick(id) } label: {
            PhoneRow(title: title, line: line).overlay(alignment: .trailing) {
                if checked {
                    Image(systemName: "checkmark").font(PhoneFont.callout).foregroundStyle(PhoneTheme.accent)
                        .padding(.trailing, PhoneTheme.space4).accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(PhoneRowStyle())
        .accessibilityLabel(title).accessibilityValue(line)
        .accessibilityAddTraits(checked ? .isSelected : [])
        .accessibilityIdentifier("project-filter-\(id)")
        .focusable().focused($focusedRow, equals: id)
        // The opening focus is set from the focusable row itself, as the Settings sheet's Appearance page sets its own.
        .onAppear { if checked { focusedRow = id } }
    }

    private var order: [String] { [Self.allRow] + session.projectPills.projects.map(\.id) }

    /// The row the keys act on. The sheet's root takes the keys, as it takes Escape, because the opening focus can fail:
    /// reopened a second after a pick, the iPad's focus update found no row, and keys sent to the rows went nowhere.
    /// The checked row then stands in, so the keys still start there.
    private var current: String { focusedRow ?? session.projectFocus ?? Self.allRow }

    private func pick(_ id: String) {
        session.savedProjectFocus = id == Self.allRow ? nil : id
        dismiss()
    }

    private func step(_ rows: [String], from row: String, by offset: Int) -> String {
        guard let index = rows.firstIndex(of: row) else { return row }
        return rows[min(max(index + offset, 0), rows.count - 1)]
    }

    static let allRow = "all-projects" // i18n-exempt: a focus name, not shown
}

/// INF-2820 piece 2: while a project is focused, one row under the top bar on every tab, under the reach line: the
/// project's pill with its counts, which opens the Filter sheet; a 44-point ×, Show all projects; then how many tasks
/// wait on the captain in other projects, while any do (the Mac's tail).
struct PhoneFocusRow: View {
    let session: ReadOnlySession
    @Environment(\.phoneOpenFilter) private var openFilter

    var body: some View {
        if let focus = session.projectFocus, let pill = session.projectPills.projects.first(where: { $0.id == focus }) {
            let counts = PhoneMessages.phoneFilterCounts(waiting: PhoneProjectFilterWords.count(pill.waiting),
                                                         working: PhoneProjectFilterWords.count(pill.working))
            let elsewhere = PhoneProjectFocus.waitingElsewhere(session.projectPills, focus: focus)
            HStack(spacing: PhoneTheme.space2) {
                Button { openFilter() } label: {
                    HStack(spacing: 6) {
                        Text(pill.name).foregroundStyle(PhoneTheme.text).lineLimit(1)
                        Text(counts).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                    }.font(PhoneFont.mono)
                        .padding(.horizontal, PhoneTheme.space3).frame(minHeight: 32)
                        .overlay(Capsule().strokeBorder(PhoneTheme.accent))
                        .frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityLabel(PhoneMessages.shellProjectPillWords(name: pill.name, waiting: PhoneProjectFilterWords.count(pill.waiting),
                                                                      working: PhoneProjectFilterWords.count(pill.working)))
                    .accessibilityHint(PhoneMessages.commandProjectFocusOpen())
                    .accessibilityIdentifier("project-focus-pill")
                Button { session.savedProjectFocus = nil } label: {
                    Image(systemName: "xmark").font(PhoneFont.callout).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(PhoneTheme.muted)
                    .accessibilityLabel(PhoneMessages.shellProjectShowAll()).accessibilityIdentifier("project-focus-clear")
                if elsewhere > 0 {
                    Text(PhoneMessages.phoneFilterWaitingElsewhere(count: elsewhere)).font(PhoneFont.mono)
                        .foregroundStyle(PhoneTheme.muted).lineLimit(1).minimumScaleFactor(0.75)
                        .accessibilityIdentifier("project-focus-elsewhere")
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, PhoneTheme.space4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain).accessibilityIdentifier("project-focus-row")
        }
    }
}

enum PhoneProjectFilterWords {
    /// A count in the phone's own digits, as the Mac's pill writes it.
    static func count(_ number: Int) -> String { number.formatted(.number.locale(PhoneFormats.locale)) }
}

/// INF-6131: the Filter sheet opens just tall enough for its rows, and never past half height; before its rows are
/// measured it opens at half height.
private struct PhoneFittedDetent: CustomPresentationDetent {
    static func height(in context: Context) -> CGFloat? {
        let half = context.maxDetentValue / 2
        return context.phoneSheetFit > 0 ? min(context.phoneSheetFit, half) : half
    }
}

extension EnvironmentValues {
    /// The height the Filter sheet's rows ask for, read by its fitted detent.
    @Entry var phoneSheetFit: CGFloat = 0
}

/// What the window's project filter offers the app's commands: whether the Filter has projects to offer and one is
/// focused, how to open the sheet and how to show every project again.
struct PhoneProjectFilterActions {
    let offered: Bool
    let focused: Bool
    let open: @MainActor () -> Void
    let clear: @MainActor () -> Void
}

extension FocusedValues {
    @Entry var phoneProjectFilter: PhoneProjectFilterActions?
}

/// INF-2820 piece 2: the Mac's two project focus commands, in the View menu that holding Command on an iPad lists.
/// Focus on a project keeps the Mac's Shift-Command-P; Show all projects has no key, as on the Mac.
struct PhoneFilterCommands: Commands {
    @FocusedValue(\.phoneProjectFilter) private var filter

    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Button(PhoneMessages.commandProjectFocusOpen()) { filter?.open() }
                .keyboardShortcut("p", modifiers: [.command, .shift]).disabled(filter?.offered != true)
            Button(PhoneMessages.shellProjectShowAll()) { filter?.clear() }.disabled(filter?.focused != true)
        }
    }
}
