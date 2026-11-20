import SwiftUI
import UIKit

/// The captain's Approve and build (INF-4713, direction A): a card's and a panel's words follow the device's Text Size,
/// as Infinitary's own words already do (docs/ios.md, "Text size"). Their pages draw every Mac size times one factor,
/// the device's body size over the Mac's card body, so a card's body reads at the phone's own 17 points at iOS's default.
/// It grows to iOS's largest standard size and holds there at the accessibility sizes.
enum PhoneTextSize {
    /// The Mac's card body in points, which a card's and a panel's whole type scale is drawn against.
    static let macBody: CGFloat = 14

    /// The factor a card or panel draws at under `category`: the body's size there, held at the largest standard size.
    static func scale(for category: UIContentSizeCategory) -> Double {
        let held: UIContentSizeCategory = category.isAccessibilityCategory ? .extraExtraExtraLarge : category
        let traits = UITraitCollection(preferredContentSizeCategory: held)
        return Double(UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize / macBody)
    }

    static func scale(for size: DynamicTypeSize) -> Double { scale(for: UIContentSizeCategory(size)) }
}
