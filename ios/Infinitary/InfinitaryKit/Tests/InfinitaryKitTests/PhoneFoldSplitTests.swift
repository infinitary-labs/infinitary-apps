import Foundation
import Testing
@testable import InfinitaryKit

/// The captain's Split at the fold switch: on by default, so nobody's open iPhone Duo changes after the update, and kept
/// on the device across launches once turned off.
struct PhoneFoldSplitTests {
    /// A defaults domain of this test's own, removed after it, so the app's real choice is never read or changed.
    private func scratch() -> (UserDefaults, String) {
        let name = "phone-fold-split-tests-\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }

    @Test func startsOnAndWithNoFoldSeen() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(PhoneFoldSplit.saved(in: defaults))
        #expect(!PhoneFoldSplit.foldSeen(in: defaults))
    }

    @Test func keepsEachChoiceAndTheSeenFoldAcrossReads() {
        let (defaults, name) = scratch()
        defer { defaults.removePersistentDomain(forName: name) }
        PhoneFoldSplit.saveFoldSeen(in: defaults)
        for split in [false, true, false] {
            PhoneFoldSplit.save(split, in: defaults)
            // A fresh reader of the same domain stands in for the next launch.
            let next = UserDefaults(suiteName: name)!
            #expect(PhoneFoldSplit.saved(in: next) == split)
            #expect(PhoneFoldSplit.foldSeen(in: next))
        }
    }
}
