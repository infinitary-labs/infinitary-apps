import SwiftUI
import XCTest
@testable import Infinitary

/// The captain's Approve and build on INF-4713 ("can you add font size options for the iOS app too? I feel old squinting
/// at some of the text"): a card's body reads at the phone's own 17 points at iOS's default Text Size, grows to 23 at the
/// largest standard size and holds there at the accessibility sizes; at the smallest it matches the Mac's 14.
final class PhoneTextSizeTests: XCTestCase {
    /// The card body a factor draws, in points.
    private func body(_ category: UIContentSizeCategory) -> Double { PhoneTextSize.scale(for: category) * Double(PhoneTextSize.macBody) }

    func testCardBodyFollowsTextSizeUpToTheLargestStandardSize() {
        XCTAssertEqual(body(.extraSmall), 14, accuracy: 0.01, "The smallest Text Size draws the Mac's own sizes")
        XCTAssertEqual(body(.large), 17, accuracy: 0.01, "iOS's default Text Size draws the phone's own body size")
        XCTAssertEqual(body(.extraExtraExtraLarge), 23, accuracy: 0.01, "The largest standard Text Size")
        let steps: [UIContentSizeCategory] = [.extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge]
        let sizes = steps.map(body)
        XCTAssertEqual(sizes, sizes.sorted(), "Each larger Text Size draws no smaller")
    }

    func testAccessibilitySizesHoldAtTheLargestStandardSize() {
        for category: UIContentSizeCategory in [.accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
                                                .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
            XCTAssertEqual(body(category), 23, accuracy: 0.01, "\(category.rawValue) holds at the largest standard size")
        }
        XCTAssertEqual(PhoneTextSize.scale(for: DynamicTypeSize.accessibility5), PhoneTextSize.scale(for: .extraExtraExtraLarge))
    }
}
