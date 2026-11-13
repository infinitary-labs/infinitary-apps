import InfinitaryKit
import PhotosUI
import SwiftUI

struct PhoneCards: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @Environment(\.verticalSizeClass) private var verticalSize
    @State private var selected: String?
    @State private var past: PhoneCard?
    @State private var drafts: [String: PhoneJSON] = [:]
    @State private var replies: [String: String] = [:]
    /// INF-3296's phone piece: each card's notes waiting for its reply, kept with its draft while the row pages.
    @State private var notes: [String: [PhoneJSON]] = [:]
    @State private var previousIDs: [String] = []
    @State private var sent = 0
    @State private var pagerMenu = PhoneCardPager()
    /// INF-2565, the captain: "i don't think we should auto flip". A revision gives the card a new offer, so its pane is
    /// built again to draw the new body; the side it shows and the thread it has read live here, per card, and outlast that.
    @State private var sides: [String: PhoneCardSide] = [:]
    /// INF-3110: where the row of cards stands while a finger or a page turn moves it.
    @State private var row = PhoneCardRow()
    /// The row is still moving to the card the count already names; that card is read once it settles.
    @State private var moving = false
    /// The card a swipe started on; a swipe whose card left the stack meanwhile lets go without paging.
    @State private var swipedFrom: String?
    /// The cards built beside the shown one while the row moves; once it stops they are plain edges again.
    @State private var built: Set<String> = []
    /// Counts the row's moves, so a move that another one cut short does not end the newer one.
    @State private var moves = 0
    /// INF-3460: the card the row is built around while a page turn glides on to the card the count already names. The
    /// lift only starts the glide; the row is built again around the new card once the glide ends, or a finger touches it.
    @State private var base: String?
    /// INF-3460: moves the row frame by frame through a release, a chevron's slide or a page key's.
    @State private var driver = PhoneCardRowDriver()
    /// INF-3460: the bodies of the shown card and the cards beside it, kept loaded while the row is still.
    @State private var bodies = PhoneCardBodies()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var card: PhoneCard? { past ?? session.stack.first(where: { $0.id == selected }) ?? session.stack.first }

    var body: some View {
        VStack(spacing: PhoneTheme.space3) {
            if card != nil {
                cardRow
            } else {
                // INF-1060 keeps the empty stage free of placeholder words; INF-1066 adds its native crew.
                PhoneCrewScene(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).padding(.vertical, PhoneTheme.space5)
            }
            // INF-589 item 11: with no card to page, the pager hides. INF-1517: cards put aside wait in Tasks, as on the Mac.
            // INF-2095: the pager shows once its menu holds the stack, so it never draws a count its menu lacks.
            // INF-2568: on a phone on its side the keyboard leaves about two lines of room, which the field typed in needs.
            // INF-3468: on any device, while a text box in the card holds the keyboard, the pager steps aside for the card.
            if !session.stack.isEmpty && !pagerMenu.items.isEmpty
                && !(messageContext.keyboardUp && (phoneOnItsSide(verticalSize) || messageContext.replyFocused)) { pager }
        }
        // INF-3110, the captain's "widen the card only": the card takes the stage's whole width less its gutters on any width,
        // so a card beside it shows the same 8-point edge on an iPad as on an iPhone; the message box keeps the column.
        .padding(.horizontal, PhoneTheme.space4).frame(maxWidth: .infinity)
        // INF-3462: no fill of its own, so the crew scene Home draws under the stage shows past the stage's edges.
        // INF-589 item 12: a soft tap once the computer accepts an answer or a reply; never on a page turn.
        .sensoryFeedback(.phone, trigger: sent)
        .onChange(of: card.map { $0.isPast ? PhoneMessageContext.Card.past($0.id) : .current($0.id) }, initial: true) { _, shown in
            messageContext.card = shown
        }
        .onChange(of: session.stack.map(\.id), initial: true) { _, ids in
            // A card closed on another computer mid-swipe: the swipe lets go and the stack's own rule picks the card.
            if swipedFrom != nil && !ids.contains(swipedFrom!) { swipedFrom = nil; withAnimation(PhoneCardRowMotion.fade) { row.settle() } completion: { [moves] in stopped(moves) } }
            // A card a glide moves from or to closed on another computer: the glide stops where the stack's rule picks.
            if let from = base, !ids.contains(from) || !ids.contains(selected ?? from) {
                driver.stop(); base = nil; moves += 1
                withAnimation(PhoneCardRowMotion.fade) { row.settle() } completion: { [moves] in stopped(moves) }
            }
            if let marked = session.stack.first(where: { !previousIDs.contains($0.id) && $0.value["holdsPlace"].flag }) {
                selected = marked.id; past = nil
            } else if selected == nil || !ids.contains(selected!) {
                // FI3-711 and INF-3155: an unread card first, else the card after the one that left, as on the Mac.
                let unread = Set(session.stack.filter { !session.hasSeen($0) }.map(\.id))
                selected = PhoneCardDeparture.comesUp(after: selected, previous: previousIDs, ids: ids, unread: unread.contains)
            }
            showRestored(ids)
            previousIDs = ids
            if !moving && swipedFrom == nil { bodies.keep(only: ids.isEmpty ? [] : rowCards.map(\.card)); bodies.setAside(except: card) }
            sides = sides.filter { ids.contains($0.key) || $0.key == past?.id }
            if let past, ids.contains(past.id) { self.past = nil }
        }
        .onChange(of: messageContext.restoring) { _, _ in showRestored(session.stack.map(\.id)) }
        // INF-3460: a card shown from the count's menu, or by the stack's own rule, leaves the row still: the card that
        // showed before sits beside it again, its body set aside with the rest.
        .onChange(of: selected) { _, _ in
            if !moving && swipedFrom == nil && !session.stack.isEmpty { bodies.keep(only: rowCards.map(\.card)); bodies.setAside(except: card) }
        }
        // INF-3460: a revision draws a new body, so the row lets the old one go once it is still.
        .onChange(of: session.stack.map(PhoneCardBodies.key)) { _, _ in
            if !moving && swipedFrom == nil && !session.stack.isEmpty { bodies.keep(only: rowCards.map(\.card)) }
        }
        // INF-2095: the pager's menu takes its cards and label here, and only when either changes.
        .onChange(of: session.stack.map { PhoneCardPager.Item(id: $0.id, title: $0.title) }, initial: true) { _, items in
            pagerMenu.pick = { id in selected = id; past = nil }
            pagerMenu.show(items, label: pagerLabel)
        }
        .onChange(of: pagerLabel, initial: true) { _, label in pagerMenu.show(pagerMenu.items, label: label) }
        .onChange(of: session.showCardID, initial: true) { _, id in
            guard let id else { return }
            if session.stack.contains(where: { $0.id == id }) { selected = id; past = nil }
            else { past = session.pastCards.first { $0.id == id } }
            session.showCardID = nil
        }
    }
    /// INF-3110, the captain's row: the shown card with the cards beside it in the stack, whose edges show at its sides.
    /// They are plain edges while the row is still, their bodies loading behind them (INF-3460), and real cards while it
    /// moves. A past card stands alone.
    private var rowCards: [PhoneCardRowSlot] {
        if let past { return [PhoneCardRowSlot(card: past, slot: 0)] }
        let at = rowIndex
        return (max(0, at - 1)...min(session.stack.count - 1, at + 1)).map {
            let card = session.stack[$0]
            return PhoneCardRowSlot(card: card, slot: $0 - at, built: $0 == at || built.contains(card.id))
        }
    }

    /// The cards beside the shown one are built as the row starts to move, so the one it brings in is the real card.
    private func buildBeside() {
        built = Set([index - 1, index, index + 1].filter(session.stack.indices.contains).map { session.stack[$0].id })
    }

    private var cardRow: some View {
        ZStack(alignment: .top) {
            ForEach(rowCards) { place in
                let card = place.card
                let shown = place.slot == 0
                if !place.built {
                    PhoneCardRowEdge(row: row)
                        .background(alignment: .top) { loading(card) }
                        .modifier(PhoneCardRowPlace(row: row, slot: place.slot))
                } else {
                PhoneCardPane(card: card, session: session, bodies: card.isPast ? nil : bodies,
                    fill: card.isPast ? card.value["answers"] : drafts[card.id] ?? .array([]),
                    reply: Binding(get: { replies[card.id] ?? "" }, set: { replies[card.id] = $0 }),
                    notes: Binding(get: { notes[card.id] ?? [] }, set: { notes[card.id] = $0.isEmpty ? nil : $0 }),
                    onReading: { drafts[card.id] = $0["answers"] },
                    onSeen: { session.markSeen(card) },
                    onHide: { past = nil },
                    onSent: { sent += 1 },
                    shown: shown, visible: shown && !moving && messageContext.cardsVisible,
                    replyLeaves: !card.value["holdsPlace"].flag && session.stack.count > 1,
                    row: row,
                    onTask: { messageContext.openTask = $0 }, onDraft: { messageContext.draft = $0 },
                    side: Binding(get: { sides[card.id] ?? PhoneCardSide() }, set: { sides[card.id] = $0 }))
                    .modifier(PhoneCardRowPlace(row: row, slot: place.slot))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .overlay { PhoneCardRowHint(row: row) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { row.width = $0 }
        // The neighbours' edges show in the room between the card and the screen's edge, never past it.
        .clipShape(PhoneCardRowClip(room: PhoneTheme.space4))
        .overlay(alignment: .topLeading) {
            if let probe = PhoneCardRowProbe.shared {
                PhoneCardRowProbeReading(probe: probe, beside: bodies.drawn(rowCards.filter { $0.slot != 0 }.map(\.card)))
            }
        }
        // A finger that touches the row while it glides takes it where the count already points.
        .gesture(PhoneCardSwipe(allowed: { swipeAllowed }, began: {
            rebase(); began(); swipedFrom = card?.id; buildBeside(); row.settle(); row.grabbed = card?.id
            PhoneCardRowProbe.shared?.began(drawn: drawnBodies)
        }, moved: { swiped($0) }, ended: { released($0, $1) }))
    }

    /// INF-3460: the body of a card beside the shown one, loading behind its edge with its fact strip.
    @ViewBuilder private func loading(_ card: PhoneCard) -> some View {
        if !card.isPast {
            let page = bodies.body(card) { PhoneCardPane.bodyHost(card, session, drafts[card.id] ?? .array([])) }
            PhoneCardRowLoading(page: page, strip: page.facts.flatMap { bodies.strip(card, facts: $0, session: session) }, row: row)
        }
    }

    /// The row's card while a glide carries it on, else the shown card's.
    private var rowIndex: Int {
        base.flatMap { id in session.stack.firstIndex { $0.id == id } } ?? index
    }

    /// A new move takes the row from here.
    private func began() { driver.stop(); moves += 1 }

    /// The row's cards whose bodies have drawn, for the row's probe.
    private var drawnBodies: Set<String> {
        let cards = rowCards.map(\.card)
        return Set(zip(cards, bodies.drawn(cards)).filter(\.1).map(\.0.id))
    }

    /// INF-3460: the row is built again around the card the count names, every card staying where it stands on the screen.
    private func rebase() {
        guard let from = base else { return }
        let steps = index - (session.stack.firstIndex { $0.id == from } ?? index)
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { base = nil; row.offset += CGFloat(steps) * (row.width + PhoneCardRowMotion.gap) }
    }

    /// INF-3460: the row glides to `aim` on the release spring from where it stands, at the finger's speed, frame by frame.
    private func glide(to aim: CGFloat, speed: CGFloat?) {
        let move = moves
        let glide = PhoneCardRowGlide(from: row.offset, to: aim, speed: speed ?? 0, lean: row.lean)
        driver.run { time in
            guard move == moves else { return false }
            let done = glide.done(at: time)
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) { row.offset = done ? aim : glide.place(at: time); row.lean = done ? 0 : glide.leaning(at: time) }
            if done { stopped(move) }
            return !done
        }
    }

    /// Typing a reply keeps the card where it is until the keyboard closes (the captain's pick); a past card stays put.
    private var swipeAllowed: Bool { past == nil && !session.stack.isEmpty && !messageContext.keyboardUp }

    /// How far the row has moved with the finger: the first points decide the swipe and move nothing, and with no card
    /// that way the row gives a third of the finger's travel.
    private func travel(_ dx: CGFloat) -> CGFloat {
        let moved = dx > 0 ? max(0, dx - PhoneCardRowMotion.decide) : min(0, dx + PhoneCardRowMotion.decide)
        return (moved < 0 ? canPageNext : canPagePrevious) ? moved : moved * PhoneCardRowMotion.endGives
    }

    private func swiped(_ dx: CGFloat) {
        guard swipedFrom == card?.id, row.width > 0 else { return }
        let moved = travel(dx)
        let progress = min(1, abs(moved) / (row.width * PhoneCardRowMotion.slideOn))
        if reduceMotion {
            row.dim = PhoneCardRowMotion.dim * progress
            row.heading = moved < 0 ? 1 : -1
            row.hint = (moved < 0 ? canPageNext : canPagePrevious) ? progress : progress * PhoneCardRowMotion.hintAtEnd
        } else {
            row.offset = moved
            row.lean = PhoneCardRowMotion.lean * Double(max(-PhoneCardRowMotion.leanReach,
                min(PhoneCardRowMotion.leanReach, moved / (row.width * PhoneCardRowMotion.slideOn))))
        }
    }

    /// A drag past the slide-on point, or a flick, slides to the next card and changes the count at once; anything less
    /// glides back. A swipe whose card left the stack meanwhile only glides back.
    private func released(_ dx: CGFloat, _ speed: CGFloat?) {
        defer { swipedFrom = nil }
        let moved = travel(dx)
        let toward = moved < 0 ? 1 : -1
        let room = toward > 0 ? canPageNext : canPagePrevious
        let far = abs(moved) >= row.width * PhoneCardRowMotion.slideOn
        let flick = speed.map { abs($0) >= PhoneCardRowMotion.flick && ($0 < 0) == (moved < 0) && moved != 0 } ?? false
        if swipedFrom == card?.id, speed != nil, room, row.width > 0, far || flick {
            turn(toward, speed: speed)
        } else if reduceMotion {
            withAnimation(PhoneCardRowMotion.fade) { row.dim = 0; row.hint = 0 } completion: { [moves] in stopped(moves) }
        } else {
            glide(to: 0, speed: speed)
        }
    }

    /// The row came to rest: it is built again around the shown card, which is read, and the cards beside it are plain
    /// edges again, their bodies kept loaded behind them, unless a finger moves it.
    private func stopped(_ move: Int) {
        guard move == moves else { return }
        driver.stop()
        rebase()
        moving = false
        row.grabbed = nil
        if swipedFrom == nil {
            built = []
            bodies.keep(only: rowCards.map(\.card))
            bodies.setAside(except: card)
            if let card { PhoneCardRowProbe.shared?.rested(on: card.id) }
        }
    }
    /// Changes the card the count names now, and moves the row there from where it stands: the rest of a swipe's slide at
    /// the finger's speed, a chevron's whole slide, or under Reduce Motion a fade into the new row.
    private func turn(_ delta: Int, speed: CGFloat? = nil) {
        let next = index + delta
        guard past == nil, session.stack.indices.contains(next) else { return }
        var still = Transaction()
        still.disablesAnimations = true
        // A turn while the row still glides takes it on from where it stands.
        rebase()
        began()
        if swipedFrom == nil { PhoneCardRowProbe.shared?.began(drawn: drawnBodies) }
        moving = true
        buildBeside()
        if reduceMotion {
            withTransaction(still) { selected = session.stack[next].id; row.settle(); row.fade = 0 }
            afterDrawn { withAnimation(PhoneCardRowMotion.fade) { row.fade = 1 } completion: { [moves] in stopped(moves) } }
            return
        }
        // INF-3460: the count moves on now and the row keeps every card where it is, so the glide starts in the very next
        // frame; the row is built again around the new card once it rests.
        withTransaction(still) { base = card?.id; selected = session.stack[next].id }
        glide(to: -CGFloat(delta) * (row.width + PhoneCardRowMotion.gap), speed: speed)
    }

    /// Under Reduce Motion, runs the fade once the new row is drawn, so it never fades a row still being built. A move that
    /// started since then owns the row.
    private func afterDrawn(_ glide: @escaping @MainActor () -> Void) {
        let move = moves
        DispatchQueue.main.async { if move == moves { glide() } }
    }

    private var pager: some View {
        HStack(spacing: PhoneTheme.space2) {
            Button { page(-1) } label: { Label(PhoneMessages.uiCardStackPrevious(), systemImage: "chevron.left").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44) }
                .disabled(!canPagePrevious).accessibilityIdentifier("previous-card")
            PhoneCardPagerMenu(pager: pagerMenu)
            Button { page(1) } label: {
                Label(PhoneMessages.uiCardStackNext(), systemImage: "chevron.right").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    .overlay(alignment: .topTrailing) {
                        if session.stack.dropFirst(index + 1).contains(where: { !session.hasSeen($0) }) {
                            Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6).accessibilityHidden(true)
                        }
                    }
            }
                .disabled(!canPageNext).accessibilityIdentifier("next-card")
            // INF-1524, the captain's pick: on Home a new card is counted here rather than in a pill over the stage.
            if !fresh.isEmpty {
                Button { selected = fresh[0].id; past = nil } label: {
                    Text(PhoneMessages.uiCardStackNew(count: fresh.count)).font(PhoneFont.mono).foregroundStyle(PhoneTheme.accent).frame(minHeight: 44)
                }.accessibilityIdentifier("card-new")
            }
        }
        .background {
            PhonePagerKeys(previous: canPagePrevious ? { page(-1) } : nil, next: canPageNext ? { page(1) } : nil)
                .frame(width: 0, height: 0)
        }
    }
    private var pagerLabel: String { past != nil ? PhoneMessages.phoneCardsPagerPast() : PhoneMessages.phoneCardsPagerPosition(position: String(index + 1), total: String(session.stack.count)) }
    /// The cards on the stack not yet read, besides the one shown.
    private var fresh: [PhoneCard] {
        session.stack.filter { $0.id != card?.id && !session.hasSeen($0) }
    }
    private var index: Int { session.stack.firstIndex { $0.id == (selected ?? session.stack.first?.id) } ?? 0 }
    private var canPagePrevious: Bool { past == nil && index > 0 }
    private var canPageNext: Bool { past == nil && index < session.stack.count - 1 }
    /// A card a Tasks row brought back shows once its return reaches the stack, whichever arrives first.
    private func showRestored(_ ids: [String]) {
        guard let id = messageContext.restoring, ids.contains(id) else { return }
        selected = id; past = nil; messageContext.restoring = nil
    }
    /// The chevrons and Shift-Command-[ and ] slide the row one card, as a swipe does (the captain's pick).
    private func page(_ delta: Int) { turn(delta) }
}

/// INF-2095: what the pager's menu shows, which only a change to the stack's cards or to the pager's own label alters.
/// An inline menu re-ran its content on every redraw of the cards view, as on every workspace redraw, such as a reply
/// notice clearing on its own; with the menu open, UIKit then sometimes rebuilt it under a quick tap, which lost the pick
/// and left the menu open. An equatable menu view did not help: SwiftUI still ran its body on the cards view's redraws
/// with equal inputs. The menu view holds only this object, so the cards view's redraws pass it nothing new, and it
/// redraws when what it reads here changes. A change to the stack itself still reaches the open menu.
@MainActor @Observable final class PhoneCardPager {
    struct Item: Identifiable, Equatable { let id: String; let title: String }
    private(set) var items: [Item] = []
    private(set) var label = ""
    /// The cards view's pick, which reads nothing the menu draws.
    @ObservationIgnored var pick: (String) -> Void = { _ in }

    func show(_ items: [Item], label: String) {
        if self.items != items { self.items = items }
        if self.label != label { self.label = label }
    }
}

private struct PhoneCardPagerMenu: View {
    let pager: PhoneCardPager

    var body: some View {
        Menu {
            let _ = PhoneMenuTapProbe.shared?.menuBuilt()
            ForEach(pager.items) { item in
                Button(item.title) { PhoneMenuTapProbe.shared?.picked(); pager.pick(item.id) }
            }
        } label: {
            Text(pager.label)
                .font(.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption))
                .frame(minWidth: 44, minHeight: 44)
        }.accessibilityIdentifier("card-pager")
    }
}

/// INF-1753: Shift-Command-[ and Shift-Command-] page the stage, as `cards.previous` and `cards.next` do on the Mac,
/// and like them never repeat while held. A page turn builds the next card's web view, which on a busy iPad held the
/// main thread past UIKit's key repeat delay, so a SwiftUI shortcut turned a second page before the key-up arrived.
/// The chords are UIKit key commands that never repeat (iOS 26 and later), kept on the window's root view controller
/// beside SwiftUI's own shortcuts while the pager is in the window.
struct PhonePagerKeys: UIViewRepresentable {
    let previous: (() -> Void)?
    let next: (() -> Void)?

    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ anchor: Anchor, context: Context) {
        anchor.previousPage = previous
        anchor.nextPage = next
    }

    final class Anchor: UIView {
        fileprivate static weak var shown: Anchor?
        var previousPage: (() -> Void)?
        var nextPage: (() -> Void)?
        private weak var owner: UIViewController?
        private let commands = [("[", PhoneMessages.uiCardStackPrevious(), -1), ("]", PhoneMessages.uiCardStackNext(), 1)].map { input, title, delta in
            let command = UIKeyCommand(title: title, action: #selector(UIApplication.infinitaryPageCard(_:)), input: input,
                                       modifierFlags: [.command, .shift], propertyList: delta)
            if #available(iOS 26, *) { command.repeatBehavior = .nonRepeatable }
            return command
        }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let owner { commands.forEach(owner.removeKeyCommand) }
            owner = window?.rootViewController
            if let owner { commands.forEach(owner.addKeyCommand) }
            if window != nil { Self.shown = self } else if Self.shown === self { Self.shown = nil }
        }
        fileprivate func press(_ command: UIKeyCommand) {
            // A sheet keeps the pager's chords from the stage behind it.
            guard owner?.presentedViewController == nil, let delta = command.propertyList as? Int else { return }
            (delta < 0 ? previousPage : nextPage)?()
        }
    }
}

extension UIApplication {
    /// The pager's chords sit on the root view controller, so their action travels up the responder chain from wherever
    /// focus is; the application ends every such chain.
    @objc fileprivate func infinitaryPageCard(_ command: UIKeyCommand) { PhonePagerKeys.Anchor.shown?.press(command) }
}

/// What a card's pane keeps across a revision that builds it again (INF-2565): the side it shows, how much of its thread
/// the captain has read, and the offer the face last showed, so the back marks a revision that came while it showed.
struct PhoneCardSide: Equatable {
    var turned = false
    var readCount: Int?
    var faceOffer: String?
}

private struct PhoneCardPane: View {
    let card: PhoneCard
    let session: ReadOnlySession
    /// INF-3460: the row's kept bodies; none for a past card, which stands alone.
    let bodies: PhoneCardBodies?
    @Binding var reply: String
    /// INF-3296's phone piece: the notes waiting for this card's reply.
    @Binding var notes: [PhoneJSON]
    let onReading: (PhoneJSON) -> Void
    let onSeen: () -> Void
    let onHide: () -> Void
    let onSent: () -> Void
    /// INF-3110: the card the row shows; a card beside it is drawn ahead and takes no touches, keys or focus.
    let shown: Bool
    /// The card is shown, settled and on screen: a card drawn behind another tab or sliding past is not yet read.
    let visible: Bool
    let replyLeaves: Bool
    let row: PhoneCardRow
    let onTask: (String) -> Void
    let onDraft: (String) -> Void
    @State private var surfaceHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    /// The body runs on below the choices, so a hairline separates them, as on the Mac.
    @State private var runsOn = false
    /// The height the stage offers the card, and its head's and choices' own heights.
    @State private var paneHeight: CGFloat = 0
    @State private var headHeight: CGFloat = 0
    @State private var footHeight: CGFloat = 0
    @State private var host: CardWebHost
    /// INF-1524: a settle card's fact strip, drawn read-only beside its choices once the body has split it off.
    @State private var factsHost: CardWebHost?
    @State private var problem: String?
    /// INF-1919, the captain's pick: the thread lives on the card's back, and the card turns over to show it.
    /// INF-2565: the side, the read count and the face's offer are the stage's, so a revision never turns the card.
    @Binding var side: PhoneCardSide
    private var turned: Bool {
        get { side.turned }
        nonmutating set { side.turned = newValue }
    }
    /// Where the turn stands: the back is drawn only while it shows or turns, and the face's own field and choices give
    /// way while the back shows, so one control of each kind is on the card for a tap or for accessibility to find.
    @State private var flipped = false
    @State private var backMounted = false
    /// The side whose field takes the focus once a turn draws it.
    @State private var pendingFocus: CardSide?
    /// How many of the thread's messages the captain has seen on the back; nil until the thread is first read.
    private var readCount: Int? {
        get { side.readCount }
        nonmutating set { side.readCount = newValue }
    }
    @State private var backHeadHeight: CGFloat = 0
    @State private var threadHeight: CGFloat = 0
    @State private var backFootHeight: CGFloat = 0
    @State private var backHeight: CGFloat = 0
    /// The "You asked" line is open; held here because a taller head moves into or out of the scroller.
    @State private var askedOpen = false
    @State private var retry = 0
    /// INF-1524: the choice pressed and still on its way, which shows its pending mark.
    @State private var pending: String?
    @State private var photos: [PhonePhoto] = []
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var libraryOpen = false
    @State private var cameraOpen = false
    /// INF-3296's phone piece: Point at is on, so a tap on a part of the body picks it.
    @State private var pointAt = false
    /// The part or words being noted, which the note editor under it shows (INF-3746, the captain's direction B).
    @State private var pick: PhoneNotePick?
    /// The note editor's comment holds the focus, which counts as the card's own text box (INF-3468).
    @FocusState private var noteFocus: Bool
    /// The note editor's height, and where it sits in the pane while it takes the pinned foot of a card on an iPhone on
    /// its side.
    @State private var noteEditorHeight: CGFloat = 0
    @State private var noteFootFrame: CGRect?
    /// Counts the moments the card's scroller brings the open note editor back into view: it opening or growing, its
    /// comment taking the focus, and the keyboard shortening the scroller.
    @State private var noteGrew = 0
    /// A queued note whose Edit could not show its part, and why.
    @State private var noteFailures: [String: String] = [:]
    /// Where a note revealed from the thread sits in the body, which the card's scroller brings into view.
    @State private var revealedNote: (top: CGFloat, height: CGFloat, seq: Int)?
    @Environment(\.scenePhase) private var phase
    @Environment(PhoneMessageContext.self) private var messageContext
    @Environment(PhoneSecrets.self) private var secrets: PhoneSecrets?
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSize
    /// The field has the focus on this side; a turn carries it to the field on the other.
    @FocusState private var replyFocus: CardSide?
    /// INF-2568: where the face's field sits in the pane, read in the pane's own space before the lift moves it.
    @State private var faceReplyFrame: CGRect?
    /// Counts the moments the face's scroller follows its focused field's caret: the field taking the focus or growing,
    /// and the keyboard shortening the scroller.
    @State private var replyGrew = 0
    /// INF-3468: where the face's field sits in the card's scrolled content, its height, and the room the scroller shows,
    /// which say where the field comes to rest while it types in a card whose whole frame scrolls.
    @State private var replyInContent: CGRect?
    @State private var replyHeight: CGFloat = 0
    @State private var scrollRoom: CGFloat = 0
    @State private var scrollFrame: CGFloat = 0
    /// A scroller on the card is moving: dragged, settling from a drag, or following the caret.
    @State private var scrollMoving = false

    enum CardSide { case face, back }

    init(card: PhoneCard, session: ReadOnlySession, bodies: PhoneCardBodies?, fill: PhoneJSON, reply: Binding<String>, notes: Binding<[PhoneJSON]>,
         onReading: @escaping (PhoneJSON) -> Void, onSeen: @escaping () -> Void, onHide: @escaping () -> Void, onSent: @escaping () -> Void, shown: Bool, visible: Bool, replyLeaves: Bool,
         row: PhoneCardRow, onTask: @escaping (String) -> Void, onDraft: @escaping (String) -> Void,
         side: Binding<PhoneCardSide>) {
        self.card = card; self.session = session; _reply = reply; _notes = notes
        self.onReading = onReading; self.onSeen = onSeen; self.onHide = onHide; self.onSent = onSent
        self.shown = shown; self.visible = visible; self.replyLeaves = replyLeaves
        self.row = row; self.onTask = onTask; self.onDraft = onDraft
        self.bodies = bodies
        // INF-3460: a card the row kept loaded beside the shown one arrives with its body already drawn.
        _host = State(initialValue: bodies?.body(card) { Self.bodyHost(card, session, fill) } ?? Self.bodyHost(card, session, fill))
        _side = side
        // A pane built again while its back shows starts on the back, with no turn.
        let showsBack = side.wrappedValue.turned && !Self.messages(card, session).isEmpty
        _flipped = State(initialValue: showsBack); _backMounted = State(initialValue: showsBack)
    }
    static func bodyHost(_ card: PhoneCard, _ session: ReadOnlySession, _ fill: PhoneJSON,
                                 heightLag: TimeInterval = 0) -> CardWebHost {
        // The body links the key of every task the phone holds, the card's own task's included, as the Mac's does,
        // so a card never links some keys and leaves others as text.
        let keys = (session.board?.tasks ?? []).map(\.key)
        return CardWebHost(card: card, session: session, fill: fill, keys: keys, heightLag: heightLag)
    }
    private static func messages(_ card: PhoneCard, _ session: ReadOnlySession) -> [PhoneJSON] {
        if card.isPast { return card.value["messages"].list }
        let thread = session.threads[card.id]?["messages"].list ?? []
        // INF-3071: a card its author ended carries the computer's app line, as on the Mac, among the
        // messages by when it ended, so a line written after it, naming the work a reply started, reads under it.
        guard let line = card.value["ended"]["line"].text else { return thread }
        let at = card.value["ended"]["at"]
        let split = thread.firstIndex { ($0["at"].numeric ?? 0) > (at.numeric ?? .infinity) } ?? thread.count
        return Array(thread[..<split]) + [.object(["who": .string("host"), "text": .string(line), "at": at])]
            + Array(thread[split...])
    }
    private var messages: [PhoneJSON] { Self.messages(card, session) }
    /// What the face draws; a revision that changes it gives the card a new offer.
    private var offer: String { card.offerID ?? card.body }
    /// INF-2565, the captain: "at most we should show an indicator near the "< card" button to show there's an update".
    private var updatedBehind: Bool { showsBack && side.faceOffer != nil && side.faceOffer != offer }
    private var reachable: Bool { session.contact == "in-reach" }
    private var replyWords: String { reply.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSendReply: Bool { !host.changing && session.canChange && host.drawn && replyFits }
    /// The words, photos or notes alone, which the send checks again once its change has begun and the card counts as changing.
    private var replyFits: Bool {
        reply.utf16.count <= PhoneLimits.reply && (!replyWords.isEmpty || !photos.isEmpty || !notes.isEmpty)
    }
    private var takesReply: Bool { card.takesReplies && !card.isPast }
    /// INF-3296's phone piece: the card's reply takes notes on its body, by the home's own say.
    private var takesNotes: Bool { takesReply && session.cardNotes && host.failure == nil }
    /// The task the card is about, which leads its head as its door to the task's record.
    /// A first mate card is its own (INF-2714) and leads with no task's key.
    private var task: PhoneTask? {
        guard !card.isFirstmateOwn, let id = card.value["taskId"].text ?? card.reviewTaskId else { return nil }
        return session.board?.tasks.first { $0.id == id }
    }
    /// Its author is at work on it: the first mate's turn, or its crewmate's task running.
    private var working: Bool {
        card.isPast ? false : card.author == "firstmate" ? session.firstmateBusy
            : ["running", "starting"].contains(task?.activity ?? "")
    }
    private var asking: Bool { !card.isPast && (host.reading["of"].numeric ?? 0) > 0 }
    /// A closing choice waits until every required question has an answer (the captain's Q2 A on the Mac).
    private var unanswered: Bool { asking && (host.reading["answered"].numeric ?? 0) < (host.reading["of"].numeric ?? 0) }

    /// INF-2553, the captain's pick: an iPhone on its side has no room for the notice pill, so the words about a change
    /// taken back on this card stay on its own line until its next change, as a refused change's did before.
    private var line: String? { problem ?? (phoneOnItsSide(verticalSize) ? session.takenBack[card.id] : nil) }

    private var hasFoot: Bool {
        !card.actions.isEmpty || line != nil || takesReply || factsHost != nil || !messages.isEmpty
    }
    /// The back shows: a card has a back only once its thread has a message.
    private var showsBack: Bool { turned && !messages.isEmpty }
    /// The author's messages that came while the card showed its face.
    private var unread: Int {
        guard !showsBack, let readCount else { return 0 }
        return messages.dropFirst(readCount).filter { $0["who"].text != "captain" }.count
    }
    /// A short stage, such as an iPhone on its side with a long draft, would leave the body a sliver between its pinned
    /// head and choices; unless the body keeps at least the room they take, the whole card scrolls as it did before.
    @State private var pinsFrame = true
    /// The stage height at which the frame last changed its shape.
    @State private var shapedAt: CGFloat?

    /// Moving the head and choices changes what they measure, and while a rotation animates both places are drawn at once,
    /// so the frame changes its shape at most once for each stage height and never animates the move; otherwise the two
    /// could trade places on every frame and the app would never come to rest.
    /// INF-1524: the reply field sits in the pinned foot, and moving the foot in or out of the scroller makes a new field,
    /// so the keyboard its focus raises, which shortens the stage, never reshapes the frame; the shape settles once it closes.
    private func shapeFrame() {
        guard paneHeight > 0, replyFocus == nil, pick == nil else { return }
        let pins = paneHeight - headHeight - footHeight >= headHeight + footHeight
        guard pins != pinsFrame, shapedAt != paneHeight else { return }
        shapedAt = paneHeight
        var moved = Transaction()
        moved.disablesAnimations = true
        withTransaction(moved) { pinsFrame = pins }
    }

    private var measuredHead: some View {
        head.padding([.horizontal, .top], PhoneTheme.space4).padding(.bottom, PhoneTheme.space3)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headHeight = $0 }
    }

    private var measuredFoot: some View {
        foot.fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footHeight = $0 }
    }

    var body: some View {
        ZStack(alignment: .top) {
            front.modifier(PhoneCardTurn(angle: turnAngle, back: false))
            if backMounted && !messages.isEmpty { back.modifier(PhoneCardTurn(angle: turnAngle, back: true)) }
        }
        // INF-3106 direction B: a pull down that starts anywhere on the card, its head included, puts the keyboard away.
        .simultaneousGesture(DragGesture(minimumDistance: 16).onEnded { value in
            if messageContext.keyboardUp && value.translation.height > 30
                && value.translation.height > abs(value.translation.width) { dismissPhoneKeyboard() }
        })
        // INF-3110: every card in the row leans about its own foot; INF-3460: the one the finger took leans furthest.
        .modifier(PhoneCardRowLean(row: row, card: card.id))
        .coordinateSpace(.named(Self.paneSpace))
        .offset(y: -lift)
        // INF-2568: the pane is the room the stage offers, never the card's own height, so a card taller than the room the
        // keyboard leaves stays inside it rather than pushing the pager and the message box down behind the keyboard.
        .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
        .clipShape(PhonePaneClip(clips: (showsBack ? backHeight : surfaceHeight) > paneHeight + 0.5))
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { paneHeight = $0 }
        .onChange(of: [paneHeight, headHeight, footHeight]) { shapeFrame() }
        .onChange(of: replyFocus == nil) { _, unfocused in if unfocused { shapeFrame() } }
        .onChange(of: pick == nil) { _, closed in if closed { shapeFrame() } }
        // Only the shown card speaks for the reply's focus; one that slides aside lets its field go.
        // INF-3427: a text box in the body that holds the keyboard counts as the card's own field here too.
        // INF-3746: the note editor's comment counts too, so the pager and the message box step aside for it.
        .onChange(of: shown && (replyFocus != nil || noteFocus || host.typing), initial: shown) { was, focused in
            if shown || was { messageContext.replyFocused = focused }
        }
        .onChange(of: shown) { _, shown in connectHost(); if !shown { replyFocus = nil; pointAt = false; pick = nil } }
        .onDisappear { if shown && (replyFocus != nil || noteFocus || host.typing) { messageContext.replyFocused = false } }
        // INF-3460: a body the row kept loaded beside the shown card has drawn already, so a card opened from the count's
        // menu shows drawn and its first drawing never comes to mark it read.
        .onAppear { connectHost(); readThread(); if let facts = host.facts { showFacts(facts) }; markSeen() }
        .onChange(of: host.facts) { _, facts in if let facts { showFacts(facts) } }
        .onChange(of: session.contact) { _, contact in if contact == "in-reach" { readThread(); markSeen() } }
        .onChange(of: phase) { _, phase in if phase == .active { markSeen() } }
        .onChange(of: visible) { _, visible in connectHost(); if visible { markSeen() } }
        // A same-offer answer keeps the drawn body and local drafts, but reports its new released identity.
        .onChange(of: card.currentUpdateID) { _, _ in connectHost(); markSeen() }
        // INF-1919: a reply that lands while the face shows lights the latest line and never turns the card.
        .onChange(of: card.isPast || session.threads[card.id] != nil, initial: true) { _, read in
            if read && readCount == nil { readCount = messages.count }
        }
        .onChange(of: messages.count) { _, count in if showsBack { readCount = count } }
        .onChange(of: showsBack) { _, back in
            if back { readCount = messages.count; side.faceOffer = offer }
            turn(to: back)
        }
        // INF-3107: a picture or diagram opens full screen, where it can be read at its own size; a recording keeps its sheet.
        .sheet(isPresented: Binding(get: { host.presentation?["type"].text == "demo" }, set: { if !$0 { host.presentation = nil } })) {
            if let presentation = host.presentation { CardMediaView(presentation: presentation, session: session) }
        }
        .fullScreenCover(isPresented: Binding(get: { host.presentation.map { $0["type"].text != "demo" } ?? false },
                                              set: { if !$0 { host.presentation = nil } })) {
            if let presentation = host.presentation { CardMediaView(presentation: presentation, session: session) }
        }
        .photosPicker(isPresented: $libraryOpen, selection: $photoSelection,
                      maxSelectionCount: max(1, PhoneLimits.images - photos.count), matching: .images)
        .task(id: photoSelection) { await loadPhotos() }
        .fullScreenCover(isPresented: $cameraOpen) {
            PhoneCamera { image in
                do { photos.append(try PhonePhoto(bytes: image.jpegData(compressionQuality: 0.95) ?? Data())) }
                catch { problem = error.localizedDescription }
            }.ignoresSafeArea()
        }
    }

    private var turnAngle: Double { flipped ? 180 : 0 }

    private static let paneSpace = "card-pane"
    /// INF-3468: the face's field with the margin under it, and the foot of the card's scrolled content.
    private static let replyRest = "card-reply-rest"
    private static let contentEnd = "card-content-end"
    private static let noteReveal = "card-note-reveal"
    /// INF-3746: the part an open note points at, and the note editor with the margin under it.
    private static let notePart = "card-note-part"
    private static let noteRest = "card-note-rest"
    private static let contentSpace = "card-content"
    /// INF-3468, the captain's pick: a typing reply comes to rest with the card's choices showing under it where the
    /// field, the choices and the card's foot fit in the room; otherwise with the margin under it.
    private var typingOverflows: Bool {
        ((replyFocus == .face && !pinsFrame) || messageContext.composerAside) && contentHeight > scrollFrame + 0.5
            && scrollFrame > 0
    }

    private var restsWithChoices: Bool {
        guard let field = replyInContent, scrollRoom > 0 else { return false }
        let end = contentHeight - (typingOverflows ? PhoneTyping.margin : 0)
        return end - field.minY <= scrollRoom && end - field.maxY >= PhoneTyping.margin
    }

    /// INF-2568: how far the face rises in its pane while its pinned reply types and the card stands taller than the room
    /// the keyboard leaves. It rises as far as shows the card's foot, the choices under the field, but never so far that
    /// the field's top leaves the pane, and always far enough that the field's foot, where the caret types, stays in it.
    /// The head the rise hides comes back as the keyboard closes.
    /// INF-3746: the note editor in the foot of a card on an iPhone on its side rises the same way while its comment types.
    private var lift: CGFloat {
        let typing = replyFocus == .face ? faceReplyFrame : noteFocus && pick != nil && noteInFoot ? noteFootFrame : nil
        guard pinsFrame, paneHeight > 0, let field = typing else { return 0 }
        let overflow = surfaceHeight - paneHeight
        guard overflow > 0 else { return 0 }
        // INF-3468: where the choices do not show, the field keeps the margin above the card's foot.
        return min(max(min(overflow, field.minY), field.maxY + PhoneTyping.margin - paneHeight, 0), overflow)
    }

    private func followCaret() { if replyFocus == .face { replyGrew += 1 } }

    /// INF-3746, the captain: "pay attention to keeping the focused text input in viewport not scrolled away".
    private func followNote() { if pick != nil && shown { noteGrew += 1 } }

    /// The captain's direction B falls back to the card's foot on an iPhone on its side, where the keyboard leaves no
    /// room for a panel under the part.
    private var noteInFoot: Bool { phoneOnItsSide(verticalSize) }

    /// The one note editor, under the part or in the foot, with the place the card's scroller keeps in view.
    private var noteEditor: some View {
        PhoneNoteEditor(pick: $pick, focused: $noteFocus, compact: noteInFoot, onQueue: queueNote)
            .background(alignment: .top) {
                Color.clear.frame(height: noteEditorHeight + PhoneTyping.margin).allowsHitTesting(false).id(Self.noteRest)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in noteEditorHeight = height; followNote() }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.paneSpace)) } action: { frame in
                if pinsFrame { noteFootFrame = frame }
            }
    }

    /// A card's scroller closes the keyboard as a person starts to scroll it, never as the scroller follows the caret.
    private func scrolled(_ phase: ScrollPhase) {
        scrollMoving = phase != .idle
        // INF-2568, the captain: "scrolling a card should dismiss the keyboard if keyboard is up".
        if phase == .interacting && messageContext.keyboardUp { dismissPhoneKeyboard() }
    }

    /// INF-2737: a scroller only starts a drag when its content overflows or it bounces, so while the keyboard is up a
    /// card or thread that fits whole above it bounces too, and a flick on it starts the scroll that closes the keyboard.
    /// It bounces on until that scroll settles, after the keyboard has gone; with the keyboard down, one that fits holds still.
    private var bounce: ScrollBounceBehavior { messageContext.keyboardUp || scrollMoving ? .always : .basedOnSize }

    /// The latest line and Card turn the card over, carrying a typing captain's focus to the other side's field; a send
    /// turns it too, but drops the keyboard, as it did before, so the whole card shows above where the keyboard was.
    private func turnOver(back: Bool) {
        if replyFocus != nil { pendingFocus = back ? .back : .face; replyFocus = pendingFocus }
        turned = back
    }

    /// The back is drawn at the face's angle first, then turns in; turned away, it leaves once the turn ends.
    private func turn(to back: Bool) {
        if reduceMotion {
            flipped = back; backMounted = back
        } else if back {
            backMounted = true
            DispatchQueue.main.async { withAnimation(PhoneTheme.surfaceMove) { flipped = showsBack } }
        } else {
            withAnimation(PhoneTheme.surfaceMove) { flipped = false } completion: { if !showsBack { backMounted = false } }
        }
    }

    /// The card's face: everything a choice needs, with the thread's latest line at its foot.
    private var front: some View {
        let shape = RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous)
        // INF-944 items 1 and 2, the Mac's shape: the head and the choices stay in the frame, and the body scrolls
        // between them in this one native scroller. The body's web view never scrolls on its own.
        return VStack(alignment: .leading, spacing: 0) {
            if pinsFrame { measuredHead }
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !pinsFrame { measuredHead }
                        content.padding([.horizontal], PhoneTheme.space4).padding(.bottom, PhoneTheme.space4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if hasFoot && !pinsFrame { measuredFoot }
                        Color.clear.frame(height: 0).id(Self.contentEnd)
                        // INF-3468: the reply, or a text box at the body's foot, sits a little less than the margin above
                        // the end of the card's content, so while a card's box types in a card that runs past its scroller,
                        // the content runs the margin further and the box can rest with the margin under it. A card that
                        // shows whole keeps still, its head in view.
                        if typingOverflows { Color.clear.frame(height: PhoneTyping.margin).allowsHitTesting(false) }
                    }
                    .coordinateSpace(.named(Self.contentSpace))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }
                .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
                .scrollBounceBehavior(bounce)
                // A body that fits and is pulled down past its top, as it bounces, still has nothing below the choices.
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    max(geometry.contentOffset.y, 0) + geometry.containerSize.height < geometry.contentSize.height - 1
                } action: { _, below in runsOn = below }
                .accessibilityIdentifier("card-scroll")
                .scrollDismissesKeyboard(.interactively)
                .onScrollPhaseChange { _, phase in scrolled(phase) }
                // INF-2568: SwiftUI scrolls a field into view as it takes the focus, but only its top line, and not as it
                // grows or as the keyboard shortens the scroller, so a reply inside the scroller keeps its foot, where the
                // caret types, in view.
                // The room is what shows: the scroller runs under the top bar, which its insets leave out.
                .onScrollGeometryChange(for: [CGFloat].self) { geometry in
                    [geometry.containerSize.height, geometry.contentInsets.top]
                } action: { _, frame in
                    scrollFrame = frame[0]; scrollRoom = frame[0] - frame[1]; followCaret(); followNote()
                }
                .onChange(of: replyFocus) { followCaret() }
                .onChange(of: noteFocus) { followNote() }
                // INF-3746: an open note shows its part, then its editor, whose comment always wins the room: a scroll of
                // the least distance to each, so a part taller than the room keeps its last lines above the editor.
                .onChange(of: noteGrew) {
                    scroller.scrollTo(Self.notePart, anchor: nil)
                    scroller.scrollTo(Self.noteRest, anchor: nil)
                }
                // INF-3468: the field comes to rest with the choices under it, or with the margin under it.
                .onChange(of: revealedNote?.seq) {
                    withAnimation(reduceMotion ? nil : PhoneTheme.surfaceMove) { scroller.scrollTo(Self.noteReveal, anchor: .center) }
                }
                .onChange(of: replyGrew) {
                    if !pinsFrame { scroller.scrollTo(restsWithChoices ? Self.contentEnd : Self.replyRest, anchor: .bottom) }
                }
            }
            if hasFoot && pinsFrame { measuredFoot }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(shape)
        // INF-1524 piece 1: the Mac's raised surface, its edge and shadow outside the clipped content.
        .phoneCardSurface()
        // A frame holding only its scroller is that scroller to accessibility, which then keeps the scroller's name.
        .accessibilityElement(children: .contain).accessibilityIdentifier(pinsFrame ? "card-frame" : "card-scroll")
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { surfaceHeight = $0; if shown { row.height = $0 } }
        // INF-3296's phone piece: the body lights what Point at, the queue and the open note say.
        .onChange(of: noteState) { host.annotates = takesNotes && shown; syncNotes() }
    }
    private var noteState: [PhoneJSON] { [.bool(pointAt), .array(notes), pick?.note ?? .null, .bool(takesNotes)] }

    /// INF-1919, the card's back: Card turns it over again, then the thread's count and the face's own minus, the
    /// card's title in one muted line, the messages as the face drew them before, and the same field and choices at its
    /// foot. It stands as tall as the face at least, and grows with its thread up to the stage's height.
    private var back: some View {
        let shape = RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous)
        let ideal = backHeadHeight + threadHeight + backFootHeight
        let height = min(paneHeight > 0 ? paneHeight : .infinity, max(surfaceHeight, ideal))
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: PhoneTheme.space2) {
                    Button { turnOver(back: false) } label: {
                        Label {
                            Text(PhoneCardWords.threadCard)
                        } icon: {
                            // The latest line's own mark: a dot on the chevron, here for a revision behind the thread.
                            Image(systemName: "chevron.left").overlay(alignment: .topTrailing) {
                                if updatedBehind {
                                    Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6).offset(x: 3, y: -3)
                                        .accessibilityHidden(true)
                                }
                            }
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .foregroundStyle(PhoneTheme.secondary)
                    .accessibilityValue(updatedBehind ? PhoneCardWords.threadCardUpdated : "")
                    .keyboardShortcut(shown && showsBack ? KeyboardShortcut("\\", modifiers: .command) : nil)
                    .accessibilityIdentifier("thread-return")
                    Spacer(minLength: PhoneTheme.space2)
                    Text(PhoneCardWords.threadCount(messages.count).uppercased()).font(PhoneFont.micro)
                        .foregroundStyle(PhoneTheme.muted).accessibilityIdentifier("thread-count")
                    // The captain's ask: a card showing its thread still offers its minus.
                    putAsideButton(.back)
                }
                Text(card.title).font(PhoneFont.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                    .padding(.bottom, PhoneTheme.space2).accessibilityIdentifier("thread-title")
            }
            .padding(.leading, PhoneTheme.space3).padding(.trailing, PhoneTheme.space4)
            // INF-3106 direction B: a tap on the thread's head puts the keyboard away; Card still turns the card over.
            .contentShape(Rectangle())
            .onTapGesture { if messageContext.keyboardUp { dismissPhoneKeyboard() } }
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { backHeadHeight = $0 }
            PhoneThreadScroller(messages: messages, working: working, bounce: bounce,
                                onHeight: { threadHeight = $0 }, onPhase: scrolled,
                                onNote: card.isPast ? nil : { note in await revealNote(note) })
                .frame(maxHeight: threadHeight > 0 ? threadHeight : nil)
            Spacer(minLength: 0)
            backFoot.fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { backFootHeight = $0 }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // INF-2568: a back taller than the room the keyboard leaves keeps its foot, with the field, in view.
        .frame(height: height.isFinite && height > 0 ? height : nil, alignment: .bottom)
        .clipShape(shape)
        .phoneCardSurface()
        .accessibilityElement(children: .contain).accessibilityIdentifier("card-back")
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { backHeight = $0 }
    }

    /// The back's foot: the field and, by the captain's pick, the choices, so a reply and a choice are made here too.
    private var backFoot: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if let problem { Text(problem).foregroundStyle(PhoneTheme.warning) }
            if takesReply { replyField(.back) }
            choiceRow
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space2).padding(.bottom, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
    }

    /// INF-1919, the Mac's collapsed-thread row at the face's foot: who wrote last in their color and the newest words
    /// on one line, then working while the author is at work, the replies new since the back last showed, with a dot
    /// on the chevron, or how many messages there are. A tap, or Command-backslash, turns the card over.
    private var latestLine: some View {
        let last = messages.last
        let who = last?["who"].text ?? "host"
        let state = working ? PhoneCardWords.threadWorking
            : unread > 0 ? PhoneCardWords.newCount(unread) : PhoneCardWords.messageCount(messages.count)
        return Button { turnOver(back: true) } label: {
            HStack(spacing: PhoneTheme.space2) {
                Text(PhoneCardWords.threadWho[who] ?? who).font(PhoneFont.mono).foregroundStyle(PhoneCardThread.color(who))
                Text(last?["text"].text ?? "").font(PhoneFont.caption).lineLimit(1)
                    .foregroundStyle(who == "host" ? PhoneTheme.muted : PhoneTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(state).font(PhoneFont.mono).foregroundStyle(unread > 0 && !working ? PhoneTheme.accent : PhoneTheme.muted)
                if working { ProgressView().controlSize(.mini) }
                Image(systemName: "chevron.right").font(PhoneFont.mono).foregroundStyle(PhoneTheme.muted)
                    .overlay(alignment: .topTrailing) {
                        if unread > 0 {
                            Circle().fill(PhoneTheme.accent).frame(width: 6, height: 6).offset(x: 3, y: -3).accessibilityHidden(true)
                        }
                    }
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(shown && !showsBack ? KeyboardShortcut("\\", modifiers: .command) : nil)
        .accessibilityLabel(PhoneCardWords.threadCount(messages.count))
        .accessibilityValue(state)
        .accessibilityIdentifier("thread-cue")
    }

    private var head: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                PhoneFlowRow(spacing: PhoneTheme.space2) {
                    kind
                    if card.reviewTaskId != nil {
                        Text(PhoneCardWords.reviewFinding).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                    }
                    if let task {
                        Button(task.key) { onTask(task.key) }
                            .font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary).buttonStyle(.plain)
                            .frame(minHeight: 28).contentShape(Rectangle())
                            .accessibilityHint(PhoneMessages.phoneCardsTaskKeyHint()).accessibilityIdentifier("card-task-key")
                    }
                    if let place = card.value["place"].text {
                        Text(place).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("card-place")
                    }
                    if let model = card.value["model"].text {
                        Text(model).font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .overlay { Capsule().strokeBorder(PhoneTheme.line) }
                            .accessibilityIdentifier("card-model")
                    }
                    if card.value["risk"]["declared"] != .null { PhoneRiskDots(declared: card.value["risk"]["declared"]) }
                }
                // A core from before INF-2714 names the task a first mate card speaks about; a crewmate's own name stays off the head.
                if card.author == "firstmate", let meta = card.meta, meta != "firstmate" {
                    Text(meta).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                }
                Text(card.title).font(.custom("SpaceGrotesk-Light", size: 20, relativeTo: .title3).weight(.semibold))
                    .accessibilityIdentifier("card-title")
                if let revised { Text(revised).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("card-revised") }
                if let asked = card.asked { PhoneAskedLine(asked: asked, open: $askedOpen) }
            }
            Spacer(minLength: PhoneTheme.space2)
            putAsideButton(.face)
        }
        .contentShape(Rectangle())
        // INF-3106 direction B: a tap on the card's head puts the keyboard away; the head's own buttons keep their taps.
        .onTapGesture { if messageContext.keyboardUp { dismissPhoneKeyboard() } }
    }

    /// The card's one minus, at the trailing end of its face's head and of its thread's head; Shift-Command-M presses
    /// the one on the side that shows.
    private func putAsideButton(_ side: CardSide) -> some View {
        Button(action: putAside) {
            Label(card.isPast ? PhoneCardWords.panelLeave : (card.value["corner"]["label"].text ?? PhoneCardWords.putAside), systemImage: "minus")
                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
            .keyboardShortcut(shown && showsBack == (side == .back) ? KeyboardShortcut("m", modifiers: [.command, .shift]) : nil)
            .accessibilityHint(rest(card.isPast ? PhoneCardWords.panelLeaveRest : (card.value["corner"]["restWords"].text ?? PhoneCardWords.putAsideRest)))
            .accessibilityIdentifier(side == .face ? "put-aside-card" : "thread-put-aside")
            .disabled(host.changing || (!card.isPast && !session.canChange))
    }

    /// The words after a control's name in the Mac's rest line ("Close · stays on INF-1's record"), as its VoiceOver hint.
    private func rest(_ line: String) -> String {
        let words = line.components(separatedBy: " · ").dropFirst().joined(separator: " · ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// The Mac's revised line under the title: when the card last changed, and how much of it.
    private var revised: String? {
        let changes = card.value["changes"]
        guard !card.isPast, changes != .null, let at = changes["at"].numeric else { return nil }
        let date = Date(timeIntervalSince1970: at / 1000)
        let time = Calendar.current.isDateInToday(date) ? PhoneFormats.time(date) : PhoneFormats.dateTime(date)
        return PhoneCardWords.revisedLine(time: time, added: Int(changes["added"].numeric ?? 0),
                                          removed: Int(changes["removed"].numeric ?? 0), rewritten: changes["rewritten"].flag)
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space4) {
            if card.isPast {
                Text(ending).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("past-ending")
            }
            // INF-3149, the captain's direction C: what happens after the merge leads the body and scrolls away with it.
            PhoneAfterMerge(actions: card.value["requiredActions"].list, steps: card.value["afterMerge"].list)
            if let failure = host.failure {
                Text(failure).foregroundStyle(PhoneTheme.secondary)
                if host.reading["of"].numeric != nil {
                    Text(PhoneMessages.phoneCardsRetryNote()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                }
                Button(PhoneMessages.phoneCommonRetry()) {
                    let fill = host.reading["answers"]; host.close(); problem = nil
                    host = Self.bodyHost(card, session, fill, heightLag: CardWebHost.retriedHeightLag)
                    bodies?.replace(card, with: host)
                    connectHost(); retry += 1
                }.buttonStyle(PhoneChoiceStyle(.secondary)).disabled(host.changing).accessibilityIdentifier("retry-card")
            } else {
                ZStack(alignment: .top) {
                    CardWebView(host: host).frame(height: host.height).id(retry)
                        // INF-3296's phone piece: where a note revealed from the thread sits, for the scroller to bring in.
                        .overlay(alignment: .top) {
                            if let revealedNote {
                                Color.clear.frame(height: max(1, revealedNote.height)).id(Self.noteReveal)
                                    .padding(.top, revealedNote.top).allowsHitTesting(false).accessibilityHidden(true)
                            }
                            if let pick {
                                Color.clear.frame(height: max(1, pick.box.height)).id(Self.notePart)
                                    .padding(.top, pick.box.minY).allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                    // INF-3746, the captain's direction B: the note editor under the lit part, inside the card at the reply
                    // box's width, over the lines below it; the body runs on under it when the part is near its end.
                    if let pick, shown, !noteInFoot {
                        noteEditor.padding(.top, pick.box.maxY + PhoneTheme.space2)
                    }
                }
            }
            if let notice = host.notice { Text(notice).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-notice") }
            if card.value["attachment"] != .null {
                PhoneBrowserStrip(attachment: card.value["attachment"], session: session) { host.notice = PhoneMessages.phoneCardsDoThisOn(computer: session.mac.name) }
            }
            // A computer from before every note had its button still sends only an answer's Done here.
            if !card.isPast, card.value["noteDone"] == .null, let taskID = card.value["answerDone"]["taskId"].text {
                Button(card.value["answerDone"]["label"].text ?? PhoneCardWords.done) {
                    perform {
                        do {
                            try await session.change(.choose(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID),
                                                     .run, args: [taskID, PhoneTaskEnding.answerDone.rawValue])
                            host.chosen = true
                        } catch {}
                    }
                }.buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("answer-done")
                    .disabled(host.changing || !session.canChange)
            }
        }
    }

    /// INF-944 item 5 with the captain's INF-945 pick: the Mac's row, pinned under a hairline while the body runs on beneath.
    /// The Mac's footer order (footerGroups.ts): quiet actions such as the app's Decline first, then the other choices,
    /// and the default last, at the trailing edge.
    private var footerOrder: [PhoneJSON] {
        let quiet = card.actions.filter { $0["variant"].text == "ghost" }
        let choices = card.actions.filter { $0["variant"].text != "ghost" }
        return quiet + choices.filter { !$0["default"].flag } + choices.filter { $0["default"].flag }
    }

    /// The Mac's footerVariant: the action's own variant, else primary for the default. The default waits muted while a
    /// required question has no answer.
    private func footerKind(_ action: PhoneJSON) -> PhoneChoiceStyle.Kind {
        if unanswered && action["default"].flag { return .muted }
        switch action["variant"].text {
        case "primary": return .primary
        case "danger": return .danger
        case "secondary", "ghost": return action["danger"].flag ? .danger : .secondary
        default: return action["danger"].flag ? .danger : action["default"].flag ? .primary : .secondary
        }
    }

    private var chosenID: PhoneJSON? { card.isPast && card.value["ending"]["how"].text != "closed" ? card.value["ending"]["actionId"] : nil }

    private var foot: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            // INF-1524 piece 3: a merge card's facts stay with its choices.
            if let factsHost, factsHost.failure == nil {
                CardWebView(host: factsHost).frame(height: factsHost.height)
            }
            if let line { Text(line).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-error") }
            // INF-2565: a pane built again while its back shows starts turned, and its latest line gives way as the field does.
            if !messages.isEmpty { latestLine.modifier(PhoneFaceOnly(angle: turnAngle)) }
            // INF-3746: while a note is open the reply and the choices step aside for it; on an iPhone on its side the
            // editor takes their place in the foot.
            if pick != nil && shown && noteInFoot { noteEditor.modifier(PhoneFaceOnly(angle: turnAngle)) }
            if takesReply && pick == nil {
                replyField(.face).modifier(PhoneFaceOnly(angle: turnAngle))
                    // INF-3468: the field and the margin under it, the place a typing field in a scrolling card rests.
                    .background(alignment: .top) {
                        Color.clear.frame(height: replyHeight + PhoneTyping.margin).allowsHitTesting(false).id(Self.replyRest)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.paneSpace)) } action: { frame in
                        if pinsFrame { faceReplyFrame = frame }
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.contentSpace)) } action: { frame in
                        if !pinsFrame { replyInContent = frame }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in replyHeight = height; followCaret() }
            }
            if card.isPast, let words = sentWords {
                Text("\(PhoneCardWords.sentWithChoice) \(words)").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("past-sent-words")
            }
            if pick == nil { choiceRow.modifier(PhoneFaceOnly(angle: turnAngle)) }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space2).padding(.bottom, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if runsOn && pinsFrame { Rectangle().fill(PhoneTheme.line).frame(height: 1) } }
    }

    @ViewBuilder private var choiceRow: some View {
            // INF-2794: every live note's one button, Done or Got it, where a decision's default sits.
            if card.actions.isEmpty, !card.isPast, let label = card.value["noteDone"]["label"].text {
                PhoneChoiceRow {
                    Button { pressNote() } label: {
                        HStack(spacing: 6) {
                            Text(label)
                            if pending == Self.noteDoneID { ProgressView().controlSize(.mini).accessibilityLabel(PhoneMessages.phoneCommonSending()) }
                        }
                    }
                    .buttonStyle(PhoneChoiceStyle(.primary))
                    .disabled(host.changing || !session.canChange)
                    .accessibilityHint(rest(card.value["noteDone"]["restWords"].text ?? ""))
                    .accessibilityIdentifier("note-done")
                }
            }
            if !card.isPast, let secrets, let use = secrets.use(card: card.id) {
                approvalFoot(use, secrets)
            } else if !card.actions.isEmpty {
                PhoneChoiceRow {
                    if asking, let count = host.reading["of"].numeric {
                        Text(PhoneCardWords.answersLine(answered: Int(host.reading["answered"].numeric ?? 0), of: Int(count),
                                                        changed: Int(host.reading["changed"].numeric ?? 0), preview: host.preview))
                            .font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                            .layoutValue(key: PhoneChoiceRow.Leading.self, value: true)
                    }
                    ForEach(Array(footerOrder.enumerated()), id: \.offset) { _, action in
                        Button { choose(action) } label: {
                            HStack(spacing: 6) {
                                Text(action["label"].text ?? PhoneMessages.phoneCardsChooseFallback())
                                if pending != nil && pending == action["id"].text { ProgressView().controlSize(.mini).accessibilityLabel(PhoneMessages.phoneCommonSending()) }
                            }
                        }
                        .buttonStyle(PhoneChoiceStyle(footerKind(action), chosen: chosenID == action["id"]))
                        .disabled(card.isPast || host.changing || !session.canChange || !host.revealed)
                        .accessibilityValue(chosenID == action["id"] ? PhoneMessages.phoneCardsChosen() : "")
                        .accessibilityIdentifier("card-action-\(action["id"].text ?? "")")
                    }
                }
            }
    }

    /// INF-1524, the captain's picks: the reply field pinned above the choices, its words also going with a choice, and
    /// photos from the library or the camera. INF-1919: the face and the back each draw it, with one draft and photos.
    private func replyField(_ side: CardSide) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if !notes.isEmpty {
                PhoneQueuedNotes(notes: notes, disabled: host.changing, onEdit: editNote,
                                 onRemove: { note in notes.removeAll { PhoneCardNotes.same($0, note) } }, failures: noteFailures)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(photos) { photo in
                            Button { photos.removeAll { $0.id == photo.id } } label: {
                                Image(uiImage: photo.image).resizable().scaledToFill()
                                    .frame(width: 44, height: 44).clipped()
                                    .overlay(alignment: .topTrailing) { Image(systemName: "xmark.circle.fill").foregroundStyle(PhoneTheme.text, PhoneTheme.surface) }
                            }.accessibilityLabel(PhoneMessages.phoneCommonRemovePhoto()).accessibilityIdentifier("reply-photo-chip")
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 0) {
                // INF-3296's phone piece: Point at, at the field's leading edge as on the Mac; while it is on, a tap on a
                // part of the body opens its note. Words selected in the body offer Annotate in their menu either way.
                // It steps aside while the reply types, so the words keep the field's whole width and the card rises no
                // further than INF-3468 lets it (its press would put the keyboard away in any case).
                if takesNotes && replyFocus == nil {
                    Button {
                        pointAt.toggle()
                        if pointAt { replyFocus = nil; dismissPhoneKeyboard() }
                    } label: {
                        // INF-3746: the Mac's outline pointer, lit in a 32-point circle that sits inside the field's
                        // rounded end, in a 44-point touch area.
                        PhoneSymbol.pointer.image.resizable().frame(width: 18, height: 18)
                            .foregroundStyle(pointAt ? PhoneTheme.accent : PhoneTheme.secondary)
                            .frame(width: 32, height: 32)
                            .background { if pointAt { Circle().fill(PhoneTheme.accentDim) } }
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(PhoneCardWords.pointAt)
                    .accessibilityAddTraits(pointAt ? .isSelected : [])
                    .accessibilityIdentifier("point-at")
                    .disabled(host.changing || !host.drawn)
                }
                Menu {
                    Button { libraryOpen = true } label: { Label(PhoneMessages.phoneCardsChoosePhotos(), systemImage: "photo.on.rectangle") }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { cameraOpen = true } label: { Label(PhoneMessages.phoneCardsTakePhoto(), systemImage: "camera") }
                    }
                } label: {
                    Label(PhoneMessages.phoneCardsAddPhotos(), systemImage: "photo").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .disabled(photos.count >= PhoneLimits.images || host.changing).accessibilityIdentifier("reply-photos")
                TextField(PhoneCardWords.replyHint, text: $reply, axis: .vertical).lineLimit(1...5)
                    .padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                    .focused($replyFocus, equals: side).accessibilityIdentifier("card-reply")
                    .onAppear { if pendingFocus == side { replyFocus = side; pendingFocus = nil } }
                // INF-3746: the message box's own 32-point send circle, in a 44-point touch area.
                Button(action: sendReply) {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PhoneTheme.onAccent)
                        .frame(width: 32, height: 32)
                        .background(canSendReply ? PhoneTheme.accent : PhoneTheme.muted, in: Circle())
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.accessibilityLabel(PhoneMessages.phoneCardsSendReply()).accessibilityIdentifier("send-reply")
                    .disabled(!canSendReply)
                    .hidesKeyboardBefore(replyFocus == side && messageContext.keyboardUp, diameter: 32)
            }.phoneInput()
                // INF-589 item 11: the line under the composer says why; the reply row only dims.
                .opacity(session.canChange ? 1 : 0.5)
            if reply.utf16.count > PhoneLimits.reply { Text(PhoneMessages.phoneCardsReplyTooLong(count: PhoneLimits.reply)).foregroundStyle(PhoneTheme.warning) }
        }
    }

    /// A Secrets use the home raised this card for: an enrolled phone allows it with its own confirmation and
    /// signature, and any phone may refuse it (docs/secrets.md, "Remote decisions"). INF-1109, the captain: "right
    /// now it's not even clear what secrets are being requested", so each secret is named as the computer's card
    /// names it (`named`): its place only when another saved secret shares its name (INF-1690's plan).
    /// A computer's own title gives one or two secrets as "the X secret" or "the X and Y secrets" before the task
    /// that asked; when the title holds that exact phrase the foot leaves the names to it, so the choices stay
    /// pinned in the frame on an iPhone beside a title that runs to three lines. Otherwise, as with three secrets
    /// or an older computer's title, the foot names every secret.
    private func approvalFoot(_ use: PhoneApprovals.Use, _ secrets: PhoneSecrets) -> some View {
        let allows = secrets.standing == .enrolled && use.nonce != nil
        let names = use.secrets.map(use.named)
        let phrases = names.count == 1 ? ["the \(names[0]) secret to "] // i18n-exempt: matched in the computer's own title, not shown
            : names.count == 2 ? ["the \(names[0]) and \(names[1]) secrets to ", "the \(names[1]) and \(names[0]) secrets to "] // i18n-exempt: matched in the computer's own title, not shown
            : []
        let titleNames = phrases.contains { card.title.contains($0) }
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            ForEach(titleNames ? [] : use.secrets, id: \.ref) { secret in
                let name = Text(secret.label).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                let detail = Text(use.detail(secret).joined(separator: " · ")).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                Text("\(name)  \(detail)")
                    .accessibilityLabel(use.named(secret)).accessibilityIdentifier("approval-secret-\(secret.ref)")
            }
            Text(allows ? PhoneMessages.phoneCardsApprovalAsks(confirmation: ApprovalKey.confirmation)
                : PhoneMessages.phoneCardsApprovalTurnOn(computer: session.mac.name))
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("approval-note")
            PhoneChoiceRow {
                if allows {
                    Button(PhoneDecision.allowWords) { decide { try await secrets.allow(use) } }
                        .buttonStyle(PhoneChoiceStyle(.primary)).accessibilityIdentifier("approval-allow")
                }
                Button(PhoneDecision.denyWords) { decide { try await secrets.deny(use) } }
                    .buttonStyle(PhoneChoiceStyle(.secondary)).accessibilityIdentifier("approval-deny")
            // Like every card's choices (INF-1083, INF-1574), these take a press only once the body is revealed at
            // its drawn height: until then it is still laying out, the choices still move, and a press can land
            // beside the one meant.
            }.disabled(host.changing || !session.canChange || !host.revealed)
        }
    }
    private func decide(_ decision: @escaping @MainActor () async throws -> PhoneSecrets.Outcome) {
        let activeHost = host
        perform {
            switch try await decision() {
            case .accepted: break
            case .stillWaiting:
                throw PhoneRequestError(PhoneMessages.phoneCardsApprovalStillWaiting())
            case .refused(let reason): throw PhoneRequestError(reason)
            }
            activeHost.chosen = true
            onSent()
        }
    }
    private var kind: some View {
        let attention = !card.isPast && card.author == "host"
        let ended = !card.isPast && card.value["ended"] != .null
        return Text(card.isPast ? PhoneMessages.cardPastMark() : ended ? PhoneMessages.phoneCardsKindEnded() : attention ? PhoneMessages.uiCardKindAttention()
            : card.actions.isEmpty ? PhoneMessages.uiCardKindNote() : PhoneMessages.uiCardKindDecision())
            .font(.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption2))
            .foregroundStyle(attention ? PhoneTheme.danger : card.actions.isEmpty || card.isPast ? PhoneTheme.secondary : PhoneTheme.accent)
            .padding(.horizontal, PhoneTheme.space2).padding(.vertical, 4)
            .background(PhoneTheme.background, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
    }
    private var ending: String {
        let end = card.endingForWords
        let words = PhonePastEnding.words(end)
        guard let at = end["at"].numeric else { return words }
        return "\(words) · \(PhoneFormats.dateTime(Date(timeIntervalSince1970: at / 1000)))"
    }
    /// The words a past card's choice carried from its field (the Mac's anythingElseOf).
    private var sentWords: String? {
        let words = card.value["answers"].list.first { $0["name"].text == PhoneCardWords.anythingElse }?["written"].text
        return words?.isEmpty == false ? words : nil
    }
    private func onMac(_ action: PhoneJSON) -> Bool {
        let effect = action["effect"]
        return (effect["kind"].text == "open" && !(effect["target"].text == "browser" && effect["savedSignIn"].flag))
            || (effect["kind"].text == "host" && effect["op"].text == "restore-account")
            // Its other Secrets choices need the person's confirmation on the computer itself.
            || (effect["kind"].text == "host" && effect["op"].text == "secrets-decision")
    }

    private func choose(_ action: PhoneJSON) {
        if onMac(action) { host.notice = PhoneMessages.phoneCardsDoThisOn(computer: session.mac.name); return }
        let id = action["id"].text
        perform {
            pending = id
            defer { pending = nil }
            let snapshot = try await host.submissionReading()
            let reading = snapshot.value
            guard !action["default"].flag || reading["answered"] == reading["of"] else {
                throw PhoneRequestError(PhoneMessages.phoneCardsAnswerRequiredFirst())
            }
            // INF-1524: the field's words go with the choice as its anything-else answer, as the Mac's withAnythingElse sends them.
            let words = replyWords
            var answers = reading["answers"].list.filter { $0["name"].text != PhoneCardWords.anythingElse }
            if !words.isEmpty {
                answers.append(.object(["name": .string(PhoneCardWords.anythingElse), "values": .array([]),
                                        "changed": .bool(true), "written": .string(words)]))
            }
            // INF-2553: the card leaves at the tap with its words; a refusal brings it back to its place with them.
            if replyWords == words { reply = "" }
            let sent = await send(.choose(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .act,
                [.string(card.id), action["id"], .string("chrome"), .object(["answers": .array(answers)]),
                 card.submission(reading: reading, fresh: snapshot.fresh)],
                restore: { [reply = $reply] in if reply.wrappedValue.isEmpty { reply.wrappedValue = words } })
            if sent { host.chosen = true; onSent() }
        }
    }

    private func sendReply() {
        perform {
            let text = reply, sent = photos, noted = notes
            guard replyFits else { return }
            let snapshot = try await host.submissionReading()
            let reading = snapshot.value
            var payload: [String: PhoneJSON] = ["text": .string(text), "answers": reading["answers"]]
            if !sent.isEmpty {
                payload["images"] = .array(sent.map { photo in .object(photo.wire.mapValues(PhoneJSON.string)) })
            }
            // INF-3296's phone piece: every queued note goes with the words as one reply.
            if !noted.isEmpty { payload["notes"] = .array(noted) }
            // INF-2553: the words join the thread at once, marked sending, and the draft clears; a refusal puts the
            // words and photos back. INF-1919: a send from either side shows its line on the back, the first included.
            if reply == text { reply = "" }
            photos.removeAll { photo in sent.contains { $0.id == photo.id } }
            notes.removeAll { note in noted.contains { PhoneCardNotes.same($0, note) } }
            pointAt = false
            turned = true; replyFocus = nil
            let before = PhoneIntentLedger.captainMessages(session.threads[card.id])
            let delivered = await self.send(.reply(card: card.id, text: PhoneCardNotes.sendingText(text, noted), before: before), .reply,
                [.string(card.id), .object(payload), card.submission(reading: reading, fresh: snapshot.fresh), .bool(replyLeaves)],
                restore: { [reply = $reply, photos = $photos, notes = $notes] in
                    if reply.wrappedValue.isEmpty { reply.wrappedValue = text }
                    photos.wrappedValue = sent + photos.wrappedValue
                    notes.wrappedValue = noted.reduce(notes.wrappedValue) { queue, note in
                        queue.contains { PhoneCardNotes.same($0, note) } ? queue : queue + [note]
                    }
                })
            if delivered { onSent() }
        }
    }

    private static let noteDoneID = "note-done"

    /// A live note's own button (INF-2794): the computer decides whether it closes the task (Done) or reads the note (Got it).
    private func pressNote() {
        perform {
            pending = Self.noteDoneID
            defer { pending = nil }
            let sent = await send(.close(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .noteDone,
                                  [.string(card.id), card.submission()])
            if sent { host.chosen = true; onSent() }
        }
    }

    /// The shared minus only puts away (INF-2794); a computer from before that still reads a note it marks "read".
    /// The session shows it at the tap and restores its place if the computer refuses it.
    private func putAside() {
        if card.isPast { onHide(); return }
        perform {
            let sent: Bool
            if card.value["corner"] == .null {
                sent = await send(.putAside(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .minimize,
                                  [.string(card.id), .bool(true)])
            } else {
                let kind: PhoneIntent.Kind = card.value["corner"]["operation"] == .string("read")
                    ? .close(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID)
                    : .putAside(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID)
                sent = await send(kind, .close, [.string(card.id), card.submission()])
            }
            if sent { host.chosen = true }
        }
    }

    /// Sends one change through the session's intent layer, which shows it now and says why when it is taken back,
    /// so the pane itself says nothing more; true once the computer accepted it.
    private func send(_ kind: PhoneIntent.Kind, _ channel: PhoneCardRequest, _ args: [PhoneJSON],
                      restore: (@MainActor () -> Void)? = nil) async -> Bool {
        do { try await session.change(kind, channel, args, restore: restore); return true } catch { return false }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        let activeHost = host
        guard activeHost.beginChange() else { return }
        problem = nil
        Task {
            defer { activeHost.busy = false }
            do { try await operation() } catch { problem = error.localizedDescription }
        }
    }
    private func connectHost() {
        host.onReading = onReading; host.onDrawn = { markSeen(); syncNotes() }
        host.annotates = takesNotes && shown
        host.onAnnotate = { note, box in
            guard takesNotes, shown, !host.changing else { syncNotes(); return }
            // A comment being written keeps its editor; the frame's pick goes back to it.
            if let pick, !pick.comment.isEmpty { syncNotes(); return }
            if showsBack { turnOver(back: false) }
            replyFocus = nil
            pick = PhoneNotePick(note: note, box: box, queued: notes)
        }
        host.onAnnotationIdle = { syncNotes() }
        host.onPointExit = { pointAt = false }
        host.onLink = { url in openURL(url) }
        host.onDraft = onDraft
        host.onTask = onTask
        // INF-3110: a card beside the shown one keeps its body out of accessibility, which a hidden view above it cannot do.
        host.aside = !shown; factsHost?.aside = !shown
    }
    /// INF-3296's phone piece: tells the body how the notes stand, which it lights: Point at, every queued note and the
    /// one being written. The body never hears a comment.
    private func syncNotes() {
        guard takesNotes else { if host.drawn { host.annotate(mode: false, queued: [], current: nil) }; return }
        host.annotate(mode: pointAt && pick == nil && shown, queued: notes, current: pick?.note)
    }
    /// The editor's Queue: the note joins the queue, or takes its own place there again; with Command-Return the reply
    /// goes too, with every queued note. A text note leaves no selection behind in the body (INF-3746).
    private func queueNote(send: Bool) {
        guard let picked = pick, !host.changing else { return }
        let queue = PhoneCardNotes.queuing(picked.written, in: notes)
        notes = queue
        noteFailures[PhoneQueuedNotes.id(picked.note)] = nil
        pick = nil
        if picked.note["span"] != .null { host.annotate(mode: pointAt && shown, queued: queue, current: nil, clearsSelection: true) }
        if send { sendReply() }
    }
    /// A queued note's Edit: the body shows its part again and its editor opens under it, with its comment.
    private func editNote(_ note: PhoneJSON) {
        Task {
            let result = await revealNote(note)
            switch result {
            case .revealed(let top, let height):
                noteFailures[PhoneQueuedNotes.id(note)] = nil
                pick = PhoneNotePick(note: note, box: CGRect(x: 0, y: top, width: host.width, height: max(1, height)), queued: notes)
            case .missing: noteFailures[PhoneQueuedNotes.id(note)] = PhoneCardWords.staleNote
            case .unavailable: noteFailures[PhoneQueuedNotes.id(note)] = PhoneCardWords.unavailableNote
            }
        }
    }
    /// Shows a note's part, or its words, in the body: the card turns to its face and its scroller brings them into view.
    private func revealNote(_ note: PhoneJSON) async -> CardWebHost.NoteReveal {
        if showsBack { turnOver(back: false) }
        let result = await host.reveal(note)
        if case .revealed(let top, let height) = result {
            revealedNote = (top, height, (revealedNote?.seq ?? 0) + 1)
        }
        return result
    }
    /// The fact strip the body split off, drawn by a host of its own that holds only it and takes no answers.
    private func showFacts(_ facts: String) {
        guard factsHost == nil else { return }
        // INF-3460: a strip the row kept loaded beside the shown card arrives drawn with its body.
        guard let factsHost = bodies?.strip(card, facts: facts, session: session)
            ?? card.factsStrip(facts).map({ CardWebHost(card: $0, session: session, fill: .array([]), part: .facts) }) else { return }
        factsHost.onLink = { url in openURL(url) }
        factsHost.aside = !shown
        self.factsHost = factsHost
    }
    private func markSeen() {
        guard !card.isPast, host.drawn, reachable, visible, phase == .active else { return }
        onSeen()
    }
    /// A read the connection's end fails says nothing on the card: the card asks again once back in reach, and the
    /// computer button already says whether it is (the captain: "everywhere else in the ios app said it's in reach").
    private func readThread() {
        guard !card.isPast, reachable else { return }
        Task {
            do { try await session.readThread(card.id) }
            catch PhoneError.unavailable {}
            catch { problem = error.localizedDescription }
        }
    }
    private func loadPhotos() async {
        guard !photoSelection.isEmpty else { return }
        defer { photoSelection = [] }
        for item in photoSelection {
            do {
                guard photos.count < PhoneLimits.images, let bytes = try await item.loadTransferable(type: Data.self) else {
                    throw PhoneError.refused(PhoneMessages.phoneCardsPhotoNotAdded())
                }
                photos.append(try PhonePhoto(bytes: bytes))
            } catch is CancellationError { return }
            catch { problem = error.localizedDescription }
        }
    }
}

/// INF-1919: one face of a card that turns over about its upright axis. Each face shows for its half of the turn, so
/// the face never draws mirrored, and the hidden face takes no touches and stays out of the accessibility tree.
private struct PhoneCardTurn: ViewModifier, Animatable {
    var angle: Double
    let back: Bool

    nonisolated var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    func body(content: Content) -> some View {
        let shows = back == (angle >= 90)
        content
            .rotation3DEffect(.degrees(back ? angle - 180 : angle), axis: (x: 0, y: 1, z: 0), perspective: 0.4)
            .opacity(shows ? 1 : 0)
            .allowsHitTesting(shows)
            .accessibilityHidden(!shows)
    }
}

/// The face's field and choices while the back shows past its edge: a blank as tall, since a hidden control is still
/// found by a tap or by accessibility beside the back's own.
private struct PhoneFaceOnly: ViewModifier, Animatable {
    var angle: Double
    @State private var height: CGFloat = 0

    nonisolated var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    @ViewBuilder func body(content: Content) -> some View {
        if angle < 90 {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        } else {
            Color.clear.frame(height: height).accessibilityHidden(true)
        }
    }
}

/// The card's saved question label and time; the shared bubble owns its interaction (INF-1610, INF-1963).
/// INF-2326: the label also says a click, an automation or the task the work came from, as the Mac does.
/// The card holds whether it is open: opening it can move the head into or out of the scroller, a new line.
private struct PhoneAskedLine: View {
    let asked: PhoneAsked
    @Binding var open: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(asked.label()).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted)
                .accessibilityIdentifier("card-asked-label")
            if asked.inBubble {
                PhoneQuestionBubble(text: asked.shown, open: $open, identifier: "card-asked-toggle")
            } else if !asked.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // INF-2326: an automation's name or a task's title is not the captain's words, so no bubble.
                Text(asked.text).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                    .accessibilityIdentifier("card-asked-name")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card-asked")
    }
}

/// INF-2568: a card taller than its pane is cut at the pane's top and foot, where the bar and the pager or the keyboard
/// stand, while its shadow still reaches past the pane's sides; a card that fits keeps its whole shadow.
private struct PhonePaneClip: Shape {
    var clips: Bool

    func path(in rect: CGRect) -> Path {
        Path(clips ? rect.insetBy(dx: -rect.width, dy: 0) : rect.insetBy(dx: -rect.width, dy: -max(rect.width, rect.height)))
    }
}
