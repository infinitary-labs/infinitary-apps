import SwiftUI

/// INF-589 item 15: one reading column, centred, holds the card, its pager, the message box, Tasks and Activity on any width.
enum PhoneColumn {
    /// The column with its gutters: the card stage's own 560 points.
    static let width: CGFloat = 560
    /// What fills the column inside its gutters: the card itself, and the message box and notice that line up with it.
    static let inside: CGFloat = width - 2 * PhoneTheme.space4
}

/// INF-589 item 17: an iPhone on its side gives the card the height, so the shell keeps only what reading it needs.
/// Native compact height identifies it, not a keyboard shrinking the window.
@MainActor func phoneOnItsSide(_ vertical: UserInterfaceSizeClass?) -> Bool {
    UIDevice.current.userInterfaceIdiom == .phone && vertical == .compact
}

/// INF-1208's direction A: the layout follows the room the window has, never the kind of device. iPhone Duo is a phone
/// to the code in every pose, yet open it has the room of a small iPad.
enum PhoneLayout {
    /// The Mac's cardPlacement rule in points: regular and unspecified cards yield to a docked stage down to 560;
    /// a card that explicitly asks to be wider gets at least 720. Both leave the normal stage gutters.
    static func cardNeedsPanelRoom(width: String?, stage: CGFloat) -> Bool {
        stage - 2 * PhoneTheme.space4 < (width == "wide" || width == "full" ? 720 : PhoneColumn.width)
    }

    /// The flat book layout uses the card's own reading width. A full-width card takes the room.
    static func readingWidth(_ width: String?) -> CGFloat? {
        switch width {
        case "regular": PhoneColumn.width
        case "full": nil
        default: 800
        }
    }

    /// The sidebar stands beside the stage wherever the window is regular both ways and wider than tall: an iPad on its
    /// side, as before, and an open Duo like a book. A large iPhone on its side is compact in height and keeps the strip.
    static func wide(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?, size: CGSize) -> Bool {
        horizontal == .regular && vertical == .regular && size.width > size.height
    }

    /// What Home's column keeps clear of a fold running down it: the frames of the window's division regions in the
    /// column's own space, each with Apple's margins, and the column's width. The card and the message box take the wider
    /// side of the fold, so neither crosses it; a fold across the window, or one outside the column, moves nothing.
    /// `PhonePagesLayout` works it out from the workspace's one fold reading as it places each part, so no part reads the
    /// fold in its own frame and moves itself by it, which never settled when a frame fell on a third of a point (INF-4838).
    static func keepOff(folds: [CGRect], width: CGFloat) -> FoldInset {
        var inset = FoldInset()
        for fold in folds where fold.height > fold.width && fold.maxX > 0 && fold.minX < width {
            if width - fold.maxX >= fold.minX { inset.leading = max(inset.leading, fold.maxX) }
            else { inset.trailing = max(inset.trailing, width - fold.minX) }
        }
        return inset
    }
    struct FoldInset: Equatable { var leading: CGFloat = 0; var trailing: CGFloat = 0 }

    /// The folds the layout heeds: every one while Split at the fold is on, none while it is off, so an open Duo then
    /// lays out as an iPad does, its sidebar at the iPad's share and Home's card centred across the fold.
    static func heeded(folds: [CGRect], split: Bool) -> [CGRect] { split ? folds : [] }

    /// Whether a window's division regions hold a fold running down it, as an iPhone Duo open like a book has.
    static func foldsDown(_ folds: [CGRect]) -> Bool { folds.contains { $0.height > $0.width } }

    /// The sidebar's width in the wide layout: the iPad's share of the window, or, where a fold runs down the window past
    /// that share, the room up to the fold, so the sidebar fills the page left of it and Home the page right of it, with
    /// no strip of empty stage between the sidebar and the fold. Folds are the window's division regions in the
    /// workspace's own space, each with Apple's margins.
    static func sidebarWidth(width: CGFloat, folds: [CGRect]) -> CGFloat {
        foldPage(width: width, folds: folds) ?? min(320, width * 0.32)
    }

    /// Where the page left of a fold running down the window ends, when that fold stands past the sidebar's usual share;
    /// none on a window with no such fold. INF-1208's direction C opens a record in the panel's place on that page.
    static func foldPage(width: CGFloat, folds: [CGRect]) -> CGFloat? {
        let share = min(320, width * 0.32)
        return folds.filter { $0.height > $0.width && $0.minX > share && $0.maxX < width }.map(\.minX).min()
    }
}

/// INF-1208's direction A: whether a keyboard-will-show notice brings a keyboard on screen. When an iPhone Duo turns, or
/// its window moves between its displays, iOS posts one though no keyboard comes: its keyboard frame has no height, or,
/// once a keyboard has shown in the other pose, it carries that keyboard's frame into the turned window (INF-5183), and
/// no will-hide follows either. The Done button and the message box's keyboard flag leave such a notice alone: a
/// keyboard comes with height, and only for something that takes text. A notice with no frame is believed.
@MainActor func phoneKeyboardArrives(_ note: Notification, takesText: Bool = phoneFocusTakesText()) -> Bool {
    guard takesText else { return false }
    guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return true }
    return end.height > 0
}

/// Whether what holds the keyboard's focus in one of the app's windows takes text, as a field or a card's body does;
/// iOS brings a keyboard for nothing else, so the view that only takes the open Duo's panel keys brings none.
@MainActor func phoneFocusTakesText() -> Bool {
    UIApplication.shared.connectedScenes.contains { scene in
        (scene as? UIWindowScene)?.windows.contains { $0.phoneFocusTakesText } ?? false
    }
}

extension UIView {
    /// Whether the view in this one's subtree that holds the keyboard's focus takes text.
    var phoneFocusTakesText: Bool { phoneFirstResponder() is UIKeyInput }
}

/// INF-3468, the captain: "have a little margin between the focused textbox and the bottom edge of the card".
enum PhoneTyping {
    /// The room under a card's text box that holds the keyboard: 16 points, the same as the box's inset from the card's
    /// sides (the captain's pick).
    static let margin = PhoneTheme.space4
}

/// The app's own field, as the Mac draws its input: the panel fill, a hairline and the control radius.
struct PhoneFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, PhoneTheme.space3).padding(.vertical, PhoneTheme.space2)
            .frame(minHeight: 44)
            .background(PhoneTheme.panel, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: PhoneTheme.controlRadius).strokeBorder(PhoneTheme.line))
    }
}

extension TextFieldStyle where Self == PhoneFieldStyle {
    static var phone: PhoneFieldStyle { PhoneFieldStyle() }
}

/// The Mac's input: one shape holding its field and send arrow, a pill at one line and a rounded rectangle taller.
/// Floating at the foot it is native glass on iOS 26, its corners concentric with the screen's (INF-944 item 4);
/// elsewhere it is the app's field fill and hairline.
private struct PhoneInputSurface: ViewModifier {
    let floating: Bool
    private let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            if floating { content.glassEffect(.regular, in: ConcentricRectangle(corners: .concentric(minimum: 22), isUniform: true)) } else { plain(content) }
        } else { plain(content) }
    }
    private func plain(_ content: Content) -> some View {
        content.background(PhoneTheme.panel, in: shape).overlay { shape.strokeBorder(PhoneTheme.line) }
    }
}

extension View {
    func phoneInput(floating: Bool = false) -> some View { modifier(PhoneInputSurface(floating: floating)) }
}

extension SensoryFeedback {
    /// INF-589 item 12: the one soft tap when something is sent, a task starts or stops, or the computer comes back.
    static let phone = SensoryFeedback.impact(flexibility: .soft)
}

extension View {
    /// A sheet's title, inline in the app's own type, drawn as the joined computer's name is.
    /// INF-1208's direction C: every sheet's page with a title asks for the one-row bar from inside its navigation stack,
    /// where the bar it draws reads the ask.
    func phoneTitle(_ title: String) -> some View {
        navigationTitle(title).navigationBarTitleDisplayMode(.inline).phoneOneRowBar().toolbar {
            // A longer word in another language shrinks a little before it cuts off.
            ToolbarItem(placement: .principal) {
                Text(title).font(PhoneFont.headline).lineLimit(1).minimumScaleFactor(0.75).accessibilityAddTraits(.isHeader)
            }
        }
    }

    /// A sheet floats over the app, so on iOS 26 it is the system's glass sheet with no backdrop of its own.
    /// Earlier systems draw it on the panel color with a hairline at its edge, as the Mac draws an aside.
    func phoneSheetSurface() -> some View { modifier(PhoneSheetSurface()) }
}

private struct PhoneSheetSurface: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) { content } else {
            content.presentationBackground {
                PhoneTheme.panel.overlay { ContainerRelativeShape().strokeBorder(PhoneTheme.line) }
            }
        }
    }
}

/// INF-944 item 5, the captain's pick on INF-945: a card's choices in the Mac's row.
/// INF-1312: every button of the phone's own screens takes this shape too; none fills the width.
/// Rounded rectangles at the Mac's size, the default filled with the accent, a danger choice in a red outline,
/// the rest in a hairline outline. Each is drawn about 37 points tall inside a 44-point touch area.
struct PhoneChoiceStyle: ButtonStyle {
    /// INF-1524: `muted` is the Mac's default choice while a required question waits, drawn quiet until it is answered.
    enum Kind { case primary, secondary, danger, muted }
    let kind: Kind
    /// INF-1524: on a past card, the choice that was made keeps full contrast with an accent edge, as on the Mac.
    var chosen = false
    @Environment(\.isEnabled) private var enabled

    init(_ kind: Kind, chosen: Bool = false) { self.kind = kind; self.chosen = chosen }
    init(primary: Bool, danger: Bool = false) { kind = primary ? .primary : danger ? .danger : .secondary }

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: PhoneTheme.controlRadius, style: .continuous)
        configuration.label
            .font(PhoneFont.callout)
            .foregroundStyle(kind == .primary ? PhoneTheme.onAccent : kind == .danger ? PhoneTheme.danger : kind == .muted ? PhoneTheme.muted : PhoneTheme.text)
            .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space2)
            .frame(minHeight: PhoneChoiceRow.drawnHeight)
            .background { if kind == .primary { shape.fill(PhoneTheme.accent) } }
            .overlay {
                if chosen { shape.strokeBorder(PhoneTheme.accent, lineWidth: 1.5) }
                else if kind != .primary { shape.strokeBorder(kind == .danger ? PhoneTheme.danger : PhoneTheme.line) }
            }
            .opacity(chosen ? 1 : !enabled ? 0.5 : configuration.isPressed ? 0.7 : 1)
            .padding(.vertical, (44 - PhoneChoiceRow.drawnHeight) / 2)
            .contentShape(Rectangle())
    }
}

/// The Mac's footer row: choices keep their own width, sit at the trailing edge and wrap onto another line
/// when they do not fit, the default last. An optional leading fact (the answered count) starts the first line.
struct PhoneChoiceRow: Layout {
    /// The Mac's button height; the touch area around it stays 44 points.
    static let drawnHeight: CGFloat = 37
    /// Subviews marked with this key start the first line at the leading edge.
    struct Leading: LayoutValueKey { static let defaultValue = false }
    private let gap = PhoneTheme.space2
    /// Each choice carries its own vertical touch padding, so lines sit closer to keep the Mac's drawn gap.
    private var lineGap: CGFloat { max(0, gap - (44 - Self.drawnHeight)) }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = proposal.width ?? lines.map(\.width).max() ?? 0
        return CGSize(width: width, height: lines.reduce(0) { $0 + $1.height } + lineGap * CGFloat(max(0, lines.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.maxX - line.trailingWidth
            for index in line.items {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                let leading = subviews[index][Leading.self]
                subviews[index].place(at: CGPoint(x: leading ? bounds.minX : x, y: y + (line.height - size.height) / 2),
                                      proposal: .init(width: min(size.width, bounds.width), height: size.height))
                if !leading { x += size.width + gap }
            }
            y += line.height + lineGap
        }
    }

    private struct Line { var items: [Int] = []; var width: CGFloat = 0; var trailingWidth: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let leading = subviews[index][Leading.self]
            let added = line.items.isEmpty ? min(size.width, width) : size.width + gap
            if !line.items.isEmpty && line.width + added > width {
                lines.append(line); line = Line()
            }
            let step = line.items.isEmpty ? min(size.width, width) : size.width + gap
            line.items.append(index); line.width += step
            if !leading { line.trailingWidth += line.trailingWidth == 0 ? min(size.width, width) : size.width + gap }
            line.height = max(line.height, size.height)
        }
        if !line.items.isEmpty { lines.append(line) }
        return lines
    }
}

/// INF-1312: a list of rows where a choice is a way in or a thing to pick rather than a decision.
/// The rows sit on the panel fill inside a hairline, as the Mac draws a list, with a hairline between them.
struct PhoneList<Content: View>: View {
    @ViewBuilder let content: Content
    private let shape = RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous)

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows) { row in
                    if row.id != rows.first?.id { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
                    row
                }
            }
        }
        .background(PhoneTheme.panel, in: shape).clipShape(shape)
        .overlay { shape.strokeBorder(PhoneTheme.line) }
    }
}

/// One row of a `PhoneList`: an optional symbol in the accent, the row's name, one line under it, and a chevron
/// when the row opens something. It fills the row, so the whole row is its touch area.
struct PhoneRow: View {
    var symbol: PhoneSymbol?
    let title: String
    let line: String
    var lineFont = PhoneFont.caption
    var chevron = false

    var body: some View {
        HStack(spacing: PhoneTheme.space3) {
            if let symbol { symbol.image.foregroundStyle(PhoneTheme.accent).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(PhoneFont.body).foregroundStyle(PhoneTheme.text)
                Text(line).font(lineFont).foregroundStyle(PhoneTheme.secondary)
            }.multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if chevron { PhoneSymbol.rowChevron.foregroundStyle(PhoneTheme.muted).accessibilityHidden(true) }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.vertical, PhoneTheme.space3)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }
}

/// A pressed row lights the field's surface under it, and a disabled one dims.
struct PhoneRowStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background { if configuration.isPressed { PhoneTheme.surface } }
            .opacity(enabled ? 1 : 0.5)
    }
}
