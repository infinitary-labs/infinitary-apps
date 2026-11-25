import CryptoKit
import Foundation

/// INF-3830 piece 2: the captain's panels on the phone (docs/ios.md, "Panels"). The computer answers its panels
/// (`inf:plugins:personal:list`) and its layout (`inf:shell:preferences`); the phone draws the ones a rail on the
/// computer would draw, as one column in the rails' order, each from its own files and the library they were built for.
public struct PhonePanel: Decodable, Sendable, Equatable, Identifiable {
    public struct Placement: Codable, Sendable, Equatable { public let x: String; public let y: String }
    public struct Frame: Decodable, Sendable, Equatable { public let version: String }
    public struct Server: Decodable, Sendable, Equatable { public let actions: [String] }
    public struct Stopped: Decodable, Sendable, Equatable { public let reason: String }
    public struct Paused: Decodable, Sendable, Equatable { public let asked: Bool }
    /// An integration call that waits on the captain's approval card ("asking") or that they turned down ("declined").
    public struct IntegrationAsk: Decodable, Sendable, Equatable {
        public let integration: String
        public let place: String
        public let action: String
        public let label: String
        public let state: String
    }
    /// A read that keeps failing (docs/personal-panels.md, "Reads that keep failing").
    public struct FailingRead: Decodable, Sendable, Equatable {
        public struct Read: Decodable, Sendable, Equatable {
            public let kind: String
            public let task: String?
            public let place: String?
        }
        public let read: Read
        /// The first failure in the row, ISO wall time.
        public let since: String
        public let tries: Int
        public let answer: String
        public let asked: Bool
    }

    public let id: String
    /// "personal" for the captain's own, "installed" for an added plugin's, "app" for one of the app's own
    /// (`PhoneAppPanelList`).
    public let source: String
    /// An added plugin's name, the header's owner word; nil for the captain's own.
    public let by: String?
    public let title: String
    public let placement: Placement
    public let order: Int
    /// "content" asks for its own height; "fill" for the room its rail has.
    public let size: String
    public let present: Bool
    /// Its own code decides whether it shows (`rail.show`).
    public let ownPresence: Bool
    public let moves: Bool
    public let reads: [String]
    public let sql: [String]
    public let frame: Frame?
    public let server: Server?
    public let stopped: Stopped?
    public let paused: Paused?
    public let integrationAsks: [IntegrationAsk]?
    public let failing: [FailingRead]?
    /// Piece 3: its card views (`cards/<view>.tsx`), the cards its manifest names, and the buttons the app draws in its
    /// header. A computer that lists none leaves them empty.
    public let cardViews: [String]?
    public let cards: [String: PhonePanelCardDeclaration]?
    public let header: [PhonePanelHeaderButton]?

    /// One of the app's own panels, whose files come from `inf:plugins:app-panel-files`.
    public var isApp: Bool { source == PhoneAppPanelList.source }
    /// What `inf:plugins:files` names it by, or "app" for one of the app's own.
    public var filesSource: String { isApp ? PhoneAppPanelList.source : source == "installed" ? "installed" : "yours" }
    /// The header's owner word: an added plugin's name; none for the captain's own or the app's own, as on the desktop.
    public var owner: String? { isApp ? nil : by }
    /// What the status mark by its name says, most urgent first, as the desktop's `panelStatusSections` orders it.
    public var statusSections: [PhonePanelStatus] {
        var sections: [PhonePanelStatus] = []
        if let stopped { sections.append(.stopped(exited: stopped.reason == "exited")) }
        if let failing, !failing.isEmpty { sections.append(.failing(failing)) }
        let asks = integrationAsks ?? []
        let asking = asks.filter { $0.state == "asking" }
        if !asking.isEmpty { sections.append(.asking(asking)) }
        if let paused { sections.append(.paused(asked: paused.asked)) }
        let declined = asks.filter { $0.state == "declined" }
        if !declined.isEmpty { sections.append(.declined(declined)) }
        return sections
    }
    /// The header's buttons as the desktop's `PanelHeaderButtons` draws them: one that puts up a card in both header
    /// states, one that asks the panel only while it shows its body.
    public func headerButtons(folded: Bool) -> [PhonePanelHeaderButton] {
        (header ?? []).filter { !folded || $0.emits != nil }
    }
}

/// One thing the status mark by a panel's name says (design skill Panel.prompt.md, "The status mark").
public enum PhonePanelStatus: Sendable, Equatable {
    case stopped(exited: Bool)
    case failing([PhonePanel.FailingRead])
    case asking([PhonePanel.IntegrationAsk])
    case paused(asked: Bool)
    case declined([PhonePanel.IntegrationAsk])

    /// The mark's tone: the desktop's warn for work stopped or failing, the captain's for a call waiting on them, idle else.
    public var tone: String {
        switch self {
        case .stopped, .failing: "warn"
        case .asking: "captain"
        case .paused, .declined: "idle"
        }
    }
    public var key: String {
        switch self {
        case .stopped: "stopped"
        case .failing: "failing"
        case .asking: "asking"
        case .paused: "paused"
        case .declined: "declined"
        }
    }
}

/// A card the panel's manifest names, for a header button to put up (`cards` in manifest.json).
public struct PhonePanelCardDeclaration: Decodable, Sendable, Equatable {
    public let view: String
    public let title: String
    public let width: String?
    public let height: String?
    public let data: PhoneJSON?
}

/// A button the app draws in a panel's header (`header` in manifest.json): it puts up one of the named cards
/// (`emits`, with `data` in place of the card's own), or, naming none, it is pressed into the panel as an ask.
public struct PhonePanelHeaderButton: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let icon: String
    public let label: String
    public let emits: String?
    public let data: PhoneJSON?

    /// The system symbol for each of the app's header icons (`PANEL_HEADER_ICONS`), as near the desktop's Lucide
    /// drawing as the system's set comes; `PhonePanelsTests` holds every icon the desktop offers to one.
    public static let symbols: [String: String] = [
        "open": "arrow.up.left.and.arrow.down.right", "search": "magnifyingglass", "add": "plus", "list": "list.bullet",
        "note": "doc", "filter": "line.3.horizontal.decrease", "clock": "clock", "chart": "chart.bar.xaxis",
    ]
    public var symbol: String { Self.symbols[icon] ?? "circle" }
}

/// The part of the computer's layout the phone reads: which panels its rails hide and where each one sits.
public struct PhonePanelLayout: Decodable, Sendable, Equatable {
    public struct Arrangement: Decodable, Sendable, Equatable {
        public struct Side: Decodable, Sendable, Equatable { public let top: [String]; public let bottom: [String] }
        public let left: Side
        public let right: Side
    }

    public let hiddenPanels: [String: Bool]
    public let placements: [String: PhonePanel.Placement]
    public let panelOrder: [String]?
    public let arrangement: Arrangement?

    public init(hiddenPanels: [String: Bool] = [:], placements: [String: PhonePanel.Placement] = [:],
                panelOrder: [String]? = nil, arrangement: Arrangement? = nil) {
        self.hiddenPanels = hiddenPanels; self.placements = placements; self.panelOrder = panelOrder; self.arrangement = arrangement
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hiddenPanels = try container.decodeIfPresent([String: Bool].self, forKey: .hiddenPanels) ?? [:]
        placements = try container.decodeIfPresent([String: PhonePanel.Placement].self, forKey: .placements) ?? [:]
        panelOrder = try container.decodeIfPresent([String].self, forKey: .panelOrder)
        arrangement = try container.decodeIfPresent(Arrangement.self, forKey: .arrangement)
    }

    private enum CodingKeys: String, CodingKey { case hiddenPanels, placements, panelOrder, arrangement }

    public static func of(preferences: PhoneJSON) -> PhonePanelLayout {
        guard case .object(let fields) = preferences, let layout = fields["layout"],
              let data = try? JSONEncoder().encode(layout),
              let decoded = try? JSONDecoder().decode(PhonePanelLayout.self, from: data) else { return PhonePanelLayout() }
        return decoded
    }
}

/// The rails' order as one column: the desktop's `arrangePanels` (src/shared/panelArrangement.ts), read left top,
/// left bottom, right top, right bottom. The phone holds no rails of its own, so it reads the order the computer's
/// rails draw; PhonePanelOrderTests replays the desktop's own reading of the same layouts.
public enum PhonePanelOrder {
    public struct Panel: Sendable { public let id: String; public let preferred: PhonePanel.Placement; public let order: Int
        public init(id: String, preferred: PhonePanel.Placement, order: Int) { self.id = id; self.preferred = preferred; self.order = order }
    }

    static let slots: [(x: String, y: String)] = [("left", "top"), ("left", "bottom"), ("right", "top"), ("right", "bottom")]

    public static func column(_ layout: PhonePanelLayout, _ panels: [Panel]) -> [String] {
        let slotOf = { (panel: Panel) in layout.placements[panel.id] ?? panel.preferred }
        let declared = { (a: Panel, b: Panel) -> Bool in
            a.order != b.order ? a.order < b.order : a.id.compare(b.id, locale: Locale(identifier: "en")) == .orderedAscending
        }
        func unique(_ ids: [String]) -> [String] { var seen = Set<String>(); return ids.filter { seen.insert($0).inserted } }
        guard let saved = layout.arrangement else {
            let picked = { (id: String) -> Int in layout.panelOrder?.firstIndex(of: id) ?? Int.max }
            return slots.flatMap { slot -> [String] in
                let here = panels.filter { slotOf($0).x == slot.x && slotOf($0).y == slot.y }
                let sorted = here.sorted { a, b in
                    let rankA = picked(a.id), rankB = picked(b.id)
                    if rankA != rankB { return slot.y == "top" ? rankA < rankB : rankA > rankB }
                    return declared(a, b)
                }
                return unique(sorted.map(\.id))
            }
        }
        var seen = Set<String>()
        func listed(_ ids: [String]) -> [String] { ids.filter { seen.insert($0).inserted } }
        var columns: [[String]] = [listed(saved.left.top), listed(saved.left.bottom), listed(saved.right.top), listed(saved.right.bottom)]
        let added = panels.filter { !seen.contains($0.id) }.sorted(by: declared)
        for (index, slot) in slots.enumerated() {
            let here = unique(added.filter { slotOf($0).x == slot.x && slotOf($0).y == slot.y }.map(\.id))
            guard !here.isEmpty else { continue }
            columns[index] = slot.y == "top" ? columns[index] + here : here + columns[index]
        }
        return columns.flatMap { $0 }
    }

    /// The panels the phone draws, in the column's order: each a rail on the computer would draw - present, with a
    /// built panel, and not hidden.
    public static func shown(_ panels: [PhonePanel], layout: PhonePanelLayout) -> [PhonePanel] {
        let drawable = panels.filter { $0.present && $0.frame != nil && layout.hiddenPanels[$0.id] != true }
        let byID = Dictionary(drawable.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let order = column(layout, panels.map { Panel(id: $0.id, preferred: $0.placement, order: $0.order) })
        return order.compactMap { byID[$0] }
    }
}

/// The computer's panels as the phone holds them: the list, decoded leniently so one panel the phone cannot read
/// leaves the others.
public enum PhonePanelList {
    public static func decode(_ snapshot: PhoneJSON) -> [PhonePanel] {
        guard case .object(let fields) = snapshot, case .array(let extensions)? = fields["extensions"] else { return [] }
        return extensions.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? JSONDecoder().decode(PhonePanel.self, from: data)
        }
    }
}

/// The app's own panels the computer shows (`inf:plugins:app-panels`), drawn on the Panels tab as the
/// captain's are, from the desktop's own panel code (docs/ios.md, "Panels"). The computer names every one whose gate is
/// open; the phone leaves out the ones it already draws as tabs of its own, and any whose id one of the captain's panels
/// holds, as a rail holds one panel per id.
public enum PhoneAppPanelList {
    public static let source = "app"
    /// The Tasks panel and the Activity panel, which are the phone's own Tasks and Activity tabs.
    public static let drawnAsTabs: Set<String> = ["now", "activity"]

    public static func decode(_ answer: PhoneJSON, besides personal: [PhonePanel] = []) -> [PhonePanel] {
        guard case .object(let fields) = answer, case .array(let panels)? = fields["panels"] else { return [] }
        let taken = Set(personal.map(\.id))
        return panels.compactMap { value in
            guard case .object(var panel) = value else { return nil }
            panel["source"] = .string(source); panel["by"] = .null; panel["present"] = .bool(true)
            guard let data = try? JSONEncoder().encode(PhoneJSON.object(panel)),
                  let decoded = try? JSONDecoder().decode(PhonePanel.self, from: data),
                  !drawnAsTabs.contains(decoded.id), !taken.contains(decoded.id) else { return nil }
            return decoded
        }
    }
}

/// One file the phone serves a panel's frame: its bytes and the `sha256-<base64>` pin its import map carries.
public struct PhonePanelFile: Sendable, Equatable {
    public let data: Data
    public let integrity: String
    public init(data: Data, integrity: String) { self.data = data; self.integrity = integrity }

    public static func pin(_ data: Data) -> String { "sha256-" + Data(SHA256.hash(data: data)).base64EncodedString() }
}

/// Why a panel's files could not be used, in the sentence its place shows after "This panel could not be opened."
public enum PhonePanelFailure: Error, Equatable, Sendable {
    /// The computer answered no files, or no library, for this version.
    case notServed
    /// A file's bytes do not match the pin the computer named for it.
    case integrity
    /// The computer was out of reach or answered something the phone cannot read.
    case unreadable

    public var sentence: String {
        switch self {
        case .notServed: PhoneMessages.phonePanelNotServed()
        case .integrity: PhoneMessages.phonePanelIntegrity()
        case .unreadable: PhoneMessages.phonePanelUnreadable()
        }
    }
}

/// Files the phone keeps with their pins, and reads back only while every file still matches its pin: the panel library
/// and the app's own panels' files.
enum PhonePinnedFiles {
    /// An answer's files, each with the pin the computer named, refused whole when any file's bytes do not match it.
    static func read(_ entries: [PhoneJSON]) throws(PhonePanelFailure) -> [String: PhonePanelFile] {
        var files: [String: PhonePanelFile] = [:]
        for entry in entries {
            guard case .object(let file) = entry, case .string(let path)? = file["path"],
                  case .string(let integrity)? = file["integrity"], case .string(let base64)? = file["data"],
                  let data = Data(base64Encoded: base64) else { throw .unreadable }
            guard PhonePanelFile.pin(data) == integrity else { throw .integrity }
            files[path] = PhonePanelFile(data: data, integrity: integrity)
        }
        return files
    }

    /// A folder name made only of characters every file system keeps.
    static func safe(_ name: String) -> String {
        name.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0) ? String($0) : "_" }.joined()
    }

    /// Writes each file and a list of their pins into the folder, replacing what it held.
    static func save(_ files: [String: PhonePanelFile], in folder: URL) throws {
        try? FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var pins: [String: String] = [:]
        for (index, (path, file)) in files.sorted(by: { $0.key < $1.key }).enumerated() {
            try file.data.write(to: folder.appendingPathComponent("\(index).bin"))
            pins[path] = "\(index) \(file.integrity)"
        }
        try JSONEncoder().encode(pins).write(to: folder.appendingPathComponent("pins.json"))
    }

    /// The files kept in the folder, or nil when none are kept or any kept file no longer matches its pin.
    static func load(from folder: URL) -> [String: PhonePanelFile]? {
        guard let pinData = try? Data(contentsOf: folder.appendingPathComponent("pins.json")),
              let pins = try? JSONDecoder().decode([String: String].self, from: pinData) else { return nil }
        var files: [String: PhonePanelFile] = [:]
        for (path, line) in pins {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard parts.count == 2, let data = try? Data(contentsOf: folder.appendingPathComponent("\(parts[0]).bin")),
                  PhonePanelFile.pin(data) == parts[1] else { return nil }
            files[path] = PhonePanelFile(data: data, integrity: parts[1])
        }
        return files
    }
}

/// The panel library the phone keeps, one copy per version of the app the panels were built for. Every file is
/// checked against its pin when it arrives and again when it is read back, so a file changed on the way or on disk is
/// never served to a frame.
public struct PhonePanelLibrary: Sendable {
    public let version: String
    public let files: [String: PhonePanelFile]

    /// Reads a library answer (`inf:plugins:library`), refusing it whole when any file fails its pin.
    public static func read(_ answer: PhoneJSON, version: String) throws(PhonePanelFailure) -> PhonePanelLibrary {
        guard case .object(let fields) = answer else { throw .notServed }
        guard case .string(let answered)? = fields["version"], answered == version,
              case .array(let entries)? = fields["files"] else { throw .unreadable }
        return PhonePanelLibrary(version: version, files: try PhonePinnedFiles.read(entries))
    }

    /// Where the phone keeps libraries: one folder per version, holding each file and a list of their pins.
    public static func folder(in caches: URL, version: String) -> URL {
        caches.appendingPathComponent("panel-library", isDirectory: true).appendingPathComponent(PhonePinnedFiles.safe(version), isDirectory: true)
    }

    public func save(in caches: URL) throws { try PhonePinnedFiles.save(files, in: Self.folder(in: caches, version: version)) }

    /// The kept library for this version, or nil when none is kept or any kept file no longer matches its pin.
    public static func load(from caches: URL, version: String) -> PhonePanelLibrary? {
        PhonePinnedFiles.load(from: folder(in: caches, version: version)).map { PhonePanelLibrary(version: version, files: $0) }
    }
}

/// A panel's own built files (`inf:plugins:files`): what version of the library they import, and each file with the
/// pin the phone computed, which its frame's import map then carries.
public struct PhonePanelFiles: Sendable {
    public let builtFor: String
    public let files: [String: PhonePanelFile]

    public static func read(_ answer: PhoneJSON) throws(PhonePanelFailure) -> PhonePanelFiles {
        guard case .object(let fields) = answer else { throw .notServed }
        guard case .string(let builtFor)? = fields["builtFor"], case .array(let entries)? = fields["files"] else { throw .unreadable }
        var files: [String: PhonePanelFile] = [:]
        for entry in entries {
            guard case .object(let file) = entry, case .string(let path)? = file["path"], case .string(let base64)? = file["data"],
                  let data = Data(base64Encoded: base64) else { throw .unreadable }
            files[path] = PhonePanelFile(data: data, integrity: PhonePanelFile.pin(data))
        }
        guard files["panel.mjs"] != nil else { throw .unreadable }
        return PhonePanelFiles(builtFor: builtFor, files: files)
    }

    /// One of the app's own panels' files (`inf:plugins:app-panel-files`): each carries the pin the computer's build made,
    /// and the answer is refused whole when any file's bytes do not match it, as the library is.
    public static func readPinned(_ answer: PhoneJSON) throws(PhonePanelFailure) -> PhonePanelFiles {
        guard case .object(let fields) = answer else { throw .notServed }
        guard case .string(let builtFor)? = fields["builtFor"], case .array(let entries)? = fields["files"] else { throw .unreadable }
        let files = try PhonePinnedFiles.read(entries)
        guard files["panel.mjs"] != nil else { throw .unreadable }
        return PhonePanelFiles(builtFor: builtFor, files: files)
    }

    /// Where the phone keeps an app panel's files: one folder per panel and version. The version names the computer's
    /// build too (`appPanelsFor`), so the library they import is the same for every computer that lists it.
    public static func folder(in caches: URL, app id: String, version: String) -> URL {
        caches.appendingPathComponent("panel-app", isDirectory: true)
            .appendingPathComponent(PhonePinnedFiles.safe("\(id)-\(version)"), isDirectory: true)
    }

    public func save(in folder: URL) throws {
        try PhonePinnedFiles.save(files, in: folder)
        try Data(builtFor.utf8).write(to: folder.appendingPathComponent("built-for"))
    }

    /// The kept files in that folder, or nil when none are kept or any kept file no longer matches its pin.
    public static func load(from folder: URL) -> PhonePanelFiles? {
        guard let files = PhonePinnedFiles.load(from: folder), files["panel.mjs"] != nil,
              let data = try? Data(contentsOf: folder.appendingPathComponent("built-for")),
              let builtFor = String(data: data, encoding: .utf8), !builtFor.isEmpty else { return nil }
        return PhonePanelFiles(builtFor: builtFor, files: files)
    }
}
