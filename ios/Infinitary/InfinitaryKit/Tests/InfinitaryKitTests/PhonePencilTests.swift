import Foundation
import Testing
@testable import InfinitaryKit

/// The captain's Approve and build on comfortable Apple Pencil input, with the off switch the captain chose: the switch
/// starts on and stays on this device, and the message box follows the plan's move rule.
struct PhonePencilTests {
    @Test func switchStartsOnAndKeepsEachChoiceAndTheSeenPencilAcrossReads() {
        let name = "phone-pencil-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(PhonePencilTop.saved(in: defaults))
        #expect(!PhonePencilTop.pencilSeen(in: defaults))
        PhonePencilTop.savePencilSeen(in: defaults)
        for top in [false, true, false] {
            PhonePencilTop.save(top, in: defaults)
            // A fresh reader of the same domain stands in for the next launch.
            let next = UserDefaults(suiteName: name)!
            #expect(PhonePencilTop.saved(in: next) == top)
            #expect(PhonePencilTop.pencilSeen(in: next))
        }
    }

    @Test func pencilMovesTheBoxUpAndAFingerFocusPutsItBack() {
        var placement = PhonePencilPlacement()
        #expect(!placement.top)
        placement.pencil()
        #expect(placement.top)
        placement.focused(by: .other)
        #expect(!placement.top)
        placement.unfocused()
        #expect(!placement.top)
    }

    @Test func nothingMovesWhileTheBoxHoldsPencilFocus() {
        var placement = PhonePencilPlacement()
        placement.pencil()
        placement.focused(by: .pencil)
        #expect(placement.top)
        placement.unfocused()
        #expect(placement.top)
    }

    @Test func aFirstPencilTouchOnTheBoxAtTheFootWaitsUntilFocusEnds() {
        var placement = PhonePencilPlacement()
        placement.pencil(onField: true)
        #expect(!placement.top)
        placement.focused(by: .pencil)
        placement.pencil(onField: true)
        #expect(!placement.top)
        placement.unfocused()
        #expect(placement.top)
    }

    @Test func aPencilTouchWhileAFingerTypesWaitsForTheKeyboardToLetGo() {
        var placement = PhonePencilPlacement()
        placement.focused(by: .other)
        placement.pencil()
        #expect(!placement.top)
        placement.unfocused()
        #expect(placement.top)
    }

    @Test func theIPadsOwnReadingStartsEitherPlace() {
        var placement = PhonePencilPlacement()
        placement.expected(true)
        #expect(placement.top)
        placement.expected(false)
        #expect(!placement.top)
        placement.focused(by: .pencil)
        placement.expected(true)
        #expect(!placement.top)
    }
}
