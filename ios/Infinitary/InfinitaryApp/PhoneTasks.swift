import InfinitaryKit
import SwiftUI

/// The record's corner changes only which local view is shown, never the task.
struct PhoneRecordLeaveButton: View {
    @Binding var record: PhoneTask?
    var body: some View {
        Button { record = nil } label: {
            Label(PhoneCardWords.recordLeave, systemImage: "minus").labelStyle(.iconOnly)
        }.frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(PhoneTheme.secondary)
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .accessibilityHint(PhoneCardWords.recordLeaveRest)
            .accessibilityIdentifier("close-record")
    }
}

struct PhoneTasks: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.verticalSizeClass) private var verticalSize
    @State private var query = ""
    @State private var searchOpen = false
    @State private var focusOnOpen = false
    @FocusState private var searchFocused: Bool
    @State private var earlier: [PhoneTask] = []
    @State private var problem: String?
    @State private var selected: PhoneTask?
    /// The folding groups, Backlog and Done, the captain opened; the Mac's other groups always show their rows.
    @State private var expanded: Set<PhoneTaskList.Section> = []

    /// INF-2764: whether this list is on screen. The tab controller keeps a tab that is away, so a hidden list keeps
    /// its last reading and reads nothing from the session: a board update while another tab shows rebuilds nothing.
    @Environment(\.phoneTasksShown) private var shown
    @State private var kept = PhoneTasksKept()

    /// The list as it reads now, built once per drawing while it shows, and the last one kept while it is hidden.
    private func reading() -> PhoneTasksKept.Reading {
        if !shown, let last = kept.last { return last }
        let reading = PhoneTasksKept.Reading(
            list: PhoneTaskList(board: session.board, cards: session.cards, query: query, earlier: earlier),
            asideLine: asideLine)
        kept.last = reading
        PhoneTasksKept.built(shown: shown, seq: reading.list.board?.seq)
        return reading
    }

    // INF-589 item 9: search waits above the list until it is pulled down, as the Mac's sits behind its icon.
    // VoiceOver cannot pull past the top of a list, so it always finds the field.
    private var searchShown: Bool { searchOpen || !query.isEmpty || voiceOver }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// INF-2928, the captain's pick: a title may take two lines on an iPhone, which has no pointer to show the rest, and
    /// one on an iPad, as on the Mac.
    private var titleLines: Int { UIDevice.current.userInterfaceIdiom == .pad ? 1 : 2 }

    /// INF-2553: on an iPhone on its side, a card brought back and put aside again by its refusal says why on this
    /// list's line, as a refused bring-back did before.
    private var asideLine: String? {
        guard phoneOnItsSide(verticalSize) else { return nil }
        return session.cards.first { $0.minimized && session.takenBack[$0.id] != nil }.flatMap { session.takenBack[$0.id] }
    }

    var body: some View {
        let reading = reading()
        let list = reading.list
        return ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                if searchShown { search }
                if let problem = problem ?? reading.asideLine { Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("tasks-problem") }
                LazyVStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    if list.isEmpty { Text(query.isEmpty ? "No tasks yet." : "No matching tasks.").foregroundStyle(PhoneTheme.secondary) }
                    // INF-2928 piece 1: only the groups with rows show, as on the Mac, and a search opens every one.
                    ForEach(list.parts) { part in
                        let open = !part.section.folds || searching || expanded.contains(part.section)
                        VStack(spacing: 0) {
                            groupHeader(part, open: open)
                            if open {
                                ForEach(part.rows) { row in
                                    taskRow(row, in: part, list: list, last: part.aside.isEmpty && row.id == part.rows.last?.id)
                                }
                                // A card put aside with no task is a row of its own under Waiting on you.
                                ForEach(part.aside) { card in asideRow(card, last: card.id == part.aside.last?.id) }
                            }
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
                // The reading column the list sits in, for the journeys to find Tasks by when no group has rows.
                .accessibilityElement(children: .contain).accessibilityIdentifier("tasks-column")
                .padding(PhoneTheme.space4).frame(maxWidth: PhoneColumn.width).frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.always, axes: .vertical)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top < -PhoneTheme.space5 * 2
        } action: { _, pulled in
            if pulled && !searchOpen { withAnimation(.snappy) { searchOpen = true } }
        }
        .background { Button("Find a task") { openSearch() }.keyboardShortcut("f", modifiers: [.command, .shift]).hidden() }
        .accessibilityIdentifier("tasks-list")
        .onChange(of: searchFocused) { _, focused in if !focused && query.isEmpty { closeSearch() } }
        .onDisappear { if query.isEmpty { searchOpen = false } }
        .task(id: "\(query)|\(session.contact)") {
            earlier = []; problem = nil
            let requested = query
            guard !requested.isEmpty, session.contact == "in-reach" else { return }
            guard requested.utf16.count <= 200 else { problem = "Use a shorter search."; return }
            do {
                let found: [PhoneTask] = try await session.request(.search, args: [requested])
                guard !Task.isCancelled, query == requested else { return }
                earlier = found
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
        // INF-1524: a task key pressed on a card opens that task's record here.
        .onChange(of: messageContext.openTask, initial: true) { _, key in
            guard let key, let task = session.board?.tasks.first(where: { $0.key == key }) else { return }
            messageContext.openTask = nil
            messageContext.taskID = task.id; selected = task
        }
        .sheet(item: $selected, onDismiss: { messageContext.taskID = nil }) { task in
            NavigationStack {
                PhoneTaskRecord(session: session, initial: task, leave: { selected = nil })
                    .toolbar { ToolbarItem(placement: .cancellationAction) { PhoneRecordLeaveButton(record: $selected) } }
            }.font(PhoneFont.body).tint(PhoneTheme.accent)
        }
    }

    private var search: some View {
        HStack(spacing: PhoneTheme.space2) {
            TextField("Search tasks", text: $query).textFieldStyle(.phone)
                .focused($searchFocused).submitLabel(.search)
                .onAppear {
                    guard focusOnOpen else { return }
                    focusOnOpen = false
                    Task { @MainActor in searchFocused = true }
                }
                .onKeyPress(.escape) {
                    if query.isEmpty { closeSearch() } else { query = "" }
                    return .handled
                }
                .accessibilityIdentifier("task-search")
            if !voiceOver {
                Button { closeSearch() } label: {
                    Image(systemName: "xmark").font(PhoneFont.callout).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(PhoneTheme.muted)
                    .accessibilityLabel("Close search").accessibilityIdentifier("close-task-search")
            }
        }.transition(.move(edge: .top).combined(with: .opacity))
    }

    // Find a task (Shift-Command-F), the Mac's own key, opens the search with the caret in it.
    private func openSearch() {
        if searchShown { searchFocused = true; return }
        focusOnOpen = true
        withAnimation(.snappy) { searchOpen = true }
    }

    // Closing lets go of the words, so a closed search never narrows the list, as on the Mac.
    private func closeSearch() {
        query = ""; searchFocused = false
        withAnimation(.snappy) { searchOpen = false }
    }

    // The Mac's micro label: uppercase, tracked, tertiary. Only a folding group is a button, and only it shows its count,
    // with Backlog's new filings and failed starts after it (the Mac's `Group`).
    @ViewBuilder private func groupHeader(_ part: PhoneTaskList.Part, open: Bool) -> some View {
        let title = Text(part.section.title).font(Self.label).textCase(.uppercase).tracking(Self.labelTracking)
        if part.section.folds {
            Button {
                if !expanded.insert(part.section).inserted { expanded.remove(part.section) }
            } label: {
                HStack(spacing: PhoneTheme.space2) {
                    title
                    Text("\(part.count)\(part.section == .group(.backlog) && part.failed > 0 ? PhoneTaskRowWords.failedCount(part.failed) : "")\(part.new > 0 ? PhoneTaskRowWords.newCount(part.new) : "")")
                        .font(PhoneFont.micro).lineLimit(1)
                    Spacer()
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary).accessibilityHidden(true)
                }.foregroundStyle(PhoneTheme.muted).frame(minHeight: 44)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("group-\(part.id)")
                .accessibilityLabel("\(part.section.title), \(part.count)")
                .accessibilityValue(open ? "Expanded" : "Collapsed")
        } else {
            title.foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("group-\(part.id)")
        }
    }

    /// The Mac's row: its status mark, the key and title with the one dim word after them, then the project's name where
    /// more than one project could be meant, where the task runs and why that computer cannot take work now. A part sits
    /// indented under its parent, and a Queued row adds the home's dated wait line below.
    private func taskRow(_ row: PhoneTaskList.Row, in part: PhoneTaskList.Part, list: PhoneTaskList, last: Bool) -> some View {
        let task = row.task
        let status = PhoneTaskFacts.status(task)
        let word = PhoneTaskList.word(task)
        let trailing = list.trailing(of: task)
        let wait = part.waitLine(of: task)
        var title = Text("\(task.key) ").font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted)
            + Text(task.title).font(PhoneFont.body)
            .foregroundStyle(part.section == .group(.waiting) ? PhoneTheme.text : PhoneTheme.secondary)
        if !word.isEmpty {
            title = title + Text(" · \(word)").font(PhoneFont.body)
                .foregroundStyle(word == PhoneTaskRowWords.couldNotStart ? PhoneTheme.warning : PhoneTheme.muted)
        }
        let ends = [trailing.name, trailing.place].filter { !$0.isEmpty }.joined(separator: " · ")
        var end = Text(ends)
        if trailing.outOfReach {
            end = end + Text("\(ends.isEmpty ? "" : " · ")\(trailing.reach)")
                .foregroundStyle(trailing.connecting ? PhoneTheme.muted : PhoneTheme.warning)
        }
        return Button { open(task) } label: {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                PhoneTaskMark(status: status).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    .frame(width: Self.markWidth)
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        title.lineLimit(titleLines).layoutPriority(1)
                        Spacer(minLength: PhoneTheme.space2)
                        if !ends.isEmpty || trailing.outOfReach {
                            end.font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                        }
                    }
                    if let wait {
                        Text(wait).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }.padding(.leading, CGFloat(row.depth) * Self.markWidth)
                .padding(.vertical, PhoneTheme.space3).frame(minHeight: 44)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("task-\(task.id)")
            .accessibilityLabel([task.key, task.title, word.isEmpty ? nil : word, ends.isEmpty ? nil : ends,
                                 trailing.outOfReach ? trailing.reach : nil, status.label].compactMap(\.self).joined(separator: ", "))
        .overlay(alignment: .bottom) {
            // Inset to the words, never under the mark, and none after a group's last row.
            if !last {
                Rectangle().fill(PhoneTheme.line).frame(height: 1)
                    .padding(.leading, Self.markWidth + PhoneTheme.space3 + CGFloat(row.depth) * Self.markWidth)
            }
        }
    }

    /// INF-2928 piece 1: a tap makes the Mac's four checks in order (`openTask`). A row whose task has cards put aside
    /// brings them back and shows them on Home, on the phone and every Mac (INF-1517); a ready card on the stack shows on
    /// Home, except a first mate question's, whose row opens its record; a required step the captain put off shows its
    /// card again; any other row opens the task's record.
    private func open(_ task: PhoneTask) {
        let aside = PhoneBoard.minimized(of: task, in: session.cards)
        if !aside.isEmpty { restore(aside); return }
        if let card = task.waitingCardId, let shown = session.stack.first(where: { $0.id == card }) {
            // The captain's pick: a first mate question's card shows no task key and the phone's cards have no Info
            // tab, so its row opens the record, where Dismiss is, until the phone matches the Mac.
            if task.kind == "decision" && shown.isFirstmateOwn { openRecord(task); return }
            messageContext.restoring = card; return
        }
        if task.status == "open", let state = task.requiredAction?.state, state == "ready" || state == "deferred",
           session.canChange {
            showCard(task); return
        }
        openRecord(task)
    }

    private func openRecord(_ task: PhoneTask) { messageContext.taskID = task.id; selected = task }

    /// The record's Show the card, through the one move the Mac runs it by: once the computer shows the card again, Home
    /// shows it as soon as the stack holds it; a refusal or a lost answer opens the record instead, as on the Mac.
    private func showCard(_ task: PhoneTask) {
        problem = nil
        Task {
            do {
                let answer: PhoneAnswer = try await session.request(.run, args: [task.id, "show-card"])
                if answer.ok, let card = try await session.readDetail(task.id).waitingCardId {
                    messageContext.restoring = card; return
                }
            } catch {}
            openRecord(task)
        }
    }

    /// INF-2553: the cards are back on Home at the tap, the first one up; one request per card, sent together, each
    /// settling on its own.
    /// A refusal puts that card aside again and the session says why.
    private func restore(_ cards: [PhoneCard]) {
        guard let first = cards.first, session.canChange else { return }
        problem = nil
        for card in cards {
            Task { try? await session.change(.bringBack(card: card.id), .minimize, [.string(card.id), .bool(false)]) }
        }
        messageContext.restoring = first.id
    }

    // A card put aside with no task: the Mac's presentation-only row, titled by the card, with no key or project.
    private func asideRow(_ card: PhoneCard, last: Bool) -> some View {
        Button { restore([card]) } label: {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                Image(systemName: "circle.fill").font(.system(size: PhoneTheme.space2)).foregroundStyle(PhoneTheme.accent)
                    .frame(width: Self.markWidth).accessibilityHidden(true)
                Text(card.title).font(PhoneFont.body).foregroundStyle(PhoneTheme.text).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, PhoneTheme.space3).frame(minHeight: 44)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!session.canChange).accessibilityIdentifier("minimized-card")
            .accessibilityLabel(card.title).accessibilityHint("Brings the card back")
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(PhoneTheme.line).frame(height: 1).padding(.leading, Self.markWidth + PhoneTheme.space3) }
        }
    }

    private static let markWidth: CGFloat = 12
    private static let label = Font.custom("SpaceGrotesk-Light", size: 11, relativeTo: .caption2).weight(.medium)
    private static let labelTracking: CGFloat = 1
}

/// INF-2764: the Tasks list's last reading, in a plain class so keeping it draws nothing.
@MainActor final class PhoneTasksKept {
    struct Reading {
        let list: PhoneTaskList
        let asideLine: String?
    }
    var last: Reading?

    /// For the app-hosted check that a hidden list builds nothing on a board update (`PhoneTasksHiddenTests`): how
    /// many lists were built while hidden, and the board a shown list was last built from.
    private(set) static var hiddenBuilds = 0
    private(set) static var shownSeq: Int?
    static func built(shown: Bool, seq: Int?) { if shown { shownSeq = seq } else { hiddenBuilds += 1 } }
}

extension EnvironmentValues {
    /// Whether the Tasks list is the view on screen; the workspace sets it on the Tasks tab, and the iPad sidebar's
    /// list, drawn only while it shows, keeps the default.
    @Entry var phoneTasksShown = true
}
