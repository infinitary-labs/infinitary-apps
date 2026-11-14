import InfinitaryKit
import Observation
import SwiftUI

/// INF-3830 piece 2, the captain's answers entry=tab and layout=column: the computer's panels on their own tab, drawn
/// one under another in the order its rails hold them (docs/ios.md, "Panels"). The tab shows only while the computer
/// serves panels to a phone (`panels-on-the-phone`) and has one a rail would draw. A panel whose own code decides whether
/// it shows (`rail.show`) runs out of sight and counts only once it says it shows (the captain's answer W3 (c)), so the
/// tab never opens on an empty column.
/// Piece 3: the model also holds the panels' cards on Home (`PhonePanelCards`), presses their header buttons, and turns a
/// panel's pointing into the phone's own ways of opening a task or a card (`PhoneMessageContext`).
@MainActor @Observable final class PhonePanelsModel {
    /// The panels the column draws, in the rails' order.
    private(set) var panels: [PhonePanel] = []
    private(set) var hosts: [String: PanelWebHost] = [:]
    /// The folded panels, kept on this device for this computer, so a fold survives closing the app.
    private(set) var folded: Set<String>
    /// Whether the column is on the screen: a panel that is not runs on, out of sight, and is never stopped for it.
    var visible = false { didSet { if visible != oldValue { tellStates() } } }
    /// A stopped panel's Try again is on its way to the computer.
    private(set) var retrying: Set<String> = []
    /// The panels' cards on Home, held on this phone only.
    private(set) var cards = PhonePanelCards()
    /// The page of the card Home shows. Only the shown card runs a page, as on the desktop: a card paged away from is
    /// born again from its kept place when it shows again.
    private(set) var cardHosts: [String: PanelWebHost] = [:]
    /// The entry Home shows, when it is one of the panels' cards.
    var shownCard: String? { didSet { if shownCard != oldValue { releaseCardPages() } } }

    private let session: ReadOnlySession
    private let context: PhoneMessageContext
    private var all: [PhonePanel] = []
    private var layout = PhonePanelLayout()
    private var libraries: [String: Task<PhonePanelLibrary, Error>] = [:]
    private let foldsKey: String

    init(session: ReadOnlySession, context: PhoneMessageContext) {
        self.session = session; self.context = context
        foldsKey = "panels.folded." + session.mac.deviceID
        folded = Set(UserDefaults.standard.stringArray(forKey: foldsKey) ?? [])
    }

    var available: Bool { session.servesPanels && !drawn.isEmpty }

    /// The panels the column draws: every panel, except one that decides for itself and has not said it shows.
    var drawn: [PhonePanel] { panels.filter(counts) }
    /// The panels that decide for themselves and have not said they show: mounted out of sight until they do.
    var undecided: [PhonePanel] { panels.filter { !counts($0) } }
    private func counts(_ panel: PhonePanel) -> Bool { !panel.ownPresence || hosts[panel.id]?.decidedShown == true }

    /// Reads the computer's panels and layout and hears their pushes, for as long as the computer serves them.
    func run() async {
        session.onPanelPush = { [weak self] channel, payload in self?.heard(channel, payload) }
        session.onPanelResync = { [weak self] in
            guard let self else { return }
            for host in hosts.values { host.resync() }
            Task { await self.read() }
        }
        await read()
    }

    private func read() async {
        guard session.servesPanels else { apply(panels: [], layout: PhonePanelLayout()); return }
        async let list = try? session.panelAsk(.pluginsPersonalList, [])
        async let preferences = try? session.panelAsk(.shellPreferences, [])
        let (snapshot, prefs) = await (list, preferences)
        apply(panels: snapshot.map(PhonePanelList.decode) ?? all, layout: prefs.map(PhonePanelLayout.of(preferences:)) ?? layout)
    }

    private func heard(_ channel: String, _ payload: PhoneJSON) {
        switch channel {
        case "inf:plugins:personal": apply(panels: PhonePanelList.decode(payload), layout: layout)
        case "inf:shell:preferences": apply(panels: all, layout: PhonePanelLayout.of(preferences: payload))
        default: break
        }
        for host in hosts.values { host.push(channel, payload) }
    }

    private func apply(panels next: [PhonePanel], layout: PhonePanelLayout) {
        all = next; self.layout = layout
        let shown = PhonePanelOrder.shown(next, layout: layout)
        for panel in shown {
            if let host = hosts[panel.id] { host.update(panel) }
            else { hosts[panel.id] = makeHost(panel, card: nil) }
        }
        let kept = Set(shown.map(\.id))
        for (id, host) in hosts where !kept.contains(id) { host.close(); hosts[id] = nil }
        panels = shown
        // A panel that left the computer's list, or whose code is not built, takes its cards with it (`closeCards`).
        cards.keepOnly(panels: Set(next.filter { $0.frame != nil }.map(\.id)))
        syncCardPages()
        tellStates()
    }

    private func makeHost(_ panel: PhonePanel, card: PhonePanelCardEntry?) -> PanelWebHost {
        let host = PanelWebHost(panel: panel, card: card, session: session, collapsed: card == nil && folded.contains(panel.id)) { [weak self] version throws(PhonePanelFailure) in
            guard let self else { throw .unreadable }
            return try await self.library(version)
        }
        let id = panel.id
        host.onCards = { [weak self] payload throws(PhoneRequestError) in
            guard let self else { throw PhoneRequestError(PhoneMessages.phonePanelWebCannotDo()) }
            return try self.cardCall(panel: id, payload)
        }
        host.onPoint = { [weak self] payload in self?.point(payload) ?? false }
        return host
    }

    // MARK: Piece 3: a panel's cards, header buttons and pointing

    /// The panels' cards as entries of Home's row, after the computer's cards.
    var stackCards: [PhoneCard] { cards.entries.map(PhoneCard.panelCard) }

    /// The panel a card of Home belongs to, as the computer lists it now.
    func panel(of entryID: String) -> PhonePanel? {
        cards.entry(entryID).flatMap { entry in all.first { $0.id == entry.panel } }
    }

    /// The page of a card Home shows, made the first time it shows.
    func cardHost(_ entryID: String) -> PanelWebHost? {
        if let host = cardHosts[entryID] { return host }
        guard let entry = cards.entry(entryID), let panel = all.first(where: { $0.id == entry.panel && $0.frame != nil }) else { return nil }
        let host = makeHost(panel, card: entry)
        // A card's page runs while it shows on Home; it never folds.
        host.setState(collapsed: false, shown: true)
        cardHosts[entryID] = host
        return host
    }

    /// The card showed on Home: it is no longer new.
    func seen(_ entryID: String) { cards.seen(entryID) }

    /// Hide on a panel's card: it leaves Home and its page closes.
    func hide(_ entryID: String) {
        guard let entry = cards.entry(entryID) else { return }
        cards.close(panel: entry.panel, id: entry.id)
        syncCardPages()
    }

    /// A header button's press, the captain's own tap: its named card at the front of Home, or an ask into the panel.
    func press(_ button: PhonePanelHeaderButton, of panel: PhonePanel) {
        if let name = button.emits {
            guard let entryID = cards.emitNamed(panel, name: name, data: button.data) else { return }
            syncCardPages()
            context.showOnHome = entryID
            return
        }
        // An ask button shows only while the panel shows its body, so its page is there to hear the press.
        hosts[panel.id]?.ask(button.id)
    }

    /// A page's card actions, checked by the page against the desktop's schema and the panel's card views first.
    private func cardCall(panel: String, _ payload: PhoneJSON) throws(PhoneRequestError) -> PhoneJSON {
        switch payload["op"].text {
        case "emit":
            let outcome = try cards.emit(panel: panel, payload["card"], front: payload["front"] == .bool(true))
            guard case .up(let id, let show) = outcome else { return .null }
            syncCardPages()
            if show { context.showOnHome = PhonePanelCardEntry.entryID(panel: panel, id: id) }
            return .string(id)
        case "close":
            cards.close(panel: panel, id: payload["id"].text ?? "")
            syncCardPages()
            return .null
        case "keep":
            cards.keep(panel: panel, id: payload["id"].text ?? "", payload["kept"])
            syncCardPages()
            return .null
        case "open":
            return cards.open(panel: panel, shown: shownCard)
        default:
            throw PhoneRequestError(PhoneMessages.phonePanelWebCannotDo())
        }
    }

    /// A page's pointing, from the captain's own tap in it: a task opens as a Tasks row's tap opens it, or straight to its
    /// record; a waiting card comes forward on Home. Each names something the phone holds, or does nothing.
    private func point(_ payload: PhoneJSON) -> Bool {
        switch payload["op"].text {
        case "task", "record":
            guard let id = payload["taskId"].text, let board = session.board else { return false }
            // A task the board read without its closed rows may be closed work: Tasks reads those rows and opens it then.
            guard board.tasks.contains(where: { $0.id == id }) || board.closedLeftOut != nil else { return false }
            context.pointTask = PhoneMessageContext.PointTask(id: id, record: payload["op"].text == "record")
            return true
        case "card":
            guard let id = payload["cardId"].text, session.stack.contains(where: { $0.id == id }) else { return false }
            context.showOnHome = id
            return true
        default:
            return false
        }
    }

    /// Every open card's page hears its card as it now stands, and a card that left Home closes its page.
    private func syncCardPages() {
        for (entryID, host) in cardHosts {
            if let entry = cards.entry(entryID) { host.setCard(entry) } else { host.close(); cardHosts[entryID] = nil }
        }
    }

    /// Only the shown card runs a page.
    private func releaseCardPages() {
        for (entryID, host) in cardHosts where entryID != shownCard { host.close(); cardHosts[entryID] = nil }
    }

    /// The library the panels' files were built for, read once a version and kept on this device.
    private func library(_ version: String) async throws(PhonePanelFailure) -> PhonePanelLibrary {
        let task = libraries[version] ?? Task { [session] in
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            if let kept = PhonePanelLibrary.load(from: caches, version: version) { return kept }
            let answer: PhoneJSON
            do { answer = try await session.panelAsk(.pluginsLibrary, [.object(["version": .string(version)])]) }
            catch { throw PhonePanelFailure.unreadable }
            let library = try PhonePanelLibrary.read(answer, version: version)
            try? library.save(in: caches)
            return library
        }
        libraries[version] = task
        do { return try await task.value }
        catch {
            libraries[version] = nil
            throw error as? PhonePanelFailure ?? .unreadable
        }
    }

    func toggleFold(_ id: String) {
        if folded.contains(id) { folded.remove(id) } else { folded.insert(id) }
        UserDefaults.standard.set(folded.sorted(), forKey: foldsKey)
        tellStates()
    }

    private func tellStates() {
        for (id, host) in hosts { host.setState(collapsed: folded.contains(id), shown: visible) }
    }

    /// A stopped panel's Try again: the computer lifts the stop and starts its background work again.
    func retry(_ panel: PhonePanel) {
        guard !retrying.contains(panel.id) else { return }
        retrying.insert(panel.id)
        Task {
            defer { retrying.remove(panel.id) }
            _ = try? await session.panelAsk(.pluginsRetry, [.string(panel.id)])
        }
    }
}

/// The Panels tab: every panel under its title and owner word, one under another, at the column's width.
struct PhonePanelsColumn: View {
    let model: PhonePanelsModel
    @State private var room: CGFloat = 600

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                ForEach(model.drawn) { panel in
                    if let host = model.hosts[panel.id] {
                        PhonePanelSection(panel: panel, host: host, folded: model.folded.contains(panel.id),
                                          retrying: model.retrying.contains(panel.id), fillHeight: max(240, room * 0.7),
                                          fold: { model.toggleFold(panel.id) }, retry: { model.retry(panel) },
                                          press: { model.press($0, of: panel) })
                    }
                }
            }
            .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space2).padding(.bottom, PhoneTheme.space5)
            .frame(maxWidth: PhoneColumn.inside + 2 * PhoneTheme.space4).frame(maxWidth: .infinity)
        }
        .background {
            GeometryReader { geometry in Color.clear.onChange(of: geometry.size.height, initial: true) { _, height in room = height } }
        }
        .accessibilityIdentifier("panels-list")
    }
}

/// One panel, as a rail draws it on the computer: its title, whose it is and a fold, then its body.
private struct PhonePanelSection: View {
    let panel: PhonePanel
    let host: PanelWebHost
    let folded: Bool
    let retrying: Bool
    let fillHeight: CGFloat
    let fold: () -> Void
    let retry: () -> Void
    /// INF-3830 piece 3: a title-row button's press.
    let press: (PhonePanelHeaderButton) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // As on the computer's rail, the panel's own buttons sit in its title row beside the fold; one that asks the
            // panel shows only while its body does (`headerButtons(folded:)`).
            HStack(alignment: .center, spacing: 0) {
                Button(action: fold) {
                    HStack(alignment: .center, spacing: PhoneTheme.space2) {
                        Text(panel.title.uppercased()).font(PhoneFont.micro).tracking(PhoneFont.labelTracking).foregroundStyle(PhoneTheme.secondary).lineLimit(1)
                        Text(panel.owner).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("panel-header-\(panel.id)")
                .accessibilityValue(folded ? "folded" : "open")
                ForEach(panel.headerButtons(folded: folded), id: \.id) { button in
                    Button { press(button) } label: {
                        Label(button.label, systemImage: button.symbol).labelStyle(.iconOnly)
                            .font(.system(size: 13, weight: .regular)).foregroundStyle(PhoneTheme.secondary)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("panel-button-\(panel.id)-\(button.id)")
                }
                Button(action: fold) {
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PhoneTheme.muted).rotationEffect(.degrees(folded ? -90 : 0))
                        .frame(minWidth: 28, minHeight: 44, alignment: .trailing).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
            if !folded, let stopped = panel.stopped {
                line(stopped.reason == "exited" ? PhonePanelWords.backgroundExited : PhonePanelWords.backgroundStopped,
                     action: PhonePanelWords.retry, id: "panel-retry-\(panel.id)", busy: retrying, perform: retry)
            }
            switch host.stand {
            case .couldNotOpen(let failure) where !folded:
                line(PhonePanelWords.couldNotOpen(failure), id: "panel-failed-\(panel.id)")
            case .unresponsive where !folded:
                line(PhonePanelWords.unresponsive, action: PhonePanelWords.retry, id: "panel-unresponsive-\(panel.id)", perform: host.retry)
            default:
                // Folded, the panel's view leaves the column and its page keeps running out of sight.
                if !folded {
                    PanelWebView(host: host, theme: scheme == .dark ? "dark" : "light")
                        .id(host.generation)
                        .frame(height: panel.size == "fill" ? fillHeight : host.contentHeight)
                        .opacity(host.stand != .drawn ? 0 : 1)
                        .padding(.bottom, PhoneTheme.space3)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("panel-\(panel.id)")
    }

    private func line(_ words: String, action: String? = nil, id: String, busy: Bool = false,
                      perform: @escaping () -> Void = {}) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            Text(words).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary).fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action, action: perform).buttonStyle(PhoneChoiceStyle(.secondary)).disabled(busy)
                    .accessibilityIdentifier(id)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, PhoneTheme.space3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(action == nil ? id : id + "-line")
    }
}

/// The panels that decide for themselves and have not said they show, mounted where nothing sees them so their code runs
/// and says whether they show; each moves into the column once it does. The workspace keeps this behind every tab.
struct PhonePanelsOutOfSight: View {
    let model: PhonePanelsModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            ForEach(model.undecided) { panel in
                if let host = model.hosts[panel.id], host.stand == .loading || host.stand == .drawn {
                    PanelWebView(host: host, theme: scheme == .dark ? "dark" : "light")
                        .id(host.generation)
                        .frame(width: PhoneColumn.inside, height: max(1, host.contentHeight))
                }
            }
        }
        .frame(width: 1, height: 1, alignment: .topLeading)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
