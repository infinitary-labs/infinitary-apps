import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// The crew summary's footer is one row that never wraps (INF-2528). A branch name longer than the row made the whole
/// summary wider than its sheet or its long press's preview, which then cut off both of its sides. The model's name now
/// gives way first, no narrower than its label, then the branch ends in an ellipsis, as the Mac's preview does.
/// Hosts the shipped summary for a joined computer that has not answered, so it draws the board row it was given.
@MainActor final class PhoneSummaryFooterTests: XCTestCase {
    /// A branch name of the crew's own shape, longer than the row.
    static let branch = "inf/continue-key-reminder-for-controls-inside-a-030e"

    /// The task as the board row carries it: its branch, its model and its checks running for 3h 02m.
    private func task() throws -> PhoneTask {
        let now = Date().timeIntervalSince1970 * 1000
        let row: [String: Any] = [
            "id": "t-4608", "key": "INF-4608", "projectId": "p-inf", "parentId": NSNull(), "kind": "work",
            "title": "Continue: Key reminder for controls inside a panel's page", "status": "active", "activity": "running",
            "workPosture": ["state": "active", "reason": "turn"], "createdAt": now - 4 * 3_600_000, "blockedBy": [],
            "model": "anthropic/claude-opus-5-5", "modelLabel": "Claude Opus 5.5", "tier": "high",
            "delivery": ["mode": "queue-pr", "changeLabel": Self.branch, "headSha": "c0ffee1", "ci": "pending",
                         "ciAt": now - 60_000, "ciStartedAt": now - (3 * 60 + 2) * 60_000],
        ]
        return try JSONDecoder().decode(PhoneTask.self, from: JSONSerialization.data(withJSONObject: row))
    }

    func testALongBranchKeepsTheSummaryInsideItsWidth() throws {
        let session = ReadOnlySession(mac: JoinedMac(addresses: [], pin: "footer", deviceID: "footer", name: "Mac"),
                                      phone: try PhoneIdentity.loadOrCreate())
        let shown = try task()
        let footer = try XCTUnwrap(PhoneTaskFacts(shown, modelName: { _ in shown.modelLabel ?? "" }).delivery?.change)
        XCTAssertEqual(footer.label, Self.branch, "The task reaches the footer with its branch")
        // A long press's preview at its widest, the narrowest the summary is drawn on an iPhone or an iPad, as the
        // Tasks list hosts it.
        let width = PhoneCrewSummary.hoverWidth
        let host = UIHostingController(rootView: PhoneCrewSummary(session: session, task: shown, tasks: [shown], preview: true)
            .font(PhoneFont.body))
        let drawn = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        let pixel = 1 / max(1, host.traitCollection.displayScale)
        XCTAssertLessThanOrEqual(drawn.width, width + pixel, "The summary is drawn \(drawn.width) points wide in a \(width)-point preview")
    }
}
