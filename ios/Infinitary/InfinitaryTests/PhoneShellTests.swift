import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-209: native three-state drawing, and the Mac-authored Activity key/age presentation.
/// Uses the disposable test home and simulator; no account, camera or signing operation.
@MainActor final class PhoneShellTests: XCTestCase {
    func testNativeCharacterHasThreeDistinctReducedMotionPoses() throws {
        var drawings = Set<Data>()
        for state in PhoneCharacter.State.allCases {
            for theme in [ColorScheme.light, .dark] {
                let renderer = ImageRenderer(content: PhoneCharacter(state: state).drawing(at: 0)
                    .frame(width: 240, height: 240).padding(24).background(PhoneTheme.background)
                    .environment(\.colorScheme, theme))
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                drawings.insert(try XCTUnwrap(image.pngData()))
                let picture = XCTAttachment(image: image)
                picture.name = "native-character-\(state.rawValue)-\(theme == .dark ? "dark" : "light")"
                picture.lifetime = .keepAlways; add(picture)
            }
        }
        XCTAssertEqual(drawings.count, PhoneCharacter.State.allCases.count * 2,
                       "Idle, listening and working must draw differently in each appearance")
    }

    /// INF-499 #3: only the shown card, past card or open task supplies the message hint.
    func testMessageContextFollowsTheShownEntry() {
        let context = PhoneMessageContext()
        context.card = .current("card-fm-phone-choice")
        XCTAssertEqual(context.fields, ["visibleCardId": "card-fm-phone-choice"])
        context.cardsVisible = false
        XCTAssertEqual(context.fields, [:], "An Activity or Tasks tab does not point at a hidden card")
        context.taskID = "phone-work"
        XCTAssertEqual(context.fields, ["taskId": "phone-work"])
        context.taskID = nil
        XCTAssertEqual(context.fields, [:], "Closing the task record clears its hint")
        context.cardsVisible = true
        context.card = .past("card-fm-phone-conversation")
        XCTAssertEqual(context.fields, ["pastCardId": "card-fm-phone-conversation"])
        context.card = nil
        XCTAssertEqual(context.fields, [:])
    }

    func testActivityUsesTheHomesReadings() async throws {
        let control = try XCTUnwrap(ProcessInfo.processInfo.environment["PHONE_TEST_HOME"])
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: control + "/state")))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let bytes = try JSONSerialization.data(withJSONObject: XCTUnwrap(state["feed"]))
        let lines = try JSONDecoder().decode([ActivityLine].self, from: bytes)
        let line = try XCTUnwrap(lines.last)
        let at = Date(timeIntervalSince1970: line.at / 1000)
        XCTAssertEqual(PhoneActivity.age(line.at, now: at), "now")
        XCTAssertEqual(PhoneActivity.age(line.at, now: at.addingTimeInterval(120)), "2m")
        XCTAssertEqual(PhoneActivity.age(line.at, now: at.addingTimeInterval(7200)), "2h")
        XCTAssertEqual(PhoneActivity.age(line.at, now: at.addingTimeInterval(172800)), "2d")
    }
}
