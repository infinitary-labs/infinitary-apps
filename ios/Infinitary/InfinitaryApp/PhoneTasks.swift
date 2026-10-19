import InfinitaryKit
import SwiftUI

struct PhoneTasks: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @State private var query = ""
    @State private var earlier: [PhoneTask] = []
    @State private var problem: String?
    @State private var selected: PhoneTask?
    @State private var expanded: Set<PhoneTaskGroup> = [.waiting, .working, .queued]

    private var rows: [PhoneTask] {
        let current = (session.board?.tasks ?? []).filter {
            query.isEmpty || "\($0.key) \($0.title) \($0.goal ?? "")".localizedCaseInsensitiveContains(query)
        }
        let ids = Set(current.map(\.id))
        return (current + earlier.filter { !ids.contains($0.id) }).sorted {
            let leftLive = $0.status == "open" || $0.status == "active"
            let rightLive = $1.status == "open" || $1.status == "active"
            if leftLive != rightLive { return leftLive }
            return $0.createdAt > $1.createdAt
        }
    }

    var body: some View {
        VStack(spacing: PhoneTheme.space3) {
            TextField("Search tasks", text: $query).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("task-search")
            if let problem { Text(problem).foregroundStyle(PhoneTheme.warning) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PhoneTheme.space3) {
                    if rows.isEmpty { Text(query.isEmpty ? "No tasks yet." : "No matching tasks.").foregroundStyle(PhoneTheme.secondary) }
                    if query.isEmpty {
                        let groups = session.board?.groups ?? [:]
                        ForEach(PhoneTaskGroup.allCases, id: \.rawValue) { group in
                            let members = rows.filter { groups[$0.id] == group }
                            VStack(spacing: 0) {
                                Button {
                                    if !expanded.insert(group).inserted { expanded.remove(group) }
                                } label: {
                                    HStack {
                                        Text(group.title)
                                        Text("\(members.count)")
                                        Spacer()
                                        Image(systemName: expanded.contains(group) ? "chevron.down" : "chevron.right").accessibilityHidden(true)
                                    }.font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary).frame(minHeight: 44)
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("group-\(group.rawValue)")
                                    .accessibilityValue(expanded.contains(group) ? "Expanded" : "Collapsed")
                                if expanded.contains(group) {
                                    ForEach(members) { task in taskRow(task) }
                                }
                            }
                        }
                    } else {
                        ForEach(rows) { task in taskRow(task) }
                    }
                }
            }.accessibilityIdentifier("tasks-list")
        }.padding().frame(maxWidth: 750).frame(maxWidth: .infinity).background(PhoneTheme.background)
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
            .sheet(item: $selected, onDismiss: { messageContext.taskID = nil }) { task in
                NavigationStack {
                    PhoneTaskRecord(session: session, initial: task)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { selected = nil }.accessibilityIdentifier("close-record") } }
                }.font(PhoneFont.body).tint(PhoneTheme.accent)
            }
    }

    private func taskRow(_ task: PhoneTask) -> some View {
        Button { messageContext.taskID = task.id; selected = task } label: {
            HStack(alignment: .top, spacing: PhoneTheme.space3) {
                Image(systemName: task.status == "open" && task.waitingCardId == nil ? "circle" : "circle.fill")
                    .font(.system(size: PhoneTheme.space2)).foregroundStyle(task.waitingCardId != nil ? PhoneTheme.accent : task.activity == "running" ? PhoneTheme.warning : PhoneTheme.secondary)
                    .padding(.top, PhoneTheme.space2).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        Text(task.key).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                        Text(task.title).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                    }
                    if let project = session.board?.projects.first(where: { $0.id == task.projectId }) {
                        Text(project.name).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, PhoneTheme.space3).frame(minHeight: 44)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("task-\(task.id)")
            .accessibilityLabel("\(task.key), \(task.title), \(task.state)")
        .overlay(alignment: .bottom) { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
    }
}

struct PhoneTaskRecord: View {
    let session: ReadOnlySession
    let initial: PhoneTask
    @State private var detail: PhoneTask?
    @State private var crew: PhoneCrew?
    @State private var live: PhoneCrewLive?
    @State private var showingCrew = false
    @State private var draft = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var readProblem: String?
    private var task: PhoneTask { detail ?? initial }

    var body: some View {
        VStack(spacing: PhoneTheme.space3) {
            ScrollView {
                VStack(alignment: .leading, spacing: PhoneTheme.space4) {
                    Text(task.title).font(PhoneFont.title).accessibilityIdentifier("task-record-title")
                    Text("\(task.state) · \(session.mac.name)").font(PhoneFont.mono)
                    if let place = task.place { Text(place.where).foregroundStyle(PhoneTheme.secondary) }
                    if let words = session.changeRefusal { Text(words).foregroundStyle(PhoneTheme.warning) }
                    if let readProblem { Text(readProblem).foregroundStyle(PhoneTheme.warning) }
                    if task.startedAt != nil {
                        Picker("Record", selection: $showingCrew) {
                            Text("Info").tag(false)
                            Text("Crewmate").tag(true)
                        }.pickerStyle(.segmented).accessibilityIdentifier("record-tabs")
                    }
                    if showingCrew { crewContent } else { infoContent }
                }.padding().frame(maxWidth: 750).frame(maxWidth: .infinity)
            }
            if let problem { Text(problem).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning).padding(.horizontal).accessibilityIdentifier("task-problem") }
            if task.status == "open" || task.status == "active" { actions.padding() }
        }.background(PhoneTheme.background).navigationTitle(task.key).navigationBarTitleDisplayMode(.inline)
            .task(id: "\(session.contact)|\(showingCrew)") {
                guard session.contact == "in-reach" else { return }
                // Only the open record polls; the board follows pushes. Transcript writes may follow their event.
                while !Task.isCancelled {
                    await refresh()
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
            }
    }

    private var infoContent: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
            if let goal = task.goal { section("Goal", goal) }
            if let words = task.intent?.userWords, !words.isEmpty { section("Your words", words) }
            if let plan = task.plan {
                Text("Progress").font(PhoneFont.headline)
                ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                    Label(item.label, systemImage: item.state == "done" ? "checkmark.circle" : item.state == "current" ? "circle.inset.filled" : "circle")
                }
            }
            if let outcome = task.outcome { section("Latest report", outcome) }
            if let problem = task.problem { section("What happened", problem) }
            if !task.blockedBy.isEmpty { section("Waiting for", task.blockedBy.joined(separator: ", ")) }
            if let model = task.modelLabel { section("Crewmate", "\(task.assignee ?? "Crewmate") · \(model)") }
            Text("Timeline").font(PhoneFont.headline)
            ForEach(task.events ?? []) { event in
                VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                    Text(event.text).textSelection(.enabled)
                    Text(Date(timeIntervalSince1970: event.at / 1000).formatted(date: .abbreviated, time: .shortened))
                        .font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                }.accessibilityIdentifier("task-event-\(event.kind)")
                Divider()
            }
        }
    }

    private var crewContent: some View {
        LazyVStack(alignment: .leading, spacing: PhoneTheme.space4) {
            if let crew {
                if crew.earlier > 0 { Text("\(crew.earlier) earlier entries are not shown.").font(PhoneFont.caption) }
                if crew.lines.isEmpty { Text("Nothing from the crewmate yet.").foregroundStyle(PhoneTheme.secondary) }
                ForEach(crew.lines) { line in
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        if line.kind == "sent" { Text(line.from == "captain" ? "You" : line.from == "firstmate" ? "Your first mate" : "Infinitary").font(PhoneFont.caption) }
                        if let name = line.name { Text("\(name) · \(line.target ?? "")").font(PhoneFont.mono) }
                        if line.kind == "brief" || line.kind == "report" {
                            DisclosureGroup(line.summary ?? (line.kind == "brief" ? "The brief" : "Report")) { Text(line.words).textSelection(.enabled) }
                        } else { Text(line.words).textSelection(.enabled) }
                        if let result = line.result { CrewResult(session: session, taskID: task.id, result: result) }
                    }.accessibilityIdentifier("crew-line-\(line.kind)")
                }
            }
            if let text = live?.text, !text.isEmpty { Text(text).accessibilityIdentifier("crew-live") }
        }
    }

    @ViewBuilder private var actions: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if showingCrew && task.canSteer {
                TextField("Message to the crewmate", text: $draft, axis: .vertical).lineLimit(1...4)
                    .textFieldStyle(.roundedBorder).disabled(busy).accessibilityIdentifier("steer-box")
                HStack {
                    Button("Steer") { change(.steer, args: [task.id, draft], clearDraft: true) }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.return, modifiers: .command).accessibilityIdentifier("steer-task")
                    if live?.since != nil {
                        Button("Interrupt", role: .destructive) { change(.interrupt, args: [task.id]) }
                            .accessibilityIdentifier("interrupt-task")
                    }
                }.buttonStyle(.bordered).controlSize(.large)
            }
            HStack {
                if task.moves?["start-task"]?.ok == true {
                    Button("Start") { change(.run, args: [task.id, "start-task"]) }.accessibilityIdentifier("start-task")
                }
                if task.moves?["continue-task"]?.ok == true {
                    Button("Continue") { change(.run, args: [task.id, "continue-task"]) }.accessibilityIdentifier("continue-task")
                }
                if busy { ProgressView() }
            }.buttonStyle(.borderedProminent).controlSize(.large)
        }.disabled(busy || !session.canChange)
    }

    private func section(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) { Text(title).font(PhoneFont.headline); Text(text).textSelection(.enabled) }
    }

    private func refresh() async {
        do {
            let next: PhoneTask = try await session.request(.detail, args: [initial.id])
            guard !Task.isCancelled else { return }
            detail = next; readProblem = nil
            if showingCrew && next.startedAt != nil {
                let transcript: PhoneCrew = try await session.request(.crew, args: [initial.id])
                let running: PhoneCrewLive = try await session.request(.live, args: [initial.id])
                guard !Task.isCancelled else { return }
                crew = transcript; live = running
            }
        } catch { if !Task.isCancelled { readProblem = error.localizedDescription } }
    }

    private func change(_ channel: PhoneRequest, args: [Any], clearDraft: Bool = false) {
        guard !busy, session.canChange else { return }
        if clearDraft && draft.utf16.count > PhoneLimits.steer { problem = "This message is too long. Shorten it before sending."; return }
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                let answer: PhoneAnswer = try await session.request(channel, args: args)
                try answer.accepted()
                if clearDraft { draft = "" }
                await refresh()
            } catch { problem = error.localizedDescription }
        }
    }
}

private struct CrewResult: View {
    let session: ReadOnlySession
    let taskID: String
    let result: PhoneCrew.Line.Result
    @State private var open = false
    @State private var text: String?
    var body: some View {
        DisclosureGroup("\(result.lines) lines · \(result.preview)", isExpanded: $open) {
            Text(text ?? "Reading…").textSelection(.enabled).font(PhoneFont.mono)
        }.task(id: open) {
            guard open else { return }
            do {
                let read: PhoneResultText? = try await session.request(.result, args: [taskID, result.ref])
                guard !Task.isCancelled else { return }
                text = read.map { $0.text + ($0.cut > 0 ? "\n\($0.cut) more characters are not shown." : "") } ?? "No result to read."
            } catch { text = error.localizedDescription }
        }
    }
}
