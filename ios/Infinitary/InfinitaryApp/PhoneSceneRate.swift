import Foundation
import QuartzCore

/// INF-3851's rate rule, from the captain's plan for a phone that grew hot with the app open: the crew scene keeps the
/// screen's full rate, up to 120 frames a second, as before ("leaving fps untouched"), and asks for 30 while Low Power
/// Mode is on ("30 in low energy mode makes sense"). iOS still chooses the delivered cadence within the range.
enum PhoneSceneRate {
    /// The top rate the scene asks for, which the screen may lower.
    static let full: Float = 120
    /// The captain's pick for Low Power Mode: about half the work of 60.
    static let saving: Float = 30

    /// The rate the scene asks for on a screen that shows at most `screen` frames a second, with Low Power Mode on or off.
    static func rate(lowPower: Bool, screen: Int) -> Float {
        min(lowPower ? saving : full, Float(max(1, screen)))
    }

    /// The display link's range for that rate. Core Animation requires a positive minimum for a nondefault range.
    static func range(lowPower: Bool, screen: Int) -> CAFrameRateRange {
        let rate = rate(lowPower: lowPower, screen: screen)
        return CAFrameRateRange(minimum: 1, maximum: rate, preferred: rate)
    }
}
