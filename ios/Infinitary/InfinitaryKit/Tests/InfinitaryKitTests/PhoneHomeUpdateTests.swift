import Foundation
import Testing
@testable import InfinitaryKit

/// INF-4012's direction 1, the captain's "1 and 2 together": the phone sees the computer's own update and presses
/// Update or Update later, even while it only reads across a version split.
struct PhoneHomeUpdateTests {
    private let offered = PhoneHomeUpdate(version: "0.7.2-alpha.585", offered: "0.7.2-alpha.590", step: "offered",
                                          stops: .init(tasks: ["Fix the footer", "Plan the release"], jobs: 1))

    /// The computer's answer, as `src/shared/homeUpdate.ts` shapes it, decodes whole.
    @Test func readsTheComputersAnswer() throws {
        let json = #"{"version":"0.7.2-alpha.585","channel":"alpha","offered":"0.7.2-alpha.590","step":"offered","waitingFor":[],"stops":{"tasks":["Fix the footer","Plan the release"],"jobs":1},"problem":null}"#
        let update = try JSONDecoder().decode(PhoneHomeUpdate.self, from: Data(json.utf8))
        #expect(update == offered)
    }

    @Test func offersOnlyWhatTheComputerInstallsFromAfar() {
        #expect(offered.offersUpdate && !offered.offersLater)
        #expect(offered.line(name: "Mac mini") == "Mac mini has 0.7.2-alpha.590 ready.")
        let elsewhere = PhoneHomeUpdate(version: "0.7.2-alpha.585", offered: nil, step: "elsewhere",
                                        problem: "This copy is updated at the computer itself, not from afar.")
        #expect(!elsewhere.offersUpdate)
        #expect(elsewhere.line(name: "Mac mini") == elsewhere.problem)
        let saving = PhoneHomeUpdate(version: "0.7.2-alpha.585", offered: "0.7.2-alpha.590", step: "saving",
                                     waitingFor: ["Fix the footer"])
        #expect(saving.offersLater && !saving.offersUpdate && saving.aboutToRestart && saving.underWay)
        #expect(saving.line(name: "Mac mini")
            == "Saving work on Mac mini. Waiting for Fix the footer to finish what is running.")
    }

    @Test func confirmsAgainstTheWorkItStops() {
        #expect(offered.confirmLines(name: "Mac mini") == [
            "Running work finishes first, then carries on after the restart: Fix the footer and Plan the release.",
            "Background jobs that stop at the restart: 1.",
            "If the new version does not start, someone needs to be at Mac mini. It cannot be undone from here.",
        ])
    }

    /// A step this phone does not know shows the version alone and offers nothing.
    @Test func showsTheVersionForAStepItDoesNotKnow() {
        let later = PhoneHomeUpdate(version: "0.7.2-alpha.585", offered: "0.7.2-alpha.590", step: "verifying")
        #expect(later.line(name: "Mac mini") == nil && later.status(name: "Mac mini") == "0.7.2-alpha.585")
        #expect(!later.offersUpdate && !later.underWay)
        let current = PhoneHomeUpdate(version: "0.7.2-alpha.585", offered: nil, step: "current")
        #expect(current.status(name: "Mac mini") == "0.7.2-alpha.585, up to date.")
    }

    /// The computer answers by the change's name, or by the major that folds it in.
    @Test func knowsWhichComputersAnswer() {
        #expect(PhoneHomeUpdate.supported(homeVersion: "15.2.0", changes: [PhoneContract.homeUpdate]))
        #expect(!PhoneHomeUpdate.supported(homeVersion: "15.2.0", changes: []))
        #expect(PhoneHomeUpdate.supported(homeVersion: "\(PhoneContract.homeUpdateFolded).0.0", changes: []))
        #expect(!PhoneHomeUpdate.supported(homeVersion: nil, changes: []))
    }

    /// Update and Update later, with no arguments, are the changes a reading-only phone sends beside plain words.
    @MainActor @Test func sendsTheUpdateAsksWhileReading() {
        #expect(ReadOnlySession.homeUpdateAsk("inf:home-update:install", []))
        #expect(ReadOnlySession.homeUpdateAsk("inf:home-update:later", []))
        #expect(!ReadOnlySession.homeUpdateAsk("inf:home-update:install", ["0.7.2-alpha.590"]))
        #expect(!ReadOnlySession.homeUpdateAsk("inf:update:install", []))
    }
}
