import SwiftUI

/// Native Dynamic Type roles, using the design skill's vendored typefaces.
enum PhoneFont {
    static let body = Font.custom("SpaceGrotesk-Light", size: 17, relativeTo: .body).weight(.regular)
    static let title = Font.custom("SpaceGrotesk-Light", size: 22, relativeTo: .title2).weight(.semibold)
    static let headline = Font.custom("SpaceGrotesk-Light", size: 17, relativeTo: .headline).weight(.semibold)
    static let callout = Font.custom("SpaceGrotesk-Light", size: 16, relativeTo: .callout).weight(.regular)
    static let caption = Font.custom("SpaceGrotesk-Light", size: 12, relativeTo: .caption).weight(.regular)
}
