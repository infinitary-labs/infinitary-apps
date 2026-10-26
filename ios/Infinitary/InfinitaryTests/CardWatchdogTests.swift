import XCTest
@testable import Infinitary

/// INF-1338: the card watchdog counts only once a card's body can answer, so a body still loading on a busy device stays.
/// The readings are the iPad cards journey's late picture card, which this watchdog closed as stopped responding before the fix.
final class CardWatchdogTests: XCTestCase {
    /// Its page took 19 seconds to commit, its web process then ran nothing for 3 seconds, and its body frame loaded
    /// 4 seconds after the page; the look at 22:55:09.33 closed the card because both pings had gone to a body not yet there.
    func testABodyStillLoadingOnABusyIPadIsNeverStalled() {
        var watch = CardWatchdog()
        // 22:54:43.6 to 22:55:04.5: WebKit starts the card's process and loads its page.
        for _ in 0..<10 { XCTAssertEqual(watch.look(shown: false), .wait) }
        XCTAssertEqual(watch.look(shown: true), .ping(1))  // 04.61, the first look after the page finished
        XCTAssertEqual(watch.look(shown: true), .ping(2))  // 06.66, the web process has run nothing since 04.5
        watch.pageAnswered(1); watch.pageAnswered(2)       // 07.55, the page runs both pings
        watch.bodyReady()                                  // 08.64 to 08.67, the body frame commits and loads
        XCTAssertEqual(watch.look(shown: true), .ping(3))  // 09.33, the look that closed the card before the fix
        watch.bodyAnswered(3)
        XCTAssertEqual(watch.look(shown: true), .ping(4))
    }

    /// A body whose script loops as it loads, as the cards fixture's "Stall the card" does on a press, stops its page answering
    /// too, so the card still offers Retry (docs/ios.md: the native watchdog removes a body that stops answering).
    func testAPageThatStopsAnsweringBeforeItsBodyIsReadyIsStalled() {
        var watch = CardWatchdog()
        XCTAssertEqual(watch.look(shown: true), .ping(1))
        watch.pageAnswered(1)
        // The body frame starts loading and its script never returns: neither the page nor the body answers again.
        XCTAssertEqual(watch.look(shown: true), .ping(2))
        XCTAssertEqual(watch.look(shown: true), .ping(3))
        XCTAssertEqual(watch.look(shown: true), .ping(4))
        XCTAssertEqual(watch.look(shown: true), .stalled)
    }
}
