import Foundation
import Testing
@testable import InfinitaryKit

/// INF-5265 (docs/ios.md, "Several computers"): the phone keeps every computer it joined, shows one at a time and moves
/// a phone that saved one computer to the list with no new join.
struct PhoneKeptMacsTests {
    private let studio = JoinedMac(addresses: ["100.82.4.17:47120"], pin: "c2VwYXJhdGUtc3R1ZGlvLXBpbg", deviceID: "phone-on-studio", name: "Personal server")
    private let office = JoinedMac(addresses: ["10.20.1.9:47120"], pin: "c2VwYXJhdGUtb2ZmaWNlLXBpbg", deviceID: "phone-on-office", name: "Work computer")
    private let lab = JoinedMac(addresses: ["192.168.1.40:47120"], pin: "c2VwYXJhdGUtbGFiLXBpbi0", deviceID: "phone-on-lab", name: "Lab Mac")

    @Test func joiningAnotherKeepsTheFirstAndShowsTheNew() {
        var kept = PhoneKeptMacs(shown: studio)
        kept.joined(office)
        #expect(kept.shown == office && kept.others == [studio])
        // One tap shows the other; the one left stays first among the others.
        kept.joined(lab)
        let shown = kept.show(studio.pin)
        #expect(shown)
        #expect(kept.shown == studio && kept.others == [lab, office])
        let unknown = kept.show("not-kept")
        #expect(!unknown)
        // Joining a kept computer again replaces its record and shows it.
        var renamed = office; renamed.name = "Work laptop"
        kept.joined(renamed)
        #expect(kept.shown == renamed && kept.others == [studio, lab])
    }

    @Test func forgettingTheShownShowsTheOneShownMostRecently() {
        var kept = PhoneKeptMacs(shown: lab, others: [office, studio])
        kept.forgetShown()
        #expect(kept.shown == office && kept.others == [studio])
        kept.forget(other: studio.pin)
        kept.forgetShown()
        #expect(kept.shown == nil && kept.all.isEmpty)
    }

    /// The captain's pick on INF-5265's review: the list is saved whole at once, and the one record a build before
    /// saved is read as that computer, shown, with no new join.
    @Test func savesTheListWholeAndReadsTheOneRecordFromBefore() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("kept-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let files = PhoneKeptMacsFiles(folder: folder)
        #expect(try files.read() == PhoneKeptMacs())
        // A phone that saved one computer before: JoinedMac.json alone, as the build before wrote it.
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode(studio).write(to: files.legacyURL)
        var kept = try files.read()
        #expect(kept == PhoneKeptMacs(shown: studio))

        kept.joined(office)
        try files.save(kept)
        #expect(try files.read() == kept)
        #expect(!FileManager.default.fileExists(atPath: files.legacyURL.path), "The list now holds the computer from before")
        #expect(try files.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)

        // A switch saved: both computers stay, the other one shown.
        kept.show(studio.pin)
        try files.save(kept)
        #expect(try files.read() == PhoneKeptMacs(shown: studio, others: [office]))

        kept.forgetShown()
        kept.forgetShown()
        try files.save(kept)
        #expect(try files.read() == PhoneKeptMacs())
    }
}
