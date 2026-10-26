import InfinitaryKit
import SwiftUI
import Observation

/// Only the entry actually on screen points a message at its card or task.
@MainActor @Observable final class PhoneMessageContext {
    enum Card: Equatable { case current(String), past(String) }
    var card: Card?
    var cardsVisible = true
    var taskID: String?
    var fields: [String: String] {
        if let taskID { return ["taskId": taskID] }
        guard cardsVisible else { return [:] }
        switch card {
        case .current(let id): return ["visibleCardId": id]
        case .past(let id): return ["pastCardId": id]
        case nil: return [:]
        }
    }
}

/// INF-1062, the captain's one-row bar: the three places the strip in the top bar switches between, in its order.
/// Home holds the cards and the message box; Tasks and Activity run to the foot with nothing over them.
enum PhoneTab: CaseIterable {
    case home, tasks, activity

    var title: String {
        switch self {
        case .home: "Home"
        case .tasks: "Tasks"
        case .activity: "Activity"
        }
    }
    var identifier: String { "tab-" + title.lowercased() }
    /// INF-1334, the captain's icons: a house for Home, a checklist for the tasks, and a pulse line for Activity,
    /// the shape of the app's own activity glyph.
    var symbol: String {
        switch self {
        case .home: "house"
        case .tasks: "checklist"
        case .activity: "waveform.path.ecg"
        }
    }
    /// Command-1, Command-2 and Command-3, in the strip's order.
    var key: KeyEquivalent {
        switch self {
        case .home: "1"
        case .tasks: "2"
        case .activity: "3"
        }
    }
}

/// Shared shell slots. The composer has one structural identity across tabs and window layouts.
/// Integration: stage = PhoneCards(session:), tasks = PhoneTasks(session:), composer = MessageComposer(session:).
struct PhoneWorkspace<Stage: View, Tasks: View, Composer: View>: View {
    let session: ReadOnlySession
    let stage: Stage
    let tasks: Tasks?
    let composer: Composer?
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var viewport = CGSize.zero
    @State private var selection = PhoneTab.home
    @State private var messageContext = PhoneMessageContext()
    @State private var rail = Rail.tasks

    init(session: ReadOnlySession, stage: Stage, tasks: Tasks?, composer: Composer?) {
        self.session = session; self.stage = stage; self.tasks = tasks; self.composer = composer
    }

    private var wide: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && horizontalSize == .regular && viewport.width > viewport.height
    }
    private var sidebarWidth: CGFloat { min(320, viewport.width * 0.32) }
    private enum Rail: Hashable { case tasks, activity }
    /// A landscape iPad always shows the stage with its sidebar, without losing the compact tab selection.
    private var shown: PhoneTab { wide ? .home : selection }
    private var tabs: [PhoneTab] { tasks == nil ? [.home, .activity] : PhoneTab.allCases }

    var body: some View {
        // INF-1062: the system tab controller holds the tabs with its own bar hidden; the strip in the top bar is the one control.
        TabView(selection: Binding(get: { shown }, set: { if !wide { selection = $0 } })) {
            tab(.home) { home }
            // INF-944 item 6: Activity is the last tab.
            if let tasks { tab(.tasks) { noticed(tasks.background(PhoneTheme.background)) } }
            tab(.activity) { noticed(activity.background(PhoneTheme.background).accessibilityIdentifier("activity-list")) }
        }
        .toolbar {
            // INF-1062: the strip sits in the bar's middle; a landscape iPad shows the stage beside its sidebar and needs none.
            if !wide {
                ToolbarItem(placement: .principal) {
                    PhoneTabStrip(tabs: tabs, selection: $selection)
                }
            }
        }
        .task(id: session.notice) {
            // A reply notice leaves on its own; one about a new card waits until it is read or swiped.
            guard let notice = session.notice, notice.reply, !voiceOver else { return }
            try? await Task.sleep(for: .seconds(5))
            if session.notice == notice { session.notice = nil }
        }
        .environment(messageContext)
        .onChange(of: shown == .home, initial: true) { _, visible in messageContext.cardsVisible = visible }
        // The message box is Home's alone, so a keyboard typing into it closes with the tab it leaves.
        .onChange(of: shown) { _, tab in if tab != .home { dismissPhoneKeyboard() } }
        .background {
            // Measure window space without treating the keyboard as an orientation change.
            GeometryReader { geometry in
                Color.clear.onChange(of: geometry.size, initial: true) { _, size in viewport = size }
            }.ignoresSafeArea(.keyboard)
        }
    }

    /// Each tab keeps its own state while another is shown, so a draft, a scroll position and a search survive a change
    /// of tab (INF-209), and the tab controller takes a tab that is away out of the view hierarchy, so nothing in it is
    /// drawn, pressable or read. The reach line sits under the bar on every tab.
    private func tab(_ tab: PhoneTab, @ViewBuilder content: () -> some View) -> some View {
        content()
            .safeAreaInset(edge: .top, spacing: 0) { reachLine }
            .toolbar(.hidden, for: .tabBar)
            .tag(tab)
    }

    /// INF-1062: Home is the stage and, under it in the same column, the last turn and the message box; on a landscape
    /// iPad the sidebar stands beside both. One place in the tree for either layout keeps one draft (INF-209).
    private var home: some View {
        HStack(spacing: 0) {
            if wide {
                sidebar
                Rectangle().fill(PhoneTheme.line).frame(width: 1)
            }
            VStack(spacing: 0) {
                noticed(stage.frame(maxWidth: .infinity, maxHeight: .infinity))
                if let composer {
                    composer
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityElement(children: .contain).accessibilityIdentifier("phone-composer")
                        .padding(.horizontal, PhoneTheme.space4)
                        .padding(.bottom, PhoneTheme.space2)
                }
            }
        }.background(PhoneTheme.background)
    }

    /// INF-1062, the captain's pick: the computer's name left the bar, so one line under it on every tab says the reach
    /// with its time while the computer is not in reach, and nothing while it is. INF-589 item 11: said once.
    @ViewBuilder private var reachLine: some View {
        if session.contact != "in-reach" {
            PhoneReach(session: session, oneLine: true)
                .padding(.horizontal, PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
                .frame(maxWidth: .infinity)
                .background(PhoneTheme.background)
                .accessibilityElement(children: .contain).accessibilityIdentifier("reach-line")
        }
    }

    /// INF-589 item 6, placed by item 16: the pill sits at the top of what it is over, under the bar and beside the sidebar.
    /// An iPhone on its side gives the card that height, so the pill waits until it is upright.
    private func noticed(_ content: some View) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                // The card already on the stage needs no pill pointing at it.
                if let notice = session.notice, !phoneOnItsSide(verticalSize),
                   !(messageContext.cardsVisible && messageContext.card == .current(notice.cardID)) {
                    PhoneNoticePill(notice: notice, open: {
                        selection = .home; session.showCardID = notice.cardID; session.notice = nil
                    }, dismiss: { session.notice = nil })
                    .padding(.top, PhoneTheme.space2).padding(.horizontal, PhoneTheme.space4)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                }
            }.animation(.snappy, value: session.notice)
        }
    }

    private var activity: some View {
        ScrollView {
            PhoneActivity(lines: session.activity)
                .padding(PhoneTheme.space4).frame(maxWidth: PhoneColumn.width).frame(maxWidth: .infinity)
        }
    }

    // INF-589 item 16: Tasks and Activity as a segmented pair at the sidebar's top, each scrolling alone.
    // INF-944 item 6: in the tabs' order, opening on Tasks.
    private var sidebar: some View {
        VStack(spacing: 0) {
            if tasks != nil {
                Picker("Show", selection: $rail) {
                    Text("Tasks").tag(Rail.tasks)
                    Text("Activity").tag(Rail.activity)
                }.pickerStyle(.segmented).labelsHidden()
                    .padding([.horizontal, .top], PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
            }
            if let tasks, rail == .tasks { tasks } else { activity }
        }
        .frame(width: sidebarWidth).background(PhoneTheme.panel)
        .accessibilityElement(children: .contain).accessibilityIdentifier("phone-sidebar")
    }
}

/// INF-1062, the captain's one-row bar: Home, Tasks and Activity in the bar's middle. INF-1328: the captain chose
/// Apple's segmented control, so iOS 26 draws it on glass with the system's own lit tab and no unread dot; the notice
/// pill and the stage's next chevron still mark an unread card. INF-1334: each tab is an icon, and VoiceOver reads its
/// name in a tab bar. The icons keep the bar's own size at every type setting, as the system's bars do.
struct PhoneTabStrip: View {
    let tabs: [PhoneTab]
    @Binding var selection: PhoneTab

    var body: some View {
        Picker("Tabs", selection: $selection) {
            ForEach(tabs, id: \.self) { tab in
                Image(systemName: tab.symbol).accessibilityLabel(tab.title).tag(tab).accessibilityIdentifier(tab.identifier)
            }
        }
        .pickerStyle(.segmented).labelsHidden().fixedSize()
        .dynamicTypeSize(...DynamicTypeSize.large)
        // A segmented control takes no key equivalents of its own, so Command-1, -2 and -3 ride unseen buttons beside it.
        .background {
            ForEach(tabs, id: \.self) { tab in
                Button(tab.title) { selection = tab }.keyboardShortcut(tab.key, modifiers: .command)
                    .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityLabel("Tabs")
        .accessibilityIdentifier("phone-tabs")
    }
}

/// A quiet pill under the bar: what arrived and the card's title. A tap opens the card; a swipe dismisses it.
private struct PhoneNoticePill: View {
    let notice: PhoneNotice
    let open: () -> Void
    let dismiss: () -> Void
    @State private var drag = CGSize.zero

    var body: some View {
        Button(action: open) {
            HStack(spacing: PhoneTheme.space2) {
                Text(notice.reply ? "Reply" : "New card").textCase(.uppercase).font(PhoneFont.micro).tracking(1)
                    .foregroundStyle(PhoneTheme.accent).fixedSize()
                Text(notice.title).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text).lineLimit(1)
            }
            .padding(.horizontal, PhoneTheme.space4).frame(minHeight: 44)
            .modifier(PhoneNoticeSurface())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain).frame(maxWidth: PhoneColumn.inside)
        .offset(x: drag.width, y: min(0, drag.height))
        .highPriorityGesture(DragGesture(minimumDistance: 12)
            .onChanged { drag = $0.translation }
            .onEnded { value in
                if value.translation.height < -16 || abs(value.translation.width) > 60 { dismiss() }
                else { withAnimation(.snappy) { drag = .zero } }
            })
        .accessibilityLabel("\(notice.reply ? "Reply" : "New card"): \(notice.title)")
        .accessibilityHint("Opens the card")
        .accessibilityAction(named: "Dismiss", dismiss)
        .accessibilityIdentifier("phone-notice")
    }
}

/// INF-944 item 4: the pill floats over content under the bar, so on iOS 26 it is glass, as the bar is.
private struct PhoneNoticeSurface: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) { content.glassEffect(.regular.interactive(), in: Capsule()) } else {
            content.background(PhoneTheme.surface, in: Capsule())
                .overlay { Capsule().strokeBorder(PhoneTheme.line) }
                .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
        }
    }
}

extension PhoneWorkspace where Tasks == EmptyView, Composer == EmptyView {
    init(session: ReadOnlySession, @ViewBuilder stage: () -> Stage) {
        self.session = session; self.stage = stage(); tasks = nil; composer = nil
    }
}

struct PhoneActivity: View {
    let lines: [ActivityLine]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            LazyVStack(alignment: .leading, spacing: PhoneTheme.space3) {
                if lines.isEmpty { Text("No activity yet").foregroundStyle(PhoneTheme.muted).font(PhoneFont.callout) }
                ForEach(Array(lines.reversed().enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        Circle().fill(tone(line.kind)).frame(width: 6, height: 6).accessibilityHidden(true)
                        // INF-589 item 14: the key sits inline before the words at micro size, as the Mac's feed line.
                        HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                            if let key = line.taskKey {
                                Text(key).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).fixedSize()
                            }
                            Text(line.text).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("activity-text")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Text(Self.age(line.at, now: timeline.date)).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                            .fixedSize().accessibilityLabel(Date(timeIntervalSince1970: line.at / 1000)
                                .formatted(date: .abbreviated, time: .shortened))
                    }.accessibilityElement(children: .contain)
                }
            }
        }
    }

    // The same units as the desktop's feedRelativeAge; wording still comes from the computer.
    static func age(_ at: Double, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince1970 - at / 1000))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86400)d"
    }

    private func tone(_ kind: String) -> Color {
        switch kind {
        case "ok": PhoneTheme.accent
        case "warn": PhoneTheme.warning
        case "danger": PhoneTheme.danger
        case "you": PhoneTheme.captain
        default: PhoneTheme.muted
        }
    }
}
