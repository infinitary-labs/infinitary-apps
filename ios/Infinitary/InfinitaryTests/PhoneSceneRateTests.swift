import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-3851, the captain's plan for a phone that grew hot with the app open ("can we investigate what's making my phone
/// hot and how we can optimize?"): the scene keeps the screen's full rate as before ("keeping 120 fps at rest
/// untouched", "leaving fps untouched"), and asks for 30 while Low Power Mode is on ("30 in low energy mode makes sense").
@MainActor final class PhoneSceneRateTests: XCTestCase {
    func testTheSceneKeepsTheScreensFullRateUpTo120() {
        XCTAssertEqual(PhoneSceneRate.rate(lowPower: false, screen: 120), 120)
        // A 60-a-second screen keeps its own top rate, and a faster one is held to 120 as before.
        XCTAssertEqual(PhoneSceneRate.rate(lowPower: false, screen: 60), 60)
        XCTAssertEqual(PhoneSceneRate.rate(lowPower: false, screen: 240), 120)
        let range = PhoneSceneRate.range(lowPower: false, screen: 120)
        XCTAssertEqual(range.maximum, 120); XCTAssertEqual(range.preferred, 120)
        XCTAssertGreaterThan(range.minimum, 0, "Core Animation refuses a zero minimum")
    }

    func testLowPowerModeAsksForThirty() {
        for screen in [60, 120] {
            XCTAssertEqual(PhoneSceneRate.rate(lowPower: true, screen: screen), 30, "\(screen)-a-second screen")
        }
        let range = PhoneSceneRate.range(lowPower: true, screen: 120)
        XCTAssertEqual(range.maximum, 30); XCTAssertEqual(range.preferred, 30)
        XCTAssertGreaterThan(range.minimum, 0, "Core Animation refuses a zero minimum")
    }
}
