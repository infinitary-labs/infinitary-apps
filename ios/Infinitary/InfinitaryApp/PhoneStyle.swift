import SwiftUI

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
