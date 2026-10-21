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
/// Floating at the foot it is native glass on iOS 26; elsewhere it is the app's field fill and hairline.
private struct PhoneInputSurface: ViewModifier {
    let floating: Bool
    private let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            if floating { content.glassEffect(.regular, in: shape) } else { plain(content) }
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
    func phoneTitle(_ title: String) -> some View {
        navigationTitle(title).navigationBarTitleDisplayMode(.inline).toolbar {
            ToolbarItem(placement: .principal) { Text(title).font(PhoneFont.headline).accessibilityAddTraits(.isHeader) }
        }
    }

    /// A sheet on the panel color with a hairline at its edge, as the Mac draws an aside.
    func phoneSheetSurface() -> some View {
        presentationBackground {
            PhoneTheme.panel.overlay { ContainerRelativeShape().strokeBorder(PhoneTheme.line) }
        }
    }
}
