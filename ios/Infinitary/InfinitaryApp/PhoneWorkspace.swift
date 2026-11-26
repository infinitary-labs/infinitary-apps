import InfinitaryKit
import SwiftUI
import Observation

extension EnvironmentValues {
    /// Opens the phone's Settings sheet at a place, which the window that presents Settings supplies; with none, nothing opens.
    @Entry var phoneOpenSettings: @MainActor (PhoneSettingsPlace) -> Void = { _ in }
}

/// Only the entry actually on screen points a message at its card or task.
@MainActor @Observable final class PhoneMessageContext {
    enum Card: Equatable { case current(String), past(String) }
    var card: Card?
    var cardsVisible = true
    var taskID: String?
    /// INF-1517: a card a Tasks row brought back, shown on Home once the computer's stack holds it again.
    var restoring: String?
    /// INF-1524: a task key pressed on a card, for Tasks to open its record.
    var openTask: String?
    /// INF-2935: a closed card a task record's Cards row read again, for Home to show as a past card.
    var pastCard: String?
    /// INF-3830 piece 3: a task a panel pointed at from the captain's own tap, for Tasks to open as a row's tap opens
    /// it, or straight to its record.
    struct PointTask: Equatable { let id: String; let record: Bool }
    var pointTask: PointTask?
    /// INF-3830 piece 3: a card Home brings forward, the computer's or one of a panel's own (`PhonePanelsModel`).
    var showOnHome: String?
    /// INF-1208's direction C: Tasks shows a record in the panel's place, so the sidebar's picker makes way for its back.
    var recordInPlace = false
    /// The captain's Maximize card: a side panel shares the window with Home, so the shown card offers its size control.
    var cardSizeOffered = false
    /// Home shows a card, the computer's or a panel's own, which a maximized card needs; with none the split shows.
    var cardShown = false
    var cardWidth: String?
    var cardFirst = false
    var replyTucked = false
    /// INF-1524: a card's draft button, or a panel's `point.draft`, for the message box to take its words, unsent.
    var draft: String?
    /// A panel's `point.openSettings`, for Settings to open there.
    var openSettings: PhoneSettingsPlace?
    /// INF-2568: the software keyboard is up, and a card's reply field, or a text box in its body (INF-3427), holds its
    /// focus; a phone on its side then has no room for the pager (`PhoneCards`).
    var keyboardUp = false
    var replyFocused = false
    /// INF-1208's direction C: the message box holds the keyboard's focus.
    var composerFocused = false
    /// INF-1208's direction C: a panel's own text field holds the keyboard's focus on a foldable's pages.
    var panelFieldFocused = false
    /// INF-1208's direction C: a text box in a panel's own card on Home holds the keyboard's focus, which places a
    /// foldable's pages as the message box does.
    var panelCardTyping = false
    /// INF-3468, the captain: "hide pager and everything below the card (the main chat input etc) to make more space.
    /// they come back when the keyboard gets collapsed". On every device, upright or on its side, while a text box in the
    /// shown card holds the keyboard, the pager and the message box with its last turn step aside for the card, a
    /// computer's card or a panel's own card (INF-4350).
    var composerAside: Bool { keyboardUp && (replyFocused || panelCardTyping) }
    /// The captain's Approve and build on comfortable Apple Pencil input: where the Pencil's move rule puts the message
    /// box (`PhonePencilPlacement`), and when a touch last came down and whether it was the Pencil, so a field's focus
    /// knows what gave it. Held only while Infinitary runs.
    var pencil = PhonePencilPlacement()
    var lastTouch: (pencil: Bool, at: Date)?
    /// The message box stands at the top with a Pencil in hand, so it and a card's reply field keep four lines of room.
    var pencilRoom = false
    /// Whether the touch that just gave a field focus was the Pencil's: one down under a second ago. A hardware key or a
    /// trackpad gives focus with no Pencil touch.
    var focusFromPencil: Bool {
        guard let lastTouch else { return false }
        return lastTouch.pencil && Date().timeIntervalSince(lastTouch.at) < 1
    }
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

/// INF-1062, the captain's one-row bar: the places the strip in the top bar switches between, in its order.
/// Home holds the cards and the message box; Tasks, Activity and Panels run to the foot with nothing over them.
/// INF-3830 piece 2, the captain's entry=tab: Panels is the fourth, shown only while the computer has panels to draw.
enum PhoneTab: CaseIterable {
    case home, tasks, activity, panels

    var title: String {
        switch self {
        case .home: PhoneMessages.phoneTabHome()
        case .tasks: PhoneMessages.phoneTabTasks()
        case .activity: PhoneMessages.phoneTabActivity()
        case .panels: PhoneMessages.phoneTabPanels()
        }
    }
    var identifier: String { "tab-\(self)" }
    /// INF-1334, the captain's icons: a house for Home, a checklist for the tasks, and a pulse line for Activity,
    /// the shape of the app's own activity glyph.
    var symbol: String {
        switch self {
        case .home: "house"
        case .tasks: "checklist"
        case .activity: "waveform.path.ecg"
        case .panels: "rectangle.3.group"
        }
    }
    /// Command-1 to Command-4, in the strip's order.
    var key: KeyEquivalent {
        switch self {
        case .home: "1"
        case .tasks: "2"
        case .activity: "3"
        case .panels: "4"
        }
    }
}

/// Shared shell slots. The composer has one structural identity across tabs and window layouts.
/// Home owns its card stack; the joined workspace supplies Tasks and the message composer.
struct PhoneWorkspace<Tasks: View, Composer: View>: View {
    let session: ReadOnlySession
    let tasks: Tasks?
    let composer: Composer?
    @Environment(\.scenePhase) private var scenePhase
    @State private var panelKeySelected = false
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(PhoneAppearance.self) private var appearance: PhoneAppearance?
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.phoneOpenSettings) private var openSettings
    @State private var selection = PhoneTab.home
    /// INF-1590: whether the bar and the tab controller show the wide layout, which a rotation reaches once its
    /// animation has ended, and whether one into the wide layout already shows Home (see `PhoneResizeWatch`).
    @State private var wideBar = false
    @State private var homeAhead = false
    @State private var resizing = PhoneResizing()
    @State private var messageContext: PhoneMessageContext
    @State private var rail = Rail.tasks
    @State private var panels: PhonePanelsModel

    init(session: ReadOnlySession, tasks: Tasks?, composer: Composer?) {
        self.session = session; self.tasks = tasks; self.composer = composer
        let context = PhoneMessageContext()
        _messageContext = State(initialValue: context)
        _panels = State(initialValue: PhonePanelsModel(session: session, context: context))
    }

    /// INF-1208's direction A: the window's room decides, so an open iPhone Duo gets the iPad's sidebar (`PhoneLayout`).
    private var wide: Bool { PhoneLayout.wide(horizontal: horizontalSize, vertical: verticalSize, size: viewport) }
    /// INF-1208's direction A: on an open iPhone Duo the sidebar reaches the fold (`PhoneLayout.sidebarWidth`).
    private var sidebarWidth: CGFloat { PhoneLayout.sidebarWidth(width: viewport.width, folds: folds) }
    /// The window's division regions in the workspace's space, read from iOS 27.1, that Split at the fold lets the layout
    /// heed; none before iOS 27.1, and none while the switch is off, so an open Duo then lays out as an iPad does.
    private var folds: [CGRect] { heeded(window).folds }
    private var split: Bool { appearance?.splitAtFold ?? true }
    /// A reading with its folds dropped while Split at the fold is off: no pages, and a record keeps its sheet.
    private func heeded(_ reading: PhoneLayout.Room) -> PhoneLayout.Room {
        PhoneLayout.Room(size: reading.size, folds: PhoneLayout.heeded(folds: reading.folds, split: split),
                         active: PhoneLayout.heeded(folds: reading.active, split: split))
    }
    /// The workspace's size, keyboard left out, from the same reading as its folds so the two never disagree.
    private var viewport: CGSize { window.size }
    /// INF-1208's direction C: the workspace's size and the folds in its space, every one and the active ones alone, and
    /// Home's own (`phoneReadsRoom`).
    @State private var window = PhoneLayout.Room()
    @State private var room = PhoneLayout.Room()
    /// INF-1208's direction C: the sidebar beside Home, or a panel above or below a fold that runs across the window.
    private var pages: PhoneLayout.Pages {
        PhoneLayout.pages(wide: wide, sidebar: sidebarWidth, horizontal: horizontalSize, vertical: verticalSize,
                          window: heeded(window), home: heeded(room),
                          typing: messageContext.keyboardUp && (messageContext.composerFocused || messageContext.replyFocused
                                                                   || messageContext.panelCardTyping),
                          panelTyping: messageContext.keyboardUp && messageContext.panelFieldFocused)
    }
    /// Whether a panel shows beside Home, so the strip leaves the bar and Home is always shown.
    private var paged: Bool { pages != .column }
    /// INF-1208's direction C: on a foldable's page a record opens in the panel's place; an iPad keeps its sheet.
    private var recordInPlace: Bool { PhoneLayout.recordInPlace(pages, width: viewport.width, folds: folds) }
    /// The captain's "Yes, move it under the side panel": the message box at the foot of the sidebar's page like a book.
    private var composerUnderPanel: Bool { PhoneLayout.composerUnderPanel(pages, width: viewport.width, folds: folds) }
    /// The captain's Maximize card: the shown card takes Home's room while the panel and the message box step aside.
    private var maximized: Bool {
        PhoneLayout.maximized(pages, chosen: appearance?.cardMaximized ?? false, cardShown: messageContext.cardShown)
    }
    /// Only the flat split poses get the Duo default. A half-folded device keeps its two pages.
    private var openDuo: Bool {
        guard window.active.isEmpty else { return false }
        switch pages {
        case .beside: return composerUnderPanel
        case .panelAbove, .typing, .panelTyping: return true
        default: return false
        }
    }
    private var panelsFolded: Bool {
        guard messageContext.cardShown else { return false }
        if openDuo {
            // Showing panels is a lasting choice. Only the automatic fold waits for the panel keyboard.
            return appearance?.duoPanelsShown != true && !(messageContext.keyboardUp && messageContext.panelFieldFocused)
        }
        // A task record opened from the card must still have a presenting panel on iPad.
        guard wide, window.folds.isEmpty, messageContext.taskID == nil else { return false }
        return PhoneLayout.cardNeedsPanelRoom(width: messageContext.cardWidth, stage: viewport.width - sidebarWidth - 1)
    }
    private var sharedFoot: Bool {
        openDuo && messageContext.cardShown && !maximized && !messageContext.composerAside && !pages.homeWaits
            && !messageContext.keyboardUp && !composerSeparate
    }
    private var composerSeparate: Bool { composerUnderPanel && !panelsFolded }
    /// The captain's Approve and build on comfortable Apple Pencil input: with a Pencil in hand and the switch on, the
    /// message box stands at the top of Home's column, upright or beside the sidebar. A window with a fold, a Duo's, keeps
    /// today's placement.
    private var composerOnTop: Bool {
        PhoneLayout.composerOnTop(pages, pencil: messageContext.pencil.top, chosen: appearance?.pencilTop ?? true,
                                  folds: window.folds, composerUnderPanel: composerUnderPanel)
    }
    private var offersPanelToggle: Bool {
        shown == .home && openDuo && messageContext.cardShown && !messageContext.keyboardUp && !maximized
    }
    private var takesPanelKeys: Bool {
        offersPanelToggle && scenePhase == .active && messageContext.taskID == nil
            && !messageContext.composerFocused && !messageContext.replyFocused
            && !messageContext.panelFieldFocused && !messageContext.panelCardTyping
    }
    private func togglePanels() {
        panelKeySelected = false
        appearance?.duoPanelsShown = panelsFolded
    }
    private enum Rail: Hashable { case tasks, activity, panels }
    /// The wide layout (an iPad on its side, an open Duo) always shows the stage with its sidebar, without losing the compact tab selection.
    private var shown: PhoneTab { wideBar || homeAhead ? .home : selection }
    private var tabs: [PhoneTab] {
        PhoneTab.allCases.filter { ($0 != .tasks || tasks != nil) && ($0 != .panels || panels.available) }
    }

    private var workspaceTabs: some View {
        // INF-1062: the system tab controller holds the tabs with its own bar hidden; the strip in the top bar is the one control.
        // With its bar hidden the controller has no press of its own, so it never writes the selection: a write from it
        // could only repeat the strip or put back the tab it showed before a press (INF-1649 review R9: a Tasks press
        // right after launch, while Home's card was still loading, stayed on Home), as a second strip could.
        TabView(selection: Binding(get: { shown }, set: { _ in })) {
            tab(.home) { home }
            // INF-944 item 6: Activity is the last tab.
            // INF-2764: the Tasks list kept while another tab shows reads nothing until it shows again.
            if let tasks { tab(.tasks) { noticed(tasks.background(PhoneTheme.background)).environment(\.phoneTasksShown, shown == .tasks)
                // INF-1208's direction C: with records in the panel's place, the sidebar's list opens them.
                .environment(\.phoneTasksTakesPoints, !recordInPlace) } }
            tab(.activity) { noticed(activity.background(PhoneTheme.background).accessibilityIdentifier("activity-list")) }
            if panels.available { tab(.panels) { noticed(PhonePanelsColumn(model: panels).background(PhoneTheme.background)) } }
        }
        .toolbar {
            if offersPanelToggle {
                ToolbarItem(placement: .topBarLeading) {
                    let showing = !panelsFolded
                    Button(action: togglePanels) {
                        Text(showing ? PhoneMessages.shellCardFoldPanels() : PhoneMessages.shellCardShowPanels())
                            .font(PhoneFont.callout).lineLimit(1).minimumScaleFactor(0.75)
                    }
                    .overlay {
                        if takesPanelKeys && panelKeySelected {
                            Capsule().strokeBorder(PhoneTheme.accent, lineWidth: 1.5).allowsHitTesting(false)
                        }
                    }
                    .accessibilityValue(Text(verbatim: takesPanelKeys && panelKeySelected ? "1" : "0"))
                    .accessibilityIdentifier("toggle-phone-panels")
                }
            }
            // INF-1062: the strip sits in the bar's middle; the wide layout shows the stage beside its sidebar and needs none.
            if !wideBar {
                ToolbarItem(placement: .principal) {
                    PhoneTabStrip(tabs: tabs, selection: $selection)
                }
            }
        }
        // The card replaces the crew scene, so their browsing responders never own the keys together.
        .background {
            PhoneBrowsingKeys(active: takesPanelKeys, returnOpens: true, keys: [.next, .stop], yieldsToPresentations: true) { key in
                guard takesPanelKeys else { return }
                switch key {
                case .next: panelKeySelected.toggle()
                case .open: if panelKeySelected { togglePanels() }
                case .stop: panelKeySelected = false
                default: break
                }
            }
        }
        .onChange(of: takesPanelKeys) { _, takesKeys in if !takesKeys { panelKeySelected = false } }
    }

    var body: some View {
        workspaceTabs
        .task(id: session.notice) {
            // A reply notice leaves on its own; one about a new card waits until it is read or swiped.
            guard let notice = session.notice, notice.reply, !voiceOver else { return }
            try? await Task.sleep(for: .seconds(5))
            if session.notice == notice { session.notice = nil }
        }
        .task(id: session.changeNotice) {
            // INF-2553: the words about a taken-back change stay long enough to read, then leave on their own.
            guard let change = session.changeNotice, !voiceOver else { return }
            try? await Task.sleep(for: .seconds(8))
            if session.changeNotice == change { session.changeNotice = nil }
        }
        // INF-2095: the isolated phone gate's menu tap probe, in a simulator build with its switch only.
        .overlay(alignment: .topLeading) {
            if let probe = PhoneMenuTapProbe.shared { PhoneMenuTapProbeReading(probe: probe).id(probe.redraws) }
        }
        .task { PhoneMenuTapProbe.shared?.install(session) }
        .task(id: session.servesPanels) { await panels.run() }
        // A panel that decides for itself whether it shows runs out of sight until it says so.
        .background { PhonePanelsOutOfSight(model: panels) }
        // A folded or hidden panel keeps running; one on the screen is told so, and the tab leaves once none is left.
        .onChange(of: shown == .panels || (wideBar && !panelsFolded && !maximized && rail == .panels), initial: true) { _, visible in panels.visible = visible }
        .onChange(of: panels.available) { _, available in
            guard !available else { return }
            if selection == .panels { selection = .home }
            if rail == .panels { rail = tasks == nil ? .activity : .tasks }
        }
        .environment(messageContext)
        .environment(panels)
        // The first reading is the layout the workspace opens in, so the bar starts there.
        .onChange(of: paged, initial: true) { old, paged in if old == paged { wideBar = paged } else { settle(paged) } }
        .onChange(of: shown == .home, initial: true) { _, visible in messageContext.cardsVisible = visible }
        // The message box is Home's alone, so a keyboard typing into it closes with the tab it leaves.
        .onChange(of: shown) { _, tab in if tab != .home { dismissPhoneKeyboard() } }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
            if phoneKeyboardArrives(note) { messageContext.keyboardUp = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            messageContext.keyboardUp = false
        }
        .onChange(of: messageContext.restoring) { _, id in if id != nil { selection = .home } }
        .onChange(of: messageContext.showOnHome) { _, id in if id != nil { selection = .home } }
        // A panel's draft starts the message on Home, whose message box takes the words once it shows.
        .onChange(of: messageContext.draft) { _, draft in if draft != nil { selection = .home } }
        .onChange(of: messageContext.openSettings) { _, place in
            guard let place else { return }
            messageContext.openSettings = nil
            openSettings(place)
        }
        .onChange(of: messageContext.pointTask) { _, point in
            guard point != nil, tasks != nil else { return }
            if paged { rail = .tasks; restoreCard() } else { selection = .tasks }
        }
        // INF-4794: a card push's tap opens its card on Home, as the pill's tap does.
        .onChange(of: session.pushOpens) { _, _ in selection = .home }
        .onChange(of: messageContext.pastCard) { _, id in
            guard let id else { return }
            messageContext.pastCard = nil
            selection = .home; session.showCardID = id
        }
        // INF-1524: a card's task key opens its record on Tasks, or in the sidebar beside the stage.
        .onChange(of: messageContext.openTask) { _, key in
            guard key != nil, tasks != nil else { return }
            if paged { rail = .tasks; restoreCard() } else { selection = .tasks }
        }
        .onChange(of: paged, initial: true) { _, paged in messageContext.cardSizeOffered = paged }
        .onChange(of: composerOnTop, initial: true) { _, top in messageContext.pencilRoom = top }
        // The Pencil's move rule hears each field's focus and what gave it, and iPadOS's own reading on each return.
        .onChange(of: messageContext.composerFocused || messageContext.replyFocused) { _, focused in
            if focused { messageContext.pencil.focused(by: messageContext.focusFromPencil ? .pencil : .other) }
            else { messageContext.pencil.unfocused() }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            guard phase == .active else { return }
            let expected = phonePencilExpected()
            if expected { appearance?.sawPencil() }
            messageContext.pencil.expected(expected)
        }
        .background {
            PhonePencilWatch(pencil: { onField in
                appearance?.sawPencil()
                messageContext.pencil.pencil(onField: onField)
            }, touched: { pencil in messageContext.lastTouch = (pencil, Date()) }).frame(width: 0, height: 0)
        }
        .onChange(of: openDuo, initial: true) { _, enabled in
            messageContext.cardFirst = enabled
            if !enabled { messageContext.replyTucked = false }
        }
        .background(alignment: .top) {
            // INF-1590: Home brought in for a turn into landscape is laid out at the new size while the window is still
            // upright, so this fill reaches past the workspace's foot and the root's system white never shows.
            PhoneTheme.background.frame(height: max(viewport.width, viewport.height)).ignoresSafeArea().allowsHitTesting(false)
        }
        // Measure window space without treating the keyboard as an orientation change, with its folds in one reading.
        .phoneReadsRoom($window)
        .onChange(of: window.folds, initial: true) { _, found in
            // Split at the fold shows in Settings once this device has shown a fold, whatever the switch reads.
            if PhoneLayout.foldsDown(found) { appearance?.sawFold() }
        }
        .background {
            PhoneResizeWatch(resizing: resizing) { size in
                // A rotation into the wide layout brings Home in before it starts, so Home turns with the window.
                guard PhoneLayout.wide(horizontal: horizontalSize, vertical: verticalSize, size: size), !wideBar, !homeAhead, selection != .home else { return false }
                homeAhead = true
                let ended = resizing.ended
                resizing.ended = { ended(); homeAhead = false }
                return true
            }.frame(width: 0, height: 0)
        }
    }

    /// A card's task key or a panel's pointing opens the record in the sidebar, so a maximized card gives the split back
    /// for the record to show, as the Mac restores a card for the main message.
    private func restoreCard() {
        if maximized { appearance?.cardMaximized = false }
        if openDuo && panelsFolded { appearance?.duoPanelsShown = true }
    }

    /// INF-1590: the strip, and a tab other than Home, follow the layout once a rotation has ended, and on the main
    /// queue's next turn when no rotation runs.
    private func settle(_ wide: Bool) {
        if resizing.running > 0 {
            resizing.ended = { wideBar = wide; homeAhead = false }
        } else {
            DispatchQueue.main.async { wideBar = wide; homeAhead = false }
        }
    }

    /// Each tab keeps its own state while another is shown, so a draft, a scroll position and a search survive a change
    /// of tab (INF-209), and the tab controller takes a tab that is away out of the view hierarchy, so nothing in it is
    /// drawn, pressable or read. The reach line sits under the bar on every tab.
    private func tab(_ tab: PhoneTab, @ViewBuilder content: () -> some View) -> some View {
        content()
            .safeAreaInset(edge: .top, spacing: 0) { reachLine(tab) }
            // INF-1208's direction C: the tab controller asks the shown tab about the bar, so each tab asks for one row.
            .phoneOneRowBar()
            .toolbar(.hidden, for: .tabBar)
            .tag(tab)
    }

    /// INF-1062: Home is the stage and, under it in the same column, the last turn and the message box; on a landscape
    /// iPad the sidebar stands beside both. One place in the tree for either layout keeps one draft (INF-209).
    /// INF-3462: the crew scene is Home's bottom layer, drawn across the window, with all of this over it.
    private var home: some View {
        PhoneCards(session: session, sharedFoot: sharedFoot) { stage, pager in
            homePages(stage: stage, pager: pager)
        }
    }

    private func homePages(stage: some View, pager: some View) -> some View {
        // INF-1208's direction C: one layout for every pose, so each part keeps its place in the tree as the window
        // turns or folds (`PhonePagesLayout`).
        // INF-4838: the workspace's one reading of Home's room feeds the layout, which keeps the card and the message box
        // off the fold by arithmetic as it places them.
        PhonePagesLayout(pages: pages, composerUnderPanel: composerUnderPanel, composerOnTop: composerOnTop, maximized: maximized,
                         folds: heeded(room).folds, panelsFolded: panelsFolded, openDuo: openDuo,
                         cardWidth: openDuo && !wide ? nil : PhoneLayout.readingWidth(messageContext.cardWidth)) {
            if paged {
                // Clipped, so a panel squeezed by the keyboard draws nothing past its page. Under a maximized card it
                // waits hidden in its place, running, its pick and scroll kept for Restore.
                sidebar.clipped().phoneWaits(maximized || panelsFolded).layoutValue(key: PhonePagesRole.self, value: .panel)
                if case .beside = pages {
                    Rectangle().fill(PhoneTheme.line).opacity(maximized || panelsFolded ? 0 : 1)
                        .layoutValue(key: PhonePagesRole.self, value: .divider)
                }
            }
            // INF-1208's direction A: on an open iPhone Duo the layout keeps the card to one side of its fold, unless it
            // is maximized across both pages.
            noticed(stage.frame(maxWidth: .infinity, maxHeight: .infinity), home: true)
                // One element, so its waiting leaves the cards beside the shown one out of accessibility (`phoneWaits`).
                .accessibilityElement(children: .contain)
                .phoneWaits(pages.homeWaits)
                .layoutValue(key: PhonePagesRole.self, value: .stage)
            if sharedFoot { pager.layoutValue(key: PhonePagesRole.self, value: .pager) }
            if let composer {
                composer
                    .fixedSize(horizontal: false, vertical: true)
                    // Stepped aside, it answers to its own name, so a reading of the message box never finds it undrawn.
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(messageContext.composerAside ? "phone-composer-aside" : "phone-composer")
                    .padding(.horizontal, PhoneTheme.space4)
                    .padding(.bottom, PhoneTheme.space2)
                    // INF-2568 and INF-3468, the captain: "hide pager and everything below the card (the main chat
                    // input etc) to make more space". While a text box in a card holds the keyboard, the message box,
                    // the last turn and its notes step aside, kept in place so the draft stays, and the card keeps
                    // the message box's 8 points above the keyboard.
                    .frame(height: messageContext.composerAside ? 0 : nil, alignment: .top)
                    .opacity(messageContext.composerAside ? 0 : 1).allowsHitTesting(!messageContext.composerAside)
                    .accessibilityHidden(messageContext.composerAside)
                    .padding(.bottom, messageContext.composerAside ? PhoneTheme.space2 : 0)
                    // INF-1208's direction A: the layout keeps the message box to the card's side of the fold.
                    // Under a maximized card the message box waits hidden, its draft kept, as the Mac's main message does.
                    .phoneWaits(pages.homeWaits || maximized)
                    .layoutValue(key: PhonePagesRole.self, value: .composer)
            }
        }.phoneReadsRoom($room).phoneSceneBackdrop().background(PhoneTheme.background)
            // INF-1208's direction C: the crew scene's Open task brings the record to the Tasks panel's place too.
            .environment(\.phoneRecordInPlace, recordInPlace)
    }

    /// INF-1062, the captain's pick: the computer's name left the bar, so one line under it on every tab says the reach
    /// with its time while the computer is not in reach, and nothing while it is. INF-589 item 11: said once.
    /// INF-3462: on Home the line stands bare over the crew scene, so no band of its own cuts the scene straight.
    @ViewBuilder private func reachLine(_ tab: PhoneTab) -> some View {
        if session.reach != "in-reach" {
            PhoneReach(session: session, oneLine: true)
                .padding(.horizontal, PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
                .frame(maxWidth: .infinity)
                .background(tab == .home ? .clear : PhoneTheme.background)
                .accessibilityElement(children: .contain).accessibilityIdentifier("reach-line")
        }
    }

    /// INF-589 item 6, placed by item 16: the pill sits at the top of what it is over, under the bar and beside the sidebar.
    /// An iPhone on its side gives the card that height, so it shows no pill: a new card's waits until it is upright, and a
    /// change taken back says why on its place's own line instead (`ReadOnlySession.takenBack`), until the pill shows it upright.
    /// INF-1524, the captain's pick: on Home a new card is counted beside the pager instead, so only a reply's pill shows there.
    private func noticed(_ content: some View, home: Bool = false) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                // INF-2553: a change shown at the tap that the computer refused or could not confirm says why here,
                // in front of any other notice, since it is about what the captain just did.
                if let change = session.changeNotice, !phoneOnItsSide(verticalSize) {
                    PhoneChangePill(notice: change) { if session.changeNotice == change { session.changeNotice = nil } }
                    .task(id: change.id) { session.noticeShown(change) }
                    .padding(.top, PhoneTheme.space2).padding(.horizontal, PhoneTheme.space4)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                } else if let notice = session.notice, !phoneOnItsSide(verticalSize), !(home && !notice.reply),
                   !(messageContext.cardsVisible && messageContext.card == .current(notice.cardID)) {
                    PhoneNoticePill(notice: notice, open: {
                        selection = .home; session.showCardID = notice.cardID; session.notice = nil
                    }, dismiss: { session.notice = nil })
                    .padding(.top, PhoneTheme.space2).padding(.horizontal, PhoneTheme.space4)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                }
            }.animation(.snappy, value: session.notice).animation(.snappy, value: session.changeNotice)
        }
    }

    private var activity: some View {
        PhoneActivity(lines: session.activity, board: session.board,
                      openTask: tasks == nil ? nil : { messageContext.openTask = $0 })
    }

    // INF-589 item 16: Tasks and Activity as a segmented pair at the sidebar's top, each scrolling alone.
    // INF-944 item 6: in the tabs' order, opening on Tasks.
    private var sidebar: some View {
        VStack(spacing: 0) {
            if (tasks != nil || panels.available) && !(rail == .tasks && messageContext.recordInPlace) {
                Picker(PhoneMessages.phoneWorkspaceShow(), selection: $rail) {
                    if tasks != nil { Text(PhoneMessages.phoneTabTasks()).tag(Rail.tasks) }
                    Text(PhoneMessages.phoneTabActivity()).tag(Rail.activity)
                    if panels.available { Text(PhoneMessages.phoneTabPanels()).tag(Rail.panels) }
                }.pickerStyle(.segmented).labelsHidden()
                    .padding([.horizontal, .top], PhoneTheme.space4).padding(.bottom, PhoneTheme.space2)
                    // INF-1208's direction C: a page wider than the reading column keeps the picker over its lists.
                    .frame(maxWidth: PhoneColumn.width)
                    .accessibilityIdentifier("sidebar-picker")
            }
            if let tasks, rail == .tasks { tasks.environment(\.phoneRecordInPlace, recordInPlace) }
            else if rail == .panels, panels.available { PhonePanelsColumn(model: panels) }
            else { activity }
        }
        .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity).background(PhoneTheme.panel)
        .accessibilityElement(children: .contain).accessibilityIdentifier("phone-sidebar")
    }
}

/// INF-1590: how many of the window's size changes, such as rotations, are still animating, and what runs once the
/// last has ended. A plain class, so a change draws nothing.
@MainActor final class PhoneResizing {
    var running = 0
    var ended: () -> Void = {}
}

/// INF-1590: a rotation lays the window out inside UIKit's animation. Views that left or entered the window while it
/// ran, such as the strip and the tab the tab controller left, at times left one of its animations started and never
/// stopped, so XCTest's wait for the app to settle never ended. Home, put back once a rotation into landscape had ended,
/// came back short by a keyboard inset it took while out of the window. So this view controller, with no view of its
/// own, hears each size change before UIKit animates it, when `before` may bring Home in at once, unanimated, and runs
/// what waits for the change once it ends.
private struct PhoneResizeWatch: UIViewControllerRepresentable {
    let resizing: PhoneResizing
    let before: (CGSize) -> Bool
    func makeUIViewController(context: Context) -> Watcher { Watcher(resizing: resizing, before: before) }
    func updateUIViewController(_ watcher: Watcher, context: Context) { watcher.before = before }

    final class Watcher: UIViewController {
        let resizing: PhoneResizing
        var before: (CGSize) -> Bool
        init(resizing: PhoneResizing, before: @escaping (CGSize) -> Bool) {
            self.resizing = resizing; self.before = before
            super.init(nibName: nil, bundle: nil)
        }
        required init?(coder: NSCoder) { nil }
        override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
            resizing.running += 1
            UIView.performWithoutAnimation {
                if before(size) { view.window?.rootViewController?.view.layoutIfNeeded() }
            }
            super.viewWillTransition(to: size, with: coordinator)
            coordinator.animate(alongsideTransition: nil) { [resizing] _ in
                resizing.running -= 1
                guard resizing.running == 0 else { return }
                let ended = resizing.ended
                resizing.ended = {}
                ended()
            }
        }
    }
}

/// INF-1062, the captain's one-row bar: Home, Tasks and Activity in the bar's middle. INF-1328: the captain chose
/// Apple's segmented control, so iOS 26 draws it on glass with the system's own lit tab and no unread dot; the notice
/// pill and the stage's next chevron still mark an unread card. INF-1334: each tab is an icon, and VoiceOver reads its
/// name in a tab bar. The icons keep the bar's own size at every type setting, as the system's bars do.
struct PhoneTabStrip: View {
    let tabs: [PhoneTab]
    @Binding var selection: PhoneTab

    /// INF-1517, the captain's Round: the system's control lights a tab (W - 8) / n - 5.3 points wide and 40 tall in a
    /// strip W wide, measured on an iOS 27 simulator, so this width makes the lit tab a 40-point circle.
    private var roundWidth: CGFloat { CGFloat(tabs.count) * (40 + 16.0 / 3) + 8 }

    private var picker: some View {
        Picker(PhoneMessages.phoneWorkspaceTabs(), selection: $selection) {
            ForEach(tabs, id: \.self) { tab in
                Image(systemName: tab.symbol).accessibilityLabel(tab.title).tag(tab).accessibilityIdentifier(tab.identifier)
            }
        }
        .pickerStyle(.segmented).labelsHidden()
    }

    var body: some View {
        // One segmented control: a second one bound to the same selection can write a stale tab back after a press.
        // The icons keep their size at every type setting, so the round width always fits between the side buttons.
        picker.frame(width: roundWidth)
        .dynamicTypeSize(...DynamicTypeSize.large)
        // A segmented control takes no key equivalents of its own, so Command-1 to -4 ride unseen buttons beside it.
        .background {
            ForEach(tabs, id: \.self) { tab in
                Button(tab.title) { selection = tab }.keyboardShortcut(tab.key, modifiers: .command)
                    .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityLabel(PhoneMessages.phoneWorkspaceTabs())
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
                Text(notice.reply ? PhoneMessages.phoneNoticeReply() : PhoneMessages.phoneNoticeNewCard()).textCase(.uppercase).font(PhoneFont.micro).tracking(PhoneFont.labelTracking)
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
        .accessibilityLabel(PhoneMessages.phoneNoticeLabel(kind: notice.reply ? PhoneMessages.phoneNoticeReply() : PhoneMessages.phoneNoticeNewCard(), title: notice.title))
        .accessibilityHint(PhoneMessages.phoneNoticeOpenHint())
        .accessibilityAction(named: PhoneMessages.phoneNoticeDismiss(), dismiss)
        .accessibilityIdentifier("phone-notice")
    }
}

/// INF-2553: why a change shown at the tap was taken back, in the notice pill's place and surface. A tap or a swipe
/// dismisses it.
private struct PhoneChangePill: View {
    let notice: PhoneChangeNotice
    let dismiss: () -> Void

    var body: some View {
        Button(action: dismiss) {
            Text(notice.words).font(PhoneFont.callout).foregroundStyle(PhoneTheme.text).multilineTextAlignment(.leading)
                .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                .modifier(PhoneNoticeSurface())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).frame(maxWidth: PhoneColumn.inside)
        .highPriorityGesture(DragGesture(minimumDistance: 12).onEnded { _ in dismiss() })
        .accessibilityHint(PhoneMessages.phoneNoticeDismissHint())
        .accessibilityIdentifier("change-notice")
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

/// INF-1845, the captain's plan B: Activity as the Mac's panel draws it, with the Mac's own words. The newest line is
/// at the bottom, and each line is one row: its dot, its key inside the words, the words cut with "…", and its age.
/// The list opens at its newest line and follows each new one while the reader is at the bottom, as a chat does; once
/// they scroll up it stays where they read until they come back down. A tap on a line shows the Mac's line summary
/// (INF-1761); a tap on its key opens the task's record, as a click on a key does on the Mac.
struct PhoneActivity: View {
    let lines: [ActivityLine]
    var board: PhoneBoard?
    /// Opens a task's record by its key; nil where the phone shows no Tasks.
    var openTask: ((String) -> Void)?
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var atBottom = true
    /// Whether the list follows new lines: true until the reader leaves the bottom, and again once they come back.
    @State private var pinned = true
    @State private var summary: Summary?

    private struct Summary: Identifiable { let id: Int; let line: ActivityLine }

    /// What changes when a line arrives, the window slides or the newest line is written again.
    private var newest: String { "\(lines.count)|\(lines.last?.at ?? 0)|\(lines.last?.text ?? "")" }

    var body: some View {
        ScrollView {
            TimelineView(.periodic(from: .now, by: 60)) { timeline in
                LazyVStack(alignment: .leading, spacing: 0) {
                    if lines.isEmpty { Text(PhoneMessages.phoneActivityEmpty()).foregroundStyle(PhoneTheme.muted).font(PhoneFont.callout) }
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        row(line, now: timeline.date)
                            .contentShape(Rectangle())
                            .onTapGesture { summary = Summary(id: index, line: line) }
                    }
                }
            }
            .padding(PhoneTheme.space4).frame(maxWidth: PhoneColumn.width).frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.visibleRect.maxY >= geometry.contentSize.height + geometry.contentInsets.bottom - PhoneTheme.space2
        } action: { _, bottom in atBottom = bottom }
        // Only the reader's own scroll pins or unpins the list, once it has come to rest.
        .onScrollPhaseChange { _, phase in if phase == .idle { pinned = atBottom } }
        .onChange(of: newest) { if pinned { position.scrollTo(edge: .bottom) } }
        // Lines that came while another tab was shown are followed on the way back, too.
        .onAppear { if pinned { position.scrollTo(edge: .bottom) } }
        .sheet(item: $summary) { shown in
            PhoneActivitySummary(line: shown.line, task: task(shown.line.taskKey), project: project(shown.line.taskKey)) {
                summary = nil
            }
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).phoneSheetSurface()
        }
    }

    private func row(_ line: ActivityLine, now: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
            Circle().fill(Self.tone(line.kind)).frame(width: 6, height: 6).accessibilityHidden(true)
            if let key = line.taskKey {
                if let openTask, task(key) != nil {
                    Button(key) { openTask(key) }.buttonStyle(.plain)
                        .font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).underline().fixedSize()
                        .accessibilityHint(PhoneMessages.phoneActivityOpenTaskHint()).accessibilityIdentifier("activity-key")
                } else {
                    Text(key).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).fixedSize()
                }
            }
            Text(line.text).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
                .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("activity-text")
            Text(Self.age(line.at, now: now)).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                .fixedSize().accessibilityLabel(Self.exactTime(line.at))
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    private func task(_ key: String?) -> PhoneTask? {
        guard let key else { return nil }
        return board?.tasks.first { $0.key == key }
    }

    private func project(_ key: String?) -> String? {
        guard let task = task(key) else { return nil }
        return board?.projects.first { $0.id == task.projectId }?.name
    }

    static func exactTime(_ at: Double) -> String {
        PhoneFormats.dateTime(Date(timeIntervalSince1970: at / 1000))
    }

    // The same units as the desktop's feedRelativeAge; wording still comes from the computer.
    static func age(_ at: Double, now: Date) -> String {
        PhoneFormats.relativeAge(at, now: now.timeIntervalSince1970 * 1000)
    }

    static func tone(_ kind: String) -> Color {
        switch kind {
        case "ok": PhoneTheme.accent
        case "warn": PhoneTheme.warning
        case "danger": PhoneTheme.danger
        case "you": PhoneTheme.captain
        default: PhoneTheme.muted
        }
    }
}

/// INF-1845: the Mac's Activity line summary (INF-1761) on the phone, for the line a tap chose: its key, dot and exact
/// time, its whole words, and the task and project it is about. Recorded words, not a second task summary.
private struct PhoneActivitySummary: View {
    let line: ActivityLine
    let task: PhoneTask?
    let project: String?
    let close: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                    if let key = line.taskKey { Text(key).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted) }
                    Circle().fill(PhoneActivity.tone(line.kind)).frame(width: 6, height: 6).accessibilityHidden(true)
                    Text(PhoneActivity.exactTime(line.at)).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                    Spacer()
                    Button(PhoneMessages.phoneCommonClose(), action: close).font(PhoneFont.callout).accessibilityIdentifier("close-activity-summary")
                }
                Text(line.text).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .accessibilityIdentifier("activity-summary-text")
                if let task {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        fact(PhoneMessages.phoneActivityTask(), task.title)
                        if let project { fact(PhoneMessages.phoneActivityProject(), project) }
                    }
                }
            }.padding(PhoneTheme.space5)
        }
        .accessibilityIdentifier("activity-summary")
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space3) {
            Text(label).textCase(.uppercase).font(PhoneFont.micro).tracking(PhoneFont.labelTracking).foregroundStyle(PhoneTheme.muted)
                .frame(width: 64, alignment: .leading)
            Text(value).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}
