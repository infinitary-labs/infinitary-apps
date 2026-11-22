import InfinitaryKit
import SwiftUI
import UIKit

/// INF-1208's direction C, the captain's pick "Pages: one panel per page, the record in its place, the one-row bar". On
/// an open iPhone Duo the fold is the seam between two pages: one holds a panel, Tasks, Activity or the captain's own
/// panels, and the other Home. Direction A (`PhoneLayout.wide`, `PhoneLayout.sidebarWidth`) already brings the sidebar
/// to the fold like a book; C adds the pose on its side and half folded, the record in the panel's place and the bar.
extension PhoneLayout {
    /// Where Home's parts stand. `column` is one column with the strip; `beside` puts the sidebar at that width beside
    /// Home (an iPad on its side, an open Duo like a book); `panelAbove` and `panelBelow` split a window whose fold runs
    /// across it, at the fold's frame in Home's own space.
    enum Pages: Equatable {
        case column
        case beside(CGFloat)
        /// Open on its side: the panel above the fold and Home below it, nearest the hands.
        case panelAbove(CGRect)
        /// Half folded on its side, the laptop pose: the card on the upright half, and the panel and the message box on
        /// the flat half, where Apple asks for the controls.
        case panelBelow(CGRect)
        /// Typing on Home at a fold across the window, open or half folded: the card on the page above the fold and the
        /// message box over the keyboard, while the panel waits under the keyboard rather than show a strip of itself.
        case typing(CGRect)
        /// The captain: a panel's own field, such as Tasks' search or a record's steer box, typing at a fold across the
        /// window swaps the pages: the panel on the page above the fold, and Home's card and message box waiting under
        /// the keyboard until it closes.
        case panelTyping(CGRect)

        /// Whether Home's card and message box wait under the keyboard, hidden, while a panel's field types.
        var homeWaits: Bool { if case .panelTyping = self { true } else { false } }
    }

    /// The fold that runs across a window regular both ways and taller than wide, as on a Duo open on its side, inside
    /// Home's own height; none elsewhere. Folds are the window's division regions in Home's space with Apple's margins.
    static func foldAcross(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?, size: CGSize,
                           folds: [CGRect]) -> CGRect? {
        guard horizontal == .regular, vertical == .regular, size.height > size.width else { return nil }
        return folds.filter { $0.width > $0.height && $0.minY > 0 && $0.maxY < size.height }.min { $0.minY < $1.minY }
    }

    /// The pages for a window: A's sidebar where the window is wide, a split at a fold across it, with the panel below
    /// while the hinge is partly folded (the fold is then active), and one column otherwise. The workspace's room decides,
    /// so a pose reached while another tab shows still brings the panel beside Home; Home's own room places the split
    /// once Home is drawn, since a line under the bar may move Home down from the workspace's top.
    /// The captain: open on its side with the keyboard up for Home's typing, the half-folded placement, so the card keeps
    /// the page above the fold and the message box rides over the keyboard.
    static func pages(wide: Bool, sidebar: CGFloat, horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?,
                      window: Room, home: Room, typing: Bool = false, panelTyping: Bool = false) -> Pages {
        if wide { return .beside(sidebar) }
        guard let across = foldAcross(horizontal: horizontal, vertical: vertical, size: window.size, folds: window.folds)
        else { return .column }
        let fold = foldAcross(horizontal: horizontal, vertical: vertical, size: home.size, folds: home.folds) ?? across
        if typing { return .typing(fold) }
        if panelTyping { return .panelTyping(fold) }
        return window.active.contains { $0.intersects(across) } ? .panelBelow(fold) : .panelAbove(fold)
    }

    /// Whether a record opens in the panel's place: on a foldable's pages, where a fold divides the window; an iPad's
    /// sidebar has no fold beside it and keeps its sheet.
    static func recordInPlace(_ pages: Pages, width: CGFloat, folds: [CGRect]) -> Bool {
        switch pages {
        case .column: false
        case .beside: foldPage(width: width, folds: folds) != nil
        case .panelAbove, .panelBelow, .typing, .panelTyping: true
        }
    }

    /// The captain's "Yes, move it under the side panel": on a Duo open like a book, where the sidebar reaches the fold,
    /// the message box sits at the foot of the sidebar's page and the card's page holds the card and its pager alone. An
    /// iPad's sidebar, with no fold, and every other pose keep the message box under the card.
    static func composerUnderPanel(_ pages: Pages, width: CGFloat, folds: [CGRect]) -> Bool {
        if case .beside = pages { foldPage(width: width, folds: folds) != nil } else { false }
    }

    /// The captain's pick "Maximize card, as on the Mac": the card takes the window wherever a side panel shares it with
    /// Home, while one shows and the choice is on; with no card, or one column, the layout is as before. Home waiting
    /// under the keyboard for a panel's field keeps the split, so the field the person types in stays in sight.
    static func maximized(_ pages: Pages, chosen: Bool, cardShown: Bool) -> Bool {
        chosen && cardShown && pages != .column && !pages.homeWaits
    }

    /// Home's own size and the window's division regions in its space: every one, and the active ones alone.
    struct Room: Equatable {
        var size = CGSize.zero
        var folds: [CGRect] = []
        var active: [CGRect] = []
    }
}

enum PhonePagesRole: LayoutValueKey {
    static let defaultValue = Part.stage
    enum Part { case panel, divider, stage, composer, pager }
}

/// INF-1208's direction C: places the panel, the stage and the message box for `PhoneLayout.Pages`. One layout for every
/// pose keeps each part where it is in the view tree, so a turn or a fold moves the card, the draft and the panel without
/// drawing them afresh.
struct PhonePagesLayout: Layout {
    let pages: PhoneLayout.Pages
    /// The message box at the foot of the sidebar's page (`PhoneLayout.composerUnderPanel`).
    var composerUnderPanel = false
    /// The card takes all of Home's room (`PhoneLayout.maximized`); the panel and the message box stay mounted
    /// and hidden by the workspace, so their pick and draft stay for Restore.
    var maximized = false
    /// The folds the layout heeds in its own space (`PhoneLayout.Room`, Split at the fold applied): the stage and the
    /// message box keep to the wider side of one running down them (`PhoneLayout.keepOff`), worked out here from where
    /// each is placed, never read back from its own frame, so placing them cannot change the reading (INF-4838).
    var folds: [CGRect] = []
    var panelsFolded = false
    var openDuo = false
    var cardWidth: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        func part(_ part: PhonePagesRole.Part) -> LayoutSubview? { subviews.first { $0[PhonePagesRole.self] == part } }
        let composer = part(.composer)
        /// The span of a stage or message box placed at `x` across `width` once it keeps off a fold running down it: the
        /// folds are in the layout's own space, and `bounds` in its parent's.
        func offFold(_ x: CGFloat, _ width: CGFloat) -> (x: CGFloat, width: CGFloat) {
            if panelsFolded { return (x, width) }
            let local = folds.map { $0.offsetBy(dx: bounds.minX - x, dy: 0) }
            let inset = PhoneLayout.keepOff(folds: local, width: width)
            return (x + inset.leading, max(0, width - inset.leading - inset.trailing))
        }
        func composerHeight(_ x: CGFloat, _ width: CGFloat) -> CGFloat {
            composer?.sizeThatFits(.init(width: offFold(x, width).width, height: nil)).height ?? 0
        }
        func place(_ which: PhonePagesRole.Part, _ frame: CGRect, maximizing: Bool = false) {
            // Maximized, the stage is placed once, at the end, over the whole room, across the fold.
            if which == .stage && maximized != maximizing { return }
            var frame = frame.standardized
            // On an open Duo, keep the maximized card's hidden composer and draft mounted, but leave no field
            // frame in the window. SwiftUI can otherwise report a hit point for the disabled, transparent field.
            if which == .composer && maximized && openDuo { frame.origin.y = bounds.maxY + bounds.height }
            if which == .composer || (which == .stage && !maximizing) {
                (frame.origin.x, frame.size.width) = offFold(frame.minX, frame.width)
            }
            part(which)?.place(at: frame.origin, proposal: .init(width: frame.width, height: max(0, frame.height)))
        }
        /// The existing column, optionally with the pager beside the message box. Both are measured at the width
        /// they actually get; when the pager's own words need more room, it stacks above the same message box.
        func column(_ frame: CGRect, keepingStageMinimum: Bool = false) {
            let pagerSize = part(.pager)?.sizeThatFits(.unspecified) ?? .zero
            let gap = PhoneTheme.space3
            let content = offFold(frame.minX, frame.width)
            let together = pagerSize.height > 0 && composer != nil
                && content.width >= pagerSize.width + gap + PhoneColumn.width / 2 + 2 * PhoneTheme.space4
            let rowWidth = together ? min(PhoneColumn.width + pagerSize.width + gap, content.width) : frame.width
            let rowX = together ? content.x + (content.width - rowWidth) / 2 : frame.minX
            let boxX = together ? rowX + pagerSize.width + gap : frame.minX
            let boxWidth = together ? rowWidth - pagerSize.width - gap : frame.width
            let boxHeight = composerHeight(boxX, boxWidth)
            let pagerHeight = pagerSize.height > 0 ? pagerSize.height + gap : 0
            let foot = together ? max(boxHeight, pagerSize.height) : boxHeight + pagerHeight
            let room = max(0, frame.height - foot)
            let stageWidth = panelsFolded ? min(frame.width, (cardWidth ?? frame.width) + 2 * PhoneTheme.space4) : frame.width
            let stageX = frame.midX - stageWidth / 2
            let least = keepingStageMinimum
                ? part(.stage)?.sizeThatFits(.init(width: offFold(stageX, stageWidth).width, height: 0)).height ?? 0 : 0
            let height = max(room, least)
            let top = frame.minY - (height - room) / 2
            let bottom = top + height + foot
            place(.stage, CGRect(x: stageX, y: top, width: stageWidth, height: height))
            place(.composer, CGRect(x: boxX, y: bottom - boxHeight, width: boxWidth, height: boxHeight))
            if pagerSize.height > 0 {
                place(.pager, CGRect(x: together ? rowX : frame.midX - pagerSize.width / 2,
                                     y: bottom - pagerSize.height - (together ? PhoneTheme.space2 : boxHeight + gap),
                                     width: pagerSize.width, height: pagerSize.height))
            }
        }
        let placement: PhoneLayout.Pages
        switch pages {
        case .typing, .panelTyping:
            // Keep the keyboard-aware page placement, even when the panel is folded.
            placement = pages
        default:
            if panelsFolded {
                let hidden = CGRect(origin: bounds.origin, size: .zero)
                place(.panel, hidden)
                place(.divider, hidden)
                placement = .column
            } else {
                placement = pages
            }
        }
        switch placement {
        case .column:
            column(bounds, keepingStageMinimum: true)
        case .beside(let sidebar) where composerUnderPanel:
            let foot = composerHeight(bounds.minX, sidebar)
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY, width: sidebar, height: max(0, bounds.height - foot)))
            place(.composer, CGRect(x: bounds.minX, y: bounds.maxY - foot, width: sidebar, height: foot))
            place(.divider, CGRect(x: bounds.minX + sidebar, y: bounds.minY, width: 1, height: bounds.height))
            place(.stage, CGRect(x: bounds.minX + sidebar + 1, y: bounds.minY, width: max(0, bounds.width - sidebar - 1),
                                 height: bounds.height))
        case .beside(let sidebar):
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY, width: sidebar, height: bounds.height))
            place(.divider, CGRect(x: bounds.minX + sidebar, y: bounds.minY, width: 1, height: bounds.height))
            column(CGRect(x: bounds.minX + sidebar + 1, y: bounds.minY, width: max(0, bounds.width - sidebar - 1),
                          height: bounds.height), keepingStageMinimum: true)
        case .panelAbove(let fold):
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: fold.minY))
            column(CGRect(x: bounds.minX, y: bounds.minY + fold.maxY, width: bounds.width, height: max(0, bounds.height - fold.maxY)))
        case .panelBelow(let fold):
            let foot = composerHeight(bounds.minX, bounds.width)
            place(.stage, CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: fold.minY))
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY + fold.maxY, width: bounds.width,
                                 height: max(0, bounds.height - fold.maxY - foot)))
            place(.composer, CGRect(x: bounds.minX, y: bounds.maxY - foot, width: bounds.width, height: foot))
        case .typing(let fold):
            // The panel waits at no height, clipped, so none of it shows between the fold and the keyboard.
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY + fold.maxY, width: bounds.width, height: 0))
            // The message box rides over the keyboard and grows upward as its draft does, so it never jumps mid-draft;
            // the card keeps the page above the fold and ends where the box begins once a tall draft reaches it, as when
            // a keyboard filling the flat half (half folded) puts the box under the card's pager.
            let foot = composerHeight(bounds.minX, bounds.width)
            let top = bounds.maxY - foot
            place(.stage, CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width,
                                 height: max(0, min(fold.minY, top - bounds.minY))))
            place(.composer, CGRect(x: bounds.minX, y: top, width: bounds.width, height: foot))
        case .panelTyping(let fold):
            // No taller than the room above the keyboard and its bar, so the panel scrolls rather than hide under them.
            place(.panel, CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: min(fold.minY, bounds.height)))
            // Home waits under the keyboard at the page's own size, so the card keeps its shape for when it comes back;
            // the workspace hides it there (`PhoneLayout.Pages.homeWaits`).
            let page = CGRect(x: bounds.minX, y: bounds.minY + fold.maxY, width: bounds.width, height: fold.minY)
            column(page)
        }
        // Maximized, the card's stage takes Home's whole room, from under the bar to above the keyboard when one is up;
        // the other parts stay mounted and hidden.
        if maximized { place(.stage, bounds, maximizing: true) }
    }
}

extension View {
    /// INF-1208's direction C: reads Home's size and the window's division regions in Home's space, the keyboard left
    /// out so typing never moves the fold, from iOS 27.1; before it there is no fold to read.
    func phoneReadsRoom(_ room: Binding<PhoneLayout.Room>) -> some View {
        background {
            GeometryReader { geometry in
                if #available(iOS 27.1, *) {
                    let found = PhoneLayout.Room(
                        size: geometry.size,
                        folds: geometry.reservedRegions(kind: .division, options: .includeInactive).map(\.frame),
                        active: geometry.reservedRegions(kind: .division).map(\.frame))
                    Color.clear.onChange(of: found, initial: true) { _, found in room.wrappedValue = found }
                } else {
                    Color.clear.onChange(of: geometry.size, initial: true) { _, size in room.wrappedValue = .init(size: size) }
                }
            }.ignoresSafeArea(.keyboard)
        }
    }
}

/// INF-1208's direction C: the one-row bar wherever it fits. From iOS 27.1 a foldable puts the bar's symbol buttons and the
/// status bar in a rail on one side, which took 84 points from both of the Duo's displays; this view controller, in the
/// window's own content, asks for the horizontal bar instead, so Settings, the strip and the computer stay in one row
/// above the content as on every other iPhone. Elsewhere there is no vertical bar and nothing changes.
struct PhoneOneRowBar: UIViewControllerRepresentable {
    let oneRow: Bool
    func makeUIViewController(context: Context) -> Holder { Holder() }
    func updateUIViewController(_ holder: Holder, context: Context) { holder.oneRow = oneRow }

    final class Holder: UIViewController {
        var oneRow = true {
            didSet { if oneRow != oldValue, #available(iOS 27.1, *) { setNeedsUpdateOfVerticalBarConfiguration() } }
        }
        @available(iOS 27.1, *)
        override var preferredVerticalBarBehavior: UIVerticalBarBehavior { oneRow ? .disabled : .automatic }
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            if #available(iOS 27.1, *) { setNeedsUpdateOfVerticalBarConfiguration() }
        }
    }
}

extension View {
    /// INF-1208's direction C: asks the view controller that shows this view, a tab or a sheet, for the one-row bar.
    func phoneOneRowBar() -> some View { modifier(PhoneOneRowBarAsk()) }
}

/// Where the one-row bar fits. A window narrow and tall, as on a foldable's closed screen held upright, puts the status bar
/// in the bar's row, which leaves no room for Settings, the strip and the computer, so the system's own bar stays there.
/// Every iPhone held upright is that shape too and has no vertical bar, so nothing changes for it.
private struct PhoneOneRowBarAsk: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontal
    @Environment(\.verticalSizeClass) private var vertical
    func body(content: Content) -> some View {
        content.background {
            PhoneOneRowBar(oneRow: !(horizontal == .compact && vertical == .regular))
                .frame(width: 0, height: 0).accessibilityHidden(true)
        }
    }
}

extension View {
    /// INF-1208's direction C: a panel's own text field tells Home while it holds focus on a foldable's pages, so the
    /// pages swap while the keyboard is up (`PhoneLayout.Pages.panelTyping`).
    func phonePanelField(_ focused: Bool) -> some View { modifier(PhonePanelField(focused: focused)) }
}

extension View {
    /// Hidden, unpressable, unread and its keys at rest while it waits under the keyboard, kept in place so its draft
    /// and card stay. It goes on an accessibility element: on a plain container SwiftUI hands the hiding to each part
    /// inside, where not hidden overrules a part's own hiding, as a card's beside the shown one (`PhoneCardRowPlace`).
    func phoneWaits(_ waits: Bool) -> some View {
        opacity(waits ? 0 : 1).allowsHitTesting(!waits).accessibilityHidden(waits).disabled(waits)
    }
}

private struct PhonePanelField: ViewModifier {
    let focused: Bool
    @Environment(PhoneMessageContext.self) private var messageContext
    @Environment(\.phoneRecordInPlace) private var inPlace
    func body(content: Content) -> some View {
        content
            .onChange(of: focused && inPlace, initial: true) { was, now in
                if now { messageContext.panelFieldFocused = true } else if was { messageContext.panelFieldFocused = false }
            }
            .onDisappear { if focused && inPlace { messageContext.panelFieldFocused = false } }
    }
}

extension EnvironmentValues {
    /// INF-1208's direction C: Tasks opens a record in its own place, with a way back, instead of a sheet: the panel's
    /// page on an open iPhone Duo.
    @Entry var phoneRecordInPlace = false
}

/// INF-1208's direction C: the way back from a record shown in the panel's place, named for the list it returns to, with
/// the sheet's name for leaving a record and Command-[ for its key.
struct PhoneRecordBackButton: View {
    let back: () -> Void
    var body: some View {
        Button(action: back) {
            Label(PhoneMessages.phoneTabTasks(), systemImage: "chevron.left").font(PhoneFont.callout)
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(PhoneTheme.accent)
            // The card beside it keeps Shift-Command-M for its minus, so the way back takes Settings' own Back key.
            .keyboardShortcut("[", modifiers: .command)
            .accessibilityHint(PhoneCardWords.recordLeaveRest)
            .accessibilityIdentifier("close-record")
    }
}
