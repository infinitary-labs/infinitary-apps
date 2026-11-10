import XCTest
@testable import Infinitary

/// INF-3460, the captain's plan for the card row's release ("the transition feels sudden"): the row carries on from the
/// finger's speed on a spring with no bounce that settles over the page time, and never passes its target, since the
/// design forbids a bounce. The places are an iPhone 16's: a 361-point card, one step of 369 points with its gap.
final class PhoneCardRowGlideTests: XCTestCase {
    private let step: CGFloat = 369

    /// Every lift speed from 0 to 5,000 points a second, toward the next card or back, from a release at the slide-on
    /// point, from one just past the decide distance (a flick) and from a long drag, never moves the row past where it stops.
    func testTheGlideNeverPassesItsTarget() {
        for moved: CGFloat in [-12, -127, -250] {
            for aim in [-step, 0] {
                for speed in stride(from: CGFloat(0), through: 5000, by: 50) {
                    for sign: CGFloat in [-1, 1] {
                        let glide = PhoneCardRowGlide(from: moved, to: aim, speed: sign * speed, lean: -3)
                        var time = 0.0
                        while !glide.done(at: time) && time < 2 {
                            time += 1.0 / 120
                            let place = glide.place(at: time)
                            XCTAssertTrue(aim < moved ? place >= aim - 0.001 : place <= aim + 0.001,
                                          "From \(moved) to \(aim) at \(sign * speed) points a second, the row stood at \(place) after \(time) s")
                            XCTAssertLessThanOrEqual(glide.leaning(at: time), 0.000_001, "The lean passed upright")
                        }
                        XCTAssertTrue(glide.done(at: time), "From \(moved) to \(aim) at \(sign * speed) the glide never rested")
                    }
                }
            }
        }
    }

    /// A release the frame log measured on the simulator: let go 127 points across at 384 points a second toward the next
    /// card. The row carries on at the finger's speed from the lift, rather than standing still or jumping ahead, and
    /// comes most of the way within the page time.
    func testTheGlideStartsAtTheFingersSpeed() {
        let glide = PhoneCardRowGlide(from: -127, to: -step, speed: -384, lean: -2.9)
        let instant = 0.0001
        let speed = (glide.place(at: instant) - glide.place(at: 0)) / CGFloat(instant)
        XCTAssertEqual(speed, -384, accuracy: 30, "The row left the finger at \(speed) points a second")
        XCTAssertEqual(glide.place(at: 0), -127)
        XCTAssertGreaterThan(glide.share(at: PhoneCardRowMotion.settle), 0.9)
    }

    /// A release a short way from where the row stops, faster than the spring can start without passing it, starts at the
    /// fastest that cannot: a drag let go 12 points across that turned back at 950 points a second glides back with no bounce.
    func testAFastReleaseNearItsTargetStartsNoFasterThanTheSpringAllows() {
        let glide = PhoneCardRowGlide(from: -12, to: 0, speed: 950, lean: -0.3)
        XCTAssertEqual(glide.start, glide.rate)
        XCTAssertLessThan(glide.start * 12, 950)
    }
}
