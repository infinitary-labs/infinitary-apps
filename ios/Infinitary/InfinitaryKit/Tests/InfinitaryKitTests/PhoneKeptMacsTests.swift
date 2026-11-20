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

    @Test func savesTheShownWhereAnOlderBuildReadsIt() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("kept-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let files = PhoneKeptMacsFiles(folder: folder)
        // A phone that saved one computer before: JoinedMac.json alone, as the build before wrote it.
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode(studio).write(to: files.shownURL)
        #expect(try PhoneKeptMacs(shown: files.readShown(), others: files.readOthers()) == PhoneKeptMacs(shown: studio))

        var kept = PhoneKeptMacs(shown: studio)
        kept.joined(office)
        try files.save(kept)
        // An older build reads the shown computer from the file it always read.
        #expect(try JSONDecoder().decode(JoinedMac.self, from: Data(contentsOf: files.shownURL)) == office)
        #expect(try PhoneKeptMacs(shown: files.readShown(), others: files.readOthers()) == kept)
        #expect(try files.othersURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)

        // A write cut after the others but before the shown lists the shown computer twice: it reads as shown.
        #expect(PhoneKeptMacs(shown: office, others: [office, studio]) == kept)

        kept.forgetShown()
        try files.save(kept)
        #expect(!FileManager.default.fileExists(atPath: files.othersURL.path))
        kept.forgetShown()
        try files.save(kept)
        #expect(!FileManager.default.fileExists(atPath: files.shownURL.path))
    }
}
