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
    /// The pressed tag chip (the Mac's `TagFilter`): a tag's id, `PhoneTaskList.noTag`, or nil for All tags.
    @State private var tag: String?
    @State private var searchOpen = false
    @State private var focusOnOpen = false
    @FocusState private var searchFocused: Bool
    @State private var earlier: [PhoneTask] = []
    @State private var problem: String?
    @State private var selected: PhoneTask?
    /// The folding groups, Backlog and Done, the captain opened; the Mac's other groups always show their rows.
    @State private var expanded: Set<PhoneTaskList.Section> = []
    /// INF-2928 piece 3: a move from a row's long press that asks once before it runs, as the Mac's board asks.
    @State private var asking: RowAsk?
    /// The Backlog row a swipe holds open on its Start, and how far a swipe under way has moved a row.
    @State private var swiped: String?
    @State private var swiping: (id: String, x: CGFloat)?
    /// The list's width, which a long press's summary takes up to the Mac's own width for it.
    @State private var columnWidth: CGFloat = 0

    /// INF-2764: whether this list is on screen. The tab controller keeps a tab that is away, so a hidden list keeps
    /// its last reading and reads nothing from the session: a board update while another tab shows rebuilds nothing.
    @Environment(\.phoneTasksShown) private var shown
    /// INF-1208's direction C: on an open iPhone Duo's page a record takes the list's place, with a way back.
    @Environment(\.phoneRecordInPlace) private var inPlace
    /// INF-1208's direction C: whether this list answers a card's task key or a panel's pointing. While records go in
    /// the panel's place, the Tasks tab kept away leaves them to the sidebar's list, which shows them.
    @Environment(\.phoneTasksTakesPoints) private var takesPoints
    private var placed: PhoneTask? { inPlace ? selected : nil }
    @State private var kept = PhoneTasksKept()

    /// The list as it reads now, built once per drawing while it shows, and the last one kept while it is hidden.
    private func reading() -> PhoneTasksKept.Reading {
        if !shown, let last = kept.last { return last }
        let reading = PhoneTasksKept.Reading(
            list: PhoneTaskList(board: session.board, cards: session.cards, query: query, tag: tag, earlier: earlier),
            asideLine: asideLine)
        kept.last = reading
        PhoneTasksKept.built(shown: shown, seq: reading.list.board?.seq)
        return reading
    }

    // INF-589 item 9: search waits above the list until it is pulled down, as the Mac's sits behind its icon.
    // VoiceOver cannot pull past the top of a list, so it always finds the field.
    // A pressed tag keeps it shown, since it narrows the list as words do.
    private var searchShown: Bool { searchOpen || !query.isEmpty || tag != nil || voiceOver }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tag != nil }
    /// INF-2928, the captain's pick: a title may take two lines on an iPhone, which has no pointer to show the rest, and
    /// one on an iPad, as on the Mac.
    private var titleLines: Int { UIDevice.current.userInterfaceIdiom == .pad ? 1 : 2 }

    /// INF-2553: on an iPhone on its side, a card brought back and put aside again by its refusal says why on this
    /// list's line, as a refused bring-back did before.
    private var asideLine: String? {
        guard phoneOnItsSide(verticalSize) else { return nil }
        return session.cards.first { $0.minimized && session.takenBack[$0.id] != nil }.flatMap { session.takenBack[$0.id] }
    }

    /// INF-2928 piece 3: on an iPhone on its side, which shows no change pill, why a move from a row was refused or
    /// taken back is said on this list's line.
    private var sideNotice: String? {
        guard phoneOnItsSide(verticalSize), let notice = session.changeNotice, notice.place == nil else { return nil }
        return notice.words
    }

    var body: some View {
        let reading = reading()
        let list = reading.list
        return ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                if searchShown {
                    search
                    if !list.tagChips.isEmpty { tagRow(list) }
                }
                if let problem = problem ?? reading.asideLine ?? sideNotice { Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("tasks-problem") }
                LazyVStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    // INF-3750: In reach comes before the board's first read, so an empty list says nothing until it is read.
                    if list.isEmpty, !query.isEmpty || list.board != nil {
                        Text(query.isEmpty && list.tag == nil ? PhoneMessages.phoneTasksEmpty() : PhoneMessages.phoneTasksNoMatch()).foregroundStyle(PhoneTheme.secondary)
                    }
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
                }.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
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
        // While a record covers the list in the panel's place, the key finds nothing it can show, so it rests.
        .background { Button(PhoneMessages.phoneTasksFind()) { openSearch() }.keyboardShortcut("f", modifiers: [.command, .shift]).disabled(placed != nil).hidden() }
        .accessibilityIdentifier("tasks-list")
        .onChange(of: searchFocused) { _, focused in if !focused && query.isEmpty && tag == nil { closeSearch() } }
        .onDisappear { if query.isEmpty && tag == nil { searchOpen = false } }
        .task(id: "\(query)|\(session.contact)") {
            earlier = []; problem = nil
            let requested = query
            guard !requested.isEmpty, session.contact == "in-reach" else { return }
            guard requested.utf16.count <= 200 else { problem = PhoneMessages.phoneTasksSearchTooLong(); return }
            do {
                let found: [PhoneTask] = try await session.request(.search, args: [requested])
                guard !Task.isCancelled, query == requested else { return }
                earlier = found
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
        // INF-3764: Done opened or a search reads the closed rows the first board read left out. Only a list on screen
        // asks, and only it reads the board for it (INF-2764).
        .onChange(of: shown && (searching || expanded.contains(.group(.landed))) && session.board?.closedLeftOut != nil,
                  initial: true) { _, wants in if wants { session.readClosedRows() } }
        // INF-1524: a task key pressed on a card opens that task's record here. A key the board read without its closed
        // rows does not list may be work closed this week: those are read, and the key opens once they arrive.
        .onChange(of: "\(messageContext.openTask ?? "")|\(session.board?.closedLeftOut == nil)", initial: true) { _, _ in
            guard takesPoints, let key = messageContext.openTask else { return }
            guard let task = session.board?.tasks.first(where: { $0.key == key }) else {
                if session.board?.closedLeftOut != nil { session.readClosedRows() }
                return
            }
            messageContext.openTask = nil
            messageContext.taskID = task.id; selected = task
        }
        // INF-3830 piece 3: a panel's tap on a task opens it as a row's tap does (`openTask`), or straight to its record
        // (`openRecord`); closed work the board left out is read first, as for a card's task key.
        .onChange(of: "\(messageContext.pointTask?.id ?? "")|\(messageContext.pointTask?.record == true)|\(session.board?.closedLeftOut == nil)",
                  initial: true) { _, _ in
            guard takesPoints, let point = messageContext.pointTask else { return }
            guard let task = session.board?.tasks.first(where: { $0.id == point.id }) else {
                if session.board?.closedLeftOut != nil { session.readClosedRows() } else { messageContext.pointTask = nil }
                return
            }
            messageContext.pointTask = nil
            if point.record { openRecord(task) } else { open(task) }
        }
        // The Mac's ask on the tile: its sentence, Cancel, which writes nothing, and the move's own button.
        .alert(asking?.sentence ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
               presenting: asking) { ask in
            Button(PhoneRecordWords.dropCancel, role: .cancel) {}
            Button(ask.confirm, role: ask.op == "drop-task" || ask.op == "stop-task" ? .destructive : nil) { confirm(ask) }
        }
        // INF-1208's direction C: in place, the record covers the list, which keeps its scroll and search under it.
        .opacity(placed == nil ? 1 : 0).allowsHitTesting(placed == nil).accessibilityHidden(placed != nil)
        .overlay { if let placed { recordInPlace(placed) } }
        .onChange(of: placed?.id, initial: true) { old, id in
            guard inPlace || old != nil else { return }
            messageContext.recordInPlace = id != nil
            if id == nil, old != nil, selected == nil { messageContext.taskID = nil }
        }
        // A record that leaves the window with its panel, as when the Duo closes or an iPad turns upright, is dismissed:
        // it gives the message box no hint.
        .onDisappear {
            guard selected != nil else { return }
            messageContext.recordInPlace = false
            messageContext.taskID = nil
        }
        .sheet(item: Binding(get: { inPlace ? nil : selected }, set: { if !inPlace { selected = $0 } }),
               onDismiss: { if !inPlace { messageContext.taskID = nil } }) { task in
            NavigationStack {
                PhoneTaskRecord(session: session, initial: task, leave: { selected = nil })
                    .toolbar { ToolbarItem(placement: .cancellationAction) { PhoneRecordLeaveButton(record: $selected) } }
            }.font(PhoneFont.body).tint(PhoneTheme.accent)
        }
    }

    /// INF-1208's direction C: the record in the panel's place, under a way back to the list; a related task's key opens
    /// that task's record here in its stead.
    private func recordInPlace(_ task: PhoneTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            PhoneRecordBackButton { selected = nil }.padding(.horizontal, PhoneTheme.space4)
            PhoneTaskRecord(session: session, initial: task, leave: { selected = nil },
                            open: { other in messageContext.taskID = other.id; selected = other })
        }.id(task.id).background(PhoneTheme.background)
    }

    private var search: some View {
        HStack(spacing: PhoneTheme.space2) {
            TextField(PhoneMessages.phoneTasksSearch(), text: $query).textFieldStyle(.phone)
                .focused($searchFocused).submitLabel(.search)
                // The captain: typing in Tasks' search on a foldable's pages brings the panel above the fold.
                .phonePanelField(searchFocused)
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
                    .accessibilityLabel(PhoneMessages.phoneTasksCloseSearch()).accessibilityIdentifier("close-task-search")
            }
        }.transition(.move(edge: .top).combined(with: .opacity))
    }

    /// The Mac's tag row under the search (design skill NowPanel, "Tags"): All tags, each of the project's tags with how
    /// many open tasks pressing it would list, then No tag. One is pressed at a time; pressing one narrows every group.
    private func tagRow(_ list: PhoneTaskList) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: PhoneTheme.space2) {
                ForEach(list.tagChips, id: \.handle) { chip in
                    let pressed = chip.id == list.tag
                    Button { tag = chip.id } label: {
                        HStack(spacing: 6) {
                            Text(chip.name)
                            if let count = chip.count { Text(count, format: .number).foregroundStyle(PhoneTheme.muted) }
                        }.font(PhoneFont.mono).foregroundStyle(pressed ? PhoneTheme.text : PhoneTheme.secondary)
                            .padding(.horizontal, PhoneTheme.space3).frame(minHeight: 32)
                            .background(pressed ? PhoneTheme.raised : .clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(PhoneTheme.line))
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityAddTraits(pressed ? .isSelected : [])
                        .accessibilityIdentifier("tag-chip-\(chip.handle)")
                }
            }
        }.accessibilityElement(children: .contain).accessibilityLabel(PhoneMessages.nowPanelTags())
            .accessibilityIdentifier("tag-row")
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    // Find a task (Shift-Command-F), the Mac's own key, opens the search with the caret in it.
    private func openSearch() {
        if searchShown { searchFocused = true; return }
        focusOnOpen = true
        withAnimation(.snappy) { searchOpen = true }
    }

    // Closing lets go of the words and the tag, so a closed search never narrows the list, as on the Mac.
    private func closeSearch() {
        query = ""; tag = nil; searchFocused = false
        withAnimation(.snappy) { searchOpen = false }
    }

    // The Mac's micro label: uppercase, tracked, tertiary. Only a folding group is a button, and only it shows its count,
    // with Backlog's new filings and failed starts after it (the Mac's `Group`).
    @ViewBuilder private func groupHeader(_ part: PhoneTaskList.Part, open: Bool) -> some View {
        let title = Text(part.section.title).font(Self.label).textCase(.uppercase).tracking(PhoneFont.labelTracking)
        if part.section.folds {
            Button {
                if !expanded.insert(part.section).inserted { expanded.remove(part.section) }
            } label: {
                HStack(spacing: PhoneTheme.space2) {
                    title
                    Text("\(part.count)\(part.section == .group(.backlog) && part.failed > 0 ? PhoneTaskRowWords.failedCount(part.failed) : "")\(part.new > 0 ? PhoneTaskRowWords.newCount(part.new) : "")")
                        .font(PhoneFont.micro).lineLimit(1)
                    Spacer()
                    Image(systemName: open ? "chevron.down" : "chevron.forward")
                        .font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary).accessibilityHidden(true)
                }.foregroundStyle(PhoneTheme.muted).frame(minHeight: 44)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("group-\(part.id)")
                .accessibilityLabel("\(part.section.title), \(part.count)")
                .accessibilityValue(open ? PhoneMessages.phoneTasksGroupExpanded() : PhoneMessages.phoneTasksGroupCollapsed())
        } else {
            title.foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("group-\(part.id)")
        }
    }

    /// The Mac's row: its status mark, the key and title with the one dim word after them, then, only while its computer
    /// cannot take work now, why not. A part sits indented under its parent, and a Queued row adds the home's dated wait
    /// line below.
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
        // The spoken label still names the project and where the task runs; the row shows neither.
        let ends = [list.projectName(of: task), task.place?.where ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        // What the Mac's row shows at rest. INF-2928 piece 3: a Backlog row's Start, which a swipe shows, says why under the
        // row when it cannot start. A pinned backlog task keeps it, as on the Mac (INF-3127).
        let controls = PhoneRowMoves.rowControls(task, home: part.home(of: task))
        let start = controls.start
        let held = swiped == task.id ? start?.reason : nil
        let lane: PhoneRowMoves.Lane? = part.section == .earlier ? .earlier : PhoneRowMoves.lane(task)
        let line = Button {
            // A row held open on its Start closes first, as a swiped row does.
            if swiped != nil { withAnimation(.snappy) { swiped = nil }; return }
            open(task)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                PhoneTaskMark(status: status).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    .frame(width: Self.markWidth)
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        title.lineLimit(titleLines).layoutPriority(1)
                        Spacer(minLength: PhoneTheme.space2)
                        if trailing.outOfReach {
                            Text(trailing.reach).font(PhoneFont.mono)
                                .foregroundStyle(trailing.connecting ? PhoneTheme.muted : PhoneTheme.warning).fixedSize()
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
            // A long press stands in for resting the pointer on the Mac's row: the crew summary, with the row's moves
            // under it.
            .contextMenu { moves(task, lane: lane, controls: controls) } preview: {
                PhoneRowPreview(width: min(max(columnWidth, 280), PhoneCrewSummary.hoverWidth)) {
                    PhoneCrewSummary(session: session, task: task, tasks: list.board?.tasks ?? [], preview: true)
                }.font(PhoneFont.body).tint(PhoneTheme.accent)
            }
        let inset = Self.markWidth + PhoneTheme.space3 + CGFloat(row.depth) * Self.markWidth
        return VStack(alignment: .leading, spacing: 0) {
            swipeable(line, task: task, start: start)
            if let held {
                Text(held).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true).padding(.leading, inset).padding(.bottom, PhoneTheme.space3)
                    .accessibilityIdentifier("row-start-reason")
            }
        }
        .overlay(alignment: .bottom) {
            // Inset to the words, never under the mark, and none after a group's last row.
            if !last {
                Rectangle().fill(PhoneTheme.line).frame(height: 1).padding(.leading, inset)
            }
        }
    }

    /// INF-3588: a tap follows the Mac's `openTask` order. A row whose task has cards put aside brings them all back, on the
    /// phone and every Mac (INF-1517); then it shows the decision the task waits on, a required step the captain put off
    /// through the Mac's `show-card` move, or the task's newest card on the stack, on Home; otherwise it opens the task's
    /// record. A first mate question opens its record (`PhoneBoard.opening`).
    private func open(_ task: PhoneTask) {
        let aside = session.canChange ? PhoneBoard.minimized(of: task, in: session.cards) : []
        bringBack(aside)
        switch PhoneBoard.opening(task, in: session.cards, back: Set(aside.map(\.id)), canChange: session.canChange) {
        case .card(let card): messageContext.restoring = card
        case .showCard: showCard(task)
        case .record: openRecord(task)
        }
    }

    private func openRecord(_ task: PhoneTask) { messageContext.taskID = task.id; selected = task }

    /// INF-2928 piece 3: the long press's moves, the Mac's task board menu for this row (`boardMenuOf`) with every control
    /// its Tasks panel row shows at rest (`PhoneRowMoves.longPress`): each entry names what it does, or the Mac's reason it
    /// cannot run, dim. A row the board has no menu for, Done and Dropped among them, still opens its record here, and
    /// pins or unpins as the Mac's row does.
    @ViewBuilder private func moves(_ task: PhoneTask, lane: PhoneRowMoves.Lane?, controls: PhoneRowMoves.Controls) -> some View {
        ForEach(Array(PhoneRowMoves.longPress(task, lane: lane, controls: controls).enumerated()), id: \.offset) { _, item in
            switch item {
            case .separator: Divider()
            case .entry(let entry):
                Button(role: entry.danger ? .destructive : nil) { act(entry, task: task, lane: lane) } label: {
                    Text(entry.label)
                    if let detail = entry.detail { Text(detail) }
                }
                .disabled(entry.disabled || (!session.canChange && entry.id != .open && entry.id != .card))
            }
        }
    }

    /// One entry, as the Mac runs it: Open record, Show the card by the row's own order, Continue at once, the row's Start
    /// at once with no ask, as the Mac's row starts it, and every other entry as the board's move to its lane or to Drop
    /// task.
    private func act(_ entry: PhoneRowMoves.Entry, task: PhoneTask, lane: PhoneRowMoves.Lane?) {
        switch entry.id {
        case .open: openRecord(task)
        case .card: open(task)
        case .pin: pin(task)
        case .continue: start(task, move: "continue-task")
        case .rowStart: start(task, move: "start-task")
        default:
            guard let lane, let target = entry.target else { return }
            perform(task, from: lane, to: target)
        }
    }

    /// The Mac's move (`boardMoveOf`): a refusal says why and writes nothing, an at-once move runs, and a move that asks
    /// asks once; a never-started Drop task asks in its record's words, from the effects the record lists now.
    private func perform(_ task: PhoneTask, from lane: PhoneRowMoves.Lane, to target: PhoneRowMoves.Target) {
        switch PhoneRowMoves.move(task, from: lane, to: target) {
        case .none(let why), .refused(let why): say(why)
        case .now(let op, _, _): run(task, args: [task.id, op])
        case .card(let card, _): messageContext.restoring = card
        case .ask(let op, let sentence, let confirm):
            guard op == "drop-task" else {
                asking = RowAsk(task: task, op: op, sentence: sentence, confirm: confirm, review: nil); return
            }
            Task {
                let effects = try? await session.readDetail(task.id).dropEffects
                switch PhoneRowMoves.dropAsk(task.key, effects: effects) {
                case .refused(let why): say(why)
                case .ask(let sentence, let review):
                    asking = RowAsk(task: task, op: op, sentence: sentence, confirm: confirm, review: review)
                }
            }
        }
    }

    /// The ask's own button: Start through the start the record draws at the tap, any other move as the Mac sends it,
    /// with the review Drop task asked about.
    private func confirm(_ ask: RowAsk) {
        if ask.op == "start-task" { start(ask.task, move: ask.op); return }
        var args: [Any] = [ask.task.id, ask.op]
        if let review = ask.review { args.append(review) }
        run(ask.task, args: args)
    }

    /// INF-3127: Pin or Unpin, at once, as the Mac's board menu does; the row moves once the computer's board does, and a
    /// refusal says why.
    private func pin(_ task: PhoneTask) {
        guard session.canChange else { return }
        Task {
            do {
                let answer: PhoneAnswer = try await session.request(.pin, args: [task.id, task.pinnedAt == nil])
                if !answer.ok { say(answer.text ?? PhoneMessages.phoneTaskChangeRefused()) }
            } catch { say(error.localizedDescription) }
        }
    }

    /// A move the phone draws no intent for: the list moves the row once the computer's board does, and a refusal says why.
    private func run(_ task: PhoneTask, args: [Any]) {
        guard session.canChange else { return }
        Task {
            do {
                let answer: PhoneAnswer = try await session.request(.run, args: args)
                if !answer.ok { say(answer.text ?? PhoneMessages.phoneTaskChangeRefused()) }
            } catch { say(error.localizedDescription) }
        }
    }

    /// Start and Continue show the task starting at the tap; the session takes a refused one back and says why.
    private func start(_ task: PhoneTask, move: String) {
        guard session.canChange else { return }
        Task { try? await session.change(.start(task: task.id, move: move), .run, args: [task.id, move]) }
    }

    private func say(_ why: String) { session.changeNotice = PhoneChangeNotice(words: why) }

    /// A Backlog row's Start sits under its trailing edge: a swipe toward the leading edge shows it, as the Mac shows it on
    /// the row, and holds the row open on it; a tap on the row closes it. One press starts the task with no ask, as on
    /// the Mac.
    @ViewBuilder private func swipeable(_ line: some View, task: PhoneTask, start: PhoneRowMoves.Start?) -> some View {
        if let start {
            let held: CGFloat = swiped == task.id ? -Self.startWidth : 0
            let x = swiping.flatMap { $0.id == task.id ? $0.x : nil } ?? held
            line.offset(x: x)
                .background(alignment: .trailing) {
                    if x < 0 {
                        Button {
                            withAnimation(.snappy) { swiped = nil }
                            self.start(task, move: "start-task")
                        } label: {
                            Text(start.label).font(PhoneFont.body).lineLimit(1).fixedSize()
                                .foregroundStyle(start.reason == nil ? PhoneTheme.onAccent : PhoneTheme.muted)
                                .frame(width: -x).frame(maxHeight: .infinity)
                                .background(start.reason == nil ? PhoneTheme.accent : PhoneTheme.surface)
                                .clipped()
                        }.buttonStyle(.plain).disabled(start.reason != nil || !session.canChange)
                            .accessibilityIdentifier("row-start-\(task.id)")
                    }
                }
                .clipped()
                .gesture(PhoneRowSwipe { dx in
                    if swiped != nil && swiped != task.id { swiped = nil }
                    swiping = (task.id, min(0, max(held + dx, -Self.startWidth - PhoneTheme.space5)))
                } ended: { dx, speed in
                    let x = held + dx
                    let open = speed < -300 || (x < -Self.startWidth / 2 && speed <= 300)
                    withAnimation(.snappy) {
                        swiping = nil
                        swiped = open ? task.id : nil
                    }
                })
        } else {
            line
        }
    }

    /// The record's Show the card, through the one move the Mac runs it by: once the computer shows the card again, Home
    /// shows it as soon as the stack holds it; after a refusal or a lost answer, the row goes on as the Mac's does, to the
    /// task's newest card on the stack, then its record.
    private func showCard(_ task: PhoneTask) {
        problem = nil
        Task {
            do {
                let answer: PhoneAnswer = try await session.request(.run, args: [task.id, "show-card"])
                if answer.ok, let card = try await session.readDetail(task.id).waitingCardId {
                    messageContext.restoring = card; return
                }
            } catch {}
            if case .card(let card) = PhoneBoard.opening(task, in: session.cards, canChange: false) {
                messageContext.restoring = card
            } else { openRecord(task) }
        }
    }

    /// A card put aside with no task is back on Home at the tap, and shows there.
    private func restore(_ card: PhoneCard) {
        guard session.canChange else { return }
        bringBack([card])
        messageContext.restoring = card.id
    }

    /// INF-2553: the cards are back on Home at the tap; one request per card, sent together, each settling on its own.
    /// A refusal puts that card aside again and the session says why.
    private func bringBack(_ cards: [PhoneCard]) {
        guard !cards.isEmpty, session.canChange else { return }
        problem = nil
        for card in cards {
            Task { try? await session.change(.bringBack(card: card.id), .minimize, [.string(card.id), .bool(false)]) }
        }
    }

    // A card put aside with no task: the Mac's presentation-only row, titled by the card, with no key or project.
    private func asideRow(_ card: PhoneCard, last: Bool) -> some View {
        Button { restore(card) } label: {
            HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
                Image(systemName: "circle.fill").font(.system(size: PhoneTheme.space2)).foregroundStyle(PhoneTheme.accent)
                    .frame(width: Self.markWidth).accessibilityHidden(true)
                Text(card.title).font(PhoneFont.body).foregroundStyle(PhoneTheme.text).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, PhoneTheme.space3).frame(minHeight: 44)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!session.canChange).accessibilityIdentifier("minimized-card")
            .accessibilityLabel(card.title).accessibilityHint(PhoneMessages.phoneTasksRestoreHint())
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(PhoneTheme.line).frame(height: 1).padding(.leading, Self.markWidth + PhoneTheme.space3) }
        }
    }

    private static let markWidth: CGFloat = 12
    /// How wide a Backlog row's Start shows once a swipe holds it open: room for Try again.
    private static let startWidth: CGFloat = 104
    private static let label = Font.custom("SpaceGrotesk-Light", size: 11, relativeTo: .caption2).weight(.medium)

    /// A move from a row's long press that asks once: the Mac's sentence, its button, and Drop task's review.
    struct RowAsk: Identifiable {
        let id = UUID()
        let task: PhoneTask
        let op: String
        let sentence: String
        let confirm: String
        let review: [String: [String]]?
    }
}

/// A long press's summary at its own width. The system asks the preview for that size, but an iPad may give it less
/// room beside the menu; the summary then shrinks whole instead of losing its edges.
private struct PhoneRowPreview<Content: View>: View {
    let width: CGFloat
    @ViewBuilder let content: Content
    @State private var natural: CGSize = .zero
    @State private var given: CGSize = .zero

    var body: some View {
        let scale = natural.width > 0 && natural.height > 0 && given.width > 0
            ? min(1, given.width / natural.width, given.height / natural.height) : 1
        content.frame(width: width).background(PhoneTheme.panel)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { natural = $0 }
            .scaleEffect(scale)
            // Never larger than the summary, and as small as the room the system gives it.
            .frame(minWidth: 0, minHeight: 0)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { given = $0 }
            .background(PhoneTheme.panel)
    }
}

/// A sideways swipe on a row, which leaves an upward or downward one to the list's scrolling: how far it has moved, then
/// where it ended and how fast.
private struct PhoneRowSwipe: UIGestureRecognizerRepresentable {
    let moved: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let dx = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .changed: moved(dx)
        case .ended, .cancelled: ended(dx, recognizer.velocity(in: nil).x)
        default: break
        }
    }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let speed = pan.velocity(in: nil)
            return abs(speed.x) > abs(speed.y)
        }
    }
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
    /// INF-1208's direction C: whether this Tasks list opens what a card's key or a panel points at (`PhoneTasks`).
    @Entry var phoneTasksTakesPoints = true
}
