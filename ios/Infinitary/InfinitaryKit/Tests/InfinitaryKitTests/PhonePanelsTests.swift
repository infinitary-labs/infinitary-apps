import Foundation
import Testing
@testable import InfinitaryKit

/// INF-3830 piece 2 (done when: "each panel draws ... in the computer's order"): the phone's Panels column reads the
/// computer's rails left top to right bottom. These replay the desktop's own `arrangePanels` over the same layouts,
/// which scripts/generate-phone-scene.ts records, and check the list the column draws and the library's pins.
struct PhonePanelsTests {
    private struct Reading: Decodable {
        struct Panel: Decodable { let id: String; let preferred: PhonePanel.Placement; let order: Int }
        let name: String
        let layout: PhonePanelLayout
        let panels: [Panel]
        let column: [String]
    }

    private func readings() throws -> [Reading] {
        let url = try #require(Bundle.module.url(forResource: "PhonePanelOrder.generated", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Reading].self, from: Data(contentsOf: url))
    }

    @Test func theColumnReadsAsTheComputersRails() throws {
        let all = try readings()
        #expect(all.count == 6)
        for reading in all {
            let known = Set(reading.panels.map(\.id))
            let column = PhonePanelOrder.column(reading.layout, reading.panels.map {
                PhonePanelOrder.Panel(id: $0.id, preferred: $0.preferred, order: $0.order)
            }).filter(known.contains)
            #expect(column == reading.column, "\(reading.name)")
        }
    }

    private func panel(_ id: String, present: Bool = true, built: Bool = true, by: String? = nil, order: Int = 100) throws -> PhoneJSON {
        try PhoneJSON.read([
            "id": id, "source": by == nil ? "personal" : "installed", "by": by ?? NSNull(), "title": id.capitalized,
            "placement": ["x": "left", "y": "top"], "order": order, "size": "content", "present": present, "ownPresence": false,
            "moves": false, "running": false, "reads": ["tasks.board"], "sql": [], "panel": NSNull(),
            "frame": built ? ["version": "0123456789abcdef"] : NSNull(), "cardViews": [], "cards": [:], "header": [], "commands": [],
            "server": NSNull(), "error": NSNull(),
        ] as [String: Any])
    }

    @Test func theColumnDrawsWhatARailWouldDraw() throws {
        let snapshot = PhoneJSON.object(["extensions": .array([
            try panel("tokens", order: 2), try panel("absent", present: false), try panel("broken", built: false),
            try panel("hidden"), try panel("reviews", by: "Review Desk", order: 1), .object(["id": .string("unreadable")]),
        ])])
        let layout = PhonePanelLayout(hiddenPanels: ["hidden": true])
        let shown = PhonePanelOrder.shown(PhonePanelList.decode(snapshot), layout: layout)
        #expect(shown.map(\.id) == ["reviews", "tokens"])
        #expect(shown.map(\.owner) == ["Review Desk", "yours"])
        #expect(shown.map(\.filesSource) == ["installed", "yours"])
    }

    @Test func aLibraryFileThatFailsItsPinIsRefused() throws {
        let good = Data("export const a = 1;".utf8)
        let answer = { (pin: String) in PhoneJSON.object(["version": .string("1.0.0"), "files": .array([.object([
            "path": .string("boot.mjs"), "integrity": .string(pin), "data": .string(good.base64EncodedString()),
        ])])]) }
        let library = try PhonePanelLibrary.read(answer(PhonePanelFile.pin(good)), version: "1.0.0")
        #expect(library.files["boot.mjs"]?.data == good)
        #expect(throws: PhonePanelFailure.integrity) { try PhonePanelLibrary.read(answer(PhonePanelFile.pin(Data("other".utf8))), version: "1.0.0") }
        #expect(throws: PhonePanelFailure.notServed) { try PhonePanelLibrary.read(.null, version: "1.0.0") }

        let caches = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: caches) }
        try library.save(in: caches)
        #expect(PhonePanelLibrary.load(from: caches, version: "1.0.0")?.files == library.files)
        let kept = PhonePanelLibrary.folder(in: caches, version: "1.0.0").appendingPathComponent("0.bin")
        try Data("tampered".utf8).write(to: kept)
        #expect(PhonePanelLibrary.load(from: caches, version: "1.0.0") == nil)
    }

    /// One entry of `inf:plugins:app-panels` as the computer answers it: no source, maker or presence of its own.
    private func appPanel(_ id: String, title: String, order: Int) throws -> PhoneJSON {
        try PhoneJSON.read([
            "id": id, "title": title, "placement": ["x": "right", "y": "top"], "order": order, "size": "content",
            "ownPresence": id != "activity", "moves": false, "reads": ["tasks.board"], "sql": [], "cardViews": [],
            "cards": [:], "header": [], "frame": ["version": "89abcdef01234567"],
        ] as [String: Any])
    }

    /// The captain, on INF-6295: show the built-in panels on the Panels tab "unless there's a dedicated native tab for
    /// it (tasks, activities)".
    @Test func theAppsOwnPanelsJoinTheColumnButTheOnesDrawnAsTabs() throws {
        let answer = PhoneJSON.object(["panels": .array([
            try appPanel("activity", title: "Activity", order: 10), try appPanel("now", title: "Tasks", order: 20),
            try appPanel("automation", title: "Automation", order: 40), try appPanel("batches-panel", title: "Batches", order: 50),
            try appPanel("tokens", title: "Tokens", order: 60),
        ])])
        let personal = PhonePanelList.decode(.object(["extensions": .array([try panel("tokens")])]))
        let app = PhoneAppPanelList.decode(answer, besides: personal)
        #expect(app.map(\.id) == ["automation", "batches-panel"])
        #expect(app.allSatisfy { $0.isApp && $0.owner == nil && $0.filesSource == "app" && $0.present })
    }

    @Test func anAppPanelsFilesAreRefusedWholeWhenOneFailsItsPin() throws {
        let panel = Data("export default () => null;".utf8), cards = Data("export default {};".utf8)
        let answer = { (cardsPin: String) in PhoneJSON.object(["builtFor": .string("1.0.0"), "files": .array([
            .object(["path": .string("panel.mjs"), "integrity": .string(PhonePanelFile.pin(panel)), "data": .string(panel.base64EncodedString())]),
            .object(["path": .string("cards.mjs"), "integrity": .string(cardsPin), "data": .string(cards.base64EncodedString())]),
        ])]) }
        let files = try PhonePanelFiles.readPinned(answer(PhonePanelFile.pin(cards)))
        #expect(files.builtFor == "1.0.0")
        #expect(files.files["cards.mjs"]?.data == cards)
        #expect(throws: PhonePanelFailure.integrity) { try PhonePanelFiles.readPinned(answer(PhonePanelFile.pin(panel))) }
        #expect(throws: PhonePanelFailure.notServed) { try PhonePanelFiles.readPinned(.null) }
    }
}
