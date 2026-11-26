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
        // The captain, on the panel status mark: remove the "yours" label; only an added panel names its maker.
        #expect(shown.map(\.owner) == ["Review Desk", nil])
        #expect(shown.map(\.filesSource) == ["installed", "yours"])
    }

    /// The captain's own panel as the computer lists it with everything its status mark can say, in the desktop's words
    /// (`PersonalExtensionView`): the mark reads stopped work first, then failing reads, a call waiting on them, paused
    /// work and a call they turned down, as the desktop's `panelStatusSections` orders them.
    @Test func theStatusMarkSaysTheMostUrgentFirst() throws {
        let entry = try PhoneJSON.read([
            "id": "tokens", "source": "personal", "by": NSNull(), "title": "Tokens",
            "placement": ["x": "left", "y": "top"], "order": 100, "size": "content", "present": true, "ownPresence": false,
            "moves": false, "running": false, "reads": [], "sql": [], "panel": NSNull(),
            "frame": ["version": "0123456789abcdef"], "cardViews": [], "cards": [:], "header": [], "commands": [],
            "server": NSNull(), "error": NSNull(),
            "integrationAsks": [
                ["integration": "int-1", "place": "GitHub", "action": "list_pulls", "label": "Read from GitHub", "state": "declined"],
                ["integration": "int-2", "place": "Linear", "action": "issues", "label": "Read issues", "state": "asking"],
            ],
            "paused": ["api": 1, "serves": [2], "asked": false],
            "failing": [[
                "read": ["kind": "background", "task": "usage"], "since": "2026-11-24T09:00:00.000Z", "tries": 6,
                "answer": "Error: 429 Too Many Requests: rate limit reached for this hour", "asked": false,
            ]],
            "stopped": ["reason": "unresponsive", "at": "2026-11-24T10:00:00.000Z", "version": "abc"],
        ] as [String: Any])
        let decoded = try #require(PhonePanelList.decode(.object(["extensions": .array([entry])])).first)
        #expect(decoded.statusSections.map(\.key) == ["stopped", "failing", "asking", "paused", "declined"])
        #expect(decoded.statusSections.map(\.tone) == ["warn", "warn", "captain", "idle", "idle"])
        guard case .failing(let rows) = decoded.statusSections[1] else { Issue.record("no failing section"); return }
        #expect(rows.first?.read.task == "usage")
        #expect(rows.first?.tries == 6)
        // A panel the computer says nothing about draws no mark.
        #expect(try #require(PhonePanelList.decode(.object(["extensions": .array([try panel("quiet")])])).first).statusSections.isEmpty)
    }

    /// The desktop's `framedCode` shows paused only while no task builds the panel; the phone holds it back the same way.
    @Test func aPausedPanelATaskIsBuildingShowsNoPausedSection() throws {
        guard case .object(var entry) = try panel("building") else { Issue.record("no panel"); return }
        entry["paused"] = try PhoneJSON.read(["api": 1, "serves": [2], "asked": false] as [String: Any])
        entry["running"] = .bool(true)
        let building = try #require(PhonePanelList.decode(.object(["extensions": .array([.object(entry)])])).first)
        #expect(building.statusSections.isEmpty)
        entry["running"] = .bool(false)
        let idle = try #require(PhonePanelList.decode(.object(["extensions": .array([.object(entry)])])).first)
        #expect(idle.statusSections.map(\.key) == ["paused"])
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

    @Test func anAppPanelsFilesAreCheckedAgainstTheirPinsWhenReadAndWhenKept() throws {
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

        // Kept on the device by panel and version, and refused when a kept file no longer matches its pin.
        let caches = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: caches) }
        let folder = PhonePanelFiles.folder(in: caches, app: "knowledge", version: "89abcdef01234567")
        try files.save(in: folder)
        let kept = try #require(PhonePanelFiles.load(from: folder))
        #expect(kept.builtFor == "1.0.0")
        #expect(kept.files == files.files)
        let cardsFile = try #require(FileManager.default.contentsOfDirectory(atPath: folder.path).sorted().first { $0.hasSuffix(".bin") })
        try Data("tampered".utf8).write(to: folder.appendingPathComponent(cardsFile))
        #expect(PhonePanelFiles.load(from: folder) == nil)
    }
}
