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
    @State private var selection = 0
    @State private var messageContext = PhoneMessageContext()
    @State private var rail = Rail.tasks
    /// The floating footer's top in the window, where each tab's room ends.
    @State private var footerTop: CGFloat?
    @State private var tabClearance = PhoneTabClearance()

    init(session: ReadOnlySession, stage: Stage, tasks: Tasks?, composer: Composer?) {
        self.session = session; self.stage = stage; self.tasks = tasks; self.composer = composer
    }

    private var wide: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && horizontalSize == .regular && viewport.width > viewport.height
    }
    private var sidebarWidth: CGFloat { min(320, viewport.width * 0.32) }
    private enum Rail: Hashable { case tasks, activity }

    var body: some View {
        tabs(footerTop: composer == nil ? nil : footerTop)
            .background { if composer != nil { PhoneTabBarClearance { tabClearance = $0 } } }
            .overlay(alignment: .bottom) {
                footer
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { footerTop = $0 }
                    .padding(.bottom, tabClearance.bottom)
                    .padding(.leading, tabClearance.leading).padding(.trailing, tabClearance.trailing)
            }
            .task(id: session.notice) {
                // A reply notice leaves on its own; one about a new card waits until it is read or swiped.
                guard let notice = session.notice, notice.reply, !voiceOver else { return }
                try? await Task.sleep(for: .seconds(5))
                if session.notice == notice { session.notice = nil }
            }
        .environment(messageContext)
        .onChange(of: wide || selection == 0, initial: true) { _, visible in messageContext.cardsVisible = visible }
        .background {
            // Measure window space without treating the keyboard as an orientation change.
            GeometryReader { geometry in
                Color.clear.onChange(of: geometry.size, initial: true) { _, size in viewport = size }
            }.ignoresSafeArea(.keyboard)
        }
    }

    @ViewBuilder private var footer: some View {
        if let composer {
            composer
                .fixedSize(horizontal: false, vertical: true)
                .background(alignment: .bottom) { PhoneFooterBackdrop() }
                .accessibilityElement(children: .contain).accessibilityIdentifier("phone-composer")
                .padding(.horizontal, PhoneTheme.space4)
                .padding(.bottom, PhoneTheme.space2)
                .padding(.leading, wide ? sidebarWidth + 1 : 0)
        }
    }

    /// INF-589 item 6, placed by item 16: the pill sits at the top of what it is over, under the tabs and beside the sidebar.
    /// An iPhone on its side gives the card that height, so the pill waits until it is upright.
    private func noticed(_ content: some View) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                // The card already on the stage needs no pill pointing at it.
                if let notice = session.notice, !phoneOnItsSide(verticalSize),
                   !(messageContext.cardsVisible && messageContext.card == .current(notice.cardID)) {
                    PhoneNoticePill(notice: notice, open: {
                        selection = 0; session.showCardID = notice.cardID; session.notice = nil
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

    private var stageAndSidebar: some View {
        HStack(spacing: 0) {
            if wide {
                sidebar
                Rectangle().fill(PhoneTheme.line).frame(width: 1)
            }
            noticed(stage.frame(maxWidth: .infinity, maxHeight: .infinity))
        }.background(PhoneTheme.background)
    }

    private func tabs(footerTop: CGFloat?) -> some View {
        // A landscape iPad always shows the stage, without losing the compact tab selection.
        TabView(selection: Binding(get: { wide ? 0 : selection }, set: { if !wide { selection = $0 } })) {
            stageAndSidebar
                .modifier(PhoneFooterSpace(top: footerTop))
                .toolbar(wide ? .hidden : .visible, for: .tabBar)
                .tabItem { Label { Text("Cards") } icon: { PhoneSymbol.cards.image } }.tag(0)
                .badge(session.unreadCards)
            // INF-944 item 6: Activity is the last tab.
            if let tasks {
                noticed(tasks.background(PhoneTheme.background))
                    .modifier(PhoneFooterSpace(top: footerTop))
                    .toolbar(wide ? .hidden : .visible, for: .tabBar)
                    .tabItem { Label { Text("Tasks") } icon: { PhoneSymbol.tasks.image } }.tag(2)
            }
            noticed(activity.background(PhoneTheme.background).accessibilityIdentifier("activity-list"))
            .modifier(PhoneFooterSpace(top: footerTop))
            .toolbar(wide ? .hidden : .visible, for: .tabBar)
            .tabItem { Label { Text("Activity") } icon: { PhoneSymbol.activity.image } }.tag(1)
        }
        // INF-1060: an empty stage has nothing to scroll back up, so its tabs stay out and a receded bar comes back.
        .modifier(PhoneTabRecede(recedes: wide || selection != 0 || messageContext.card != nil))
    }
}

/// Each tab's room ends at the floating footer's top. On iOS 26 the space below is a bar with the system's hard
/// scroll edge (INF-944 item 6), a nearly opaque foot, so rows never show through the last turn or the capsule.
/// A receded iOS 26 bar keeps the full bar's bottom inset while the footer follows it down (INF-1060), so each tab
/// sets that inset aside and reserves what it measures down to the footer: a card gets the room the footer left.
private struct PhoneFooterSpace: ViewModifier {
    let top: CGFloat?
    @State private var bottom: CGFloat = 0
    func body(content: Content) -> some View {
        reserve(content, height: top.map { max(0, bottom - $0) } ?? 0)
            .ignoresSafeArea(.container, edges: top == nil ? [] : .bottom)
            .background {
                // The tab's own frame stops above the inset it sets aside; a reader that ignores it too finds the foot.
                GeometryReader { geometry in
                    Color.clear.onChange(of: geometry.frame(in: .global).maxY, initial: true) { _, foot in bottom = foot }
                }.ignoresSafeArea(.container, edges: .bottom)
            }
    }
    @ViewBuilder private func reserve(_ content: Content, height: CGFloat) -> some View {
        if #available(iOS 26, *) {
            content.safeAreaBar(edge: .bottom, spacing: 0) { Color.clear.frame(height: height) }
                .scrollEdgeEffectStyle(.hard, for: .bottom)
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: height) }
        }
    }
}

/// INF-944 item 4, the captain's answer: on iOS 26 the tab bar recedes while a long card or list scrolls down,
/// and the message box follows the bar it is measured against.
private struct PhoneTabRecede: ViewModifier {
    let recedes: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) { content.tabBarMinimizeBehavior(recedes ? .onScrollDown : .never) } else { content }
    }
}

/// The system's fixed-height tab accessory clips a multi-line composer, so the growing footer floats above the measured tabs.
/// Only the composer's own capsule is drawn; on iOS 18 the page color fades in behind it so scrolled rows never run under its words.
private struct PhoneFooterBackdrop: View {
    var body: some View {
        if #available(iOS 26, *) { Color.clear } else {
            LinearGradient(stops: [.init(color: PhoneTheme.background.opacity(0), location: 0), .init(color: PhoneTheme.background, location: 0.35)],
                startPoint: .top, endPoint: .bottom)
                .padding(.horizontal, -PhoneTheme.space4).padding(.bottom, -PhoneTheme.space2).allowsHitTesting(false)
        }
    }
}

/// A quiet pill under the title: what arrived and the card's title. A tap opens the card; a swipe dismisses it.
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

/// INF-944 item 4: the pill floats over content under the title, so on iOS 26 it is glass, as the bars are.
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
