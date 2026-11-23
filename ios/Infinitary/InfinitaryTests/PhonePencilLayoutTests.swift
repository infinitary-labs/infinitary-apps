import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// The captain's Approve and build on comfortable Apple Pencil input: with a Pencil in hand the message box stands at
/// the top of Home's column, upright and beside an iPad's sidebar, and the stage takes the room under it; a window with a
/// fold and the switch turned off keep the box at the foot. The frames come from the shipped layout drawn in a window.
@MainActor final class PhonePencilLayoutTests: XCTestCase {
    /// Where the layout put the stage and the message box, in the window.
    @MainActor @Observable final class Frames {
        var stage = CGRect.zero
        var composer = CGRect.zero
    }

    /// A 160-point message box, the height a four-line box and its last turn take, beside a stage that fills its room.
    private func drawn(_ pages: PhoneLayout.Pages, top: Bool, size: CGSize) async throws -> Frames {
        let frames = Frames()
        let view = PhonePagesLayout(pages: pages, composerOnTop: top) {
            if case .beside = pages {
                Color.gray.layoutValue(key: PhonePagesRole.self, value: .panel)
                Color.black.layoutValue(key: PhonePagesRole.self, value: .divider)
            }
            Color.clear
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frames.stage = $0 }
                .layoutValue(key: PhonePagesRole.self, value: .stage)
            Color.clear.frame(height: 160)
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frames.composer = $0 }
                .layoutValue(key: PhonePagesRole.self, value: .composer)
        }.frame(width: size.width, height: size.height).ignoresSafeArea()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        var deadline = PhoneWaitDeadline(10)
        while frames.composer.isEmpty || frames.stage.isEmpty {
            if deadline.expired() { throw PhoneError.refused("The layout never placed the stage and the message box.") }
            try await Task.sleep(for: .seconds(PhoneWaitDeadline.tick))
        }
        return frames
    }

    func testPencilPutsTheMessageBoxAtTheTopOfHomesColumn() async throws {
        // An 11-inch iPad's Home upright, and the column beside the 320-point sidebar on its side.
        for (pages, size) in [(PhoneLayout.Pages.column, CGSize(width: 820, height: 1100)),
                              (.beside(320), CGSize(width: 1180, height: 740))] {
            let foot = try await drawn(pages, top: false, size: size)
            XCTAssertEqual(foot.composer.maxY, size.height, accuracy: 0.5, "\(pages): the box stands at the foot")
            XCTAssertEqual(foot.stage.minY, 0, accuracy: 0.5)
            let top = try await drawn(pages, top: true, size: size)
            XCTAssertEqual(top.composer.minY, 0, accuracy: 0.5, "\(pages): the box stands under the bar")
            XCTAssertEqual(top.composer.height, 160, accuracy: 0.5)
            XCTAssertEqual(top.stage.minY, top.composer.maxY, accuracy: 0.5, "\(pages): the stage starts under the box")
            XCTAssertEqual(top.stage.maxY, size.height, accuracy: 0.5, "\(pages): the stage reaches the foot")
            XCTAssertEqual(top.stage.height, foot.stage.height, accuracy: 0.5, "\(pages): the stage keeps its height")
            XCTAssertEqual(top.composer.minX, foot.composer.minX, accuracy: 0.5)
        }
    }

    /// The Pencil moves the box only with the switch on, in Home's column or beside an iPad's sidebar; a Duo's fold, its
    /// pages and the box under its sidebar keep today's placement.
    func testOnlyAnIPadsColumnWithThePencilAndTheSwitchOnMovesTheBox() {
        let fold = CGRect(x: 455, y: 0, width: 40, height: 669)
        XCTAssertTrue(PhoneLayout.composerOnTop(.column, pencil: true, chosen: true, folds: [], composerUnderPanel: false))
        XCTAssertTrue(PhoneLayout.composerOnTop(.beside(320), pencil: true, chosen: true, folds: [], composerUnderPanel: false))
        XCTAssertFalse(PhoneLayout.composerOnTop(.column, pencil: false, chosen: true, folds: [], composerUnderPanel: false))
        XCTAssertFalse(PhoneLayout.composerOnTop(.column, pencil: true, chosen: false, folds: [], composerUnderPanel: false))
        XCTAssertFalse(PhoneLayout.composerOnTop(.column, pencil: true, chosen: true, folds: [fold], composerUnderPanel: false))
        XCTAssertFalse(PhoneLayout.composerOnTop(.beside(455), pencil: true, chosen: true, folds: [], composerUnderPanel: true))
        XCTAssertFalse(PhoneLayout.composerOnTop(.panelAbove(fold), pencil: true, chosen: true, folds: [], composerUnderPanel: false))
    }
}
