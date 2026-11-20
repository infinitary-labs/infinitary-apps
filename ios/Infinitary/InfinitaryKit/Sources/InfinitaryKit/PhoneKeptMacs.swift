import Foundation

/// INF-5265, the captain's approved plan on INF-5264 (docs/ios.md, "Several computers"): the phone keeps every computer
/// it joined and shows one at a time. A computer is named by its pin, the key a home keeps through a move, so joining
/// one again replaces its record rather than adding a second.
public struct PhoneKeptMacs: Equatable, Sendable {
    /// The computer the phone shows, or none before the first join.
    public private(set) var shown: JoinedMac?
    /// The other kept computers, the one shown most recently first.
    public private(set) var others: [JoinedMac]

    public init(shown: JoinedMac? = nil, others: [JoinedMac] = []) {
        self.shown = shown
        // A record saved half way through a switch can list the shown computer among the others too: shown wins.
        var seen = Set(shown.map { [$0.pin] } ?? [])
        self.others = others.filter { seen.insert($0.pin).inserted }
    }

    /// Every kept computer, the shown one first.
    public var all: [JoinedMac] { (shown.map { [$0] } ?? []) + others }

    /// A computer the phone joined: it shows, the one shown before stays among the others, and a computer joined
    /// again takes the place of its old record.
    public mutating func joined(_ mac: JoinedMac) {
        let before = shown
        others.removeAll { $0.pin == mac.pin }
        shown = mac
        if let before, before.pin != mac.pin { others.insert(before, at: 0) }
    }

    /// Shows a kept computer; false when the phone keeps none with that pin.
    @discardableResult public mutating func show(_ pin: String) -> Bool {
        if shown?.pin == pin { return true }
        guard let index = others.firstIndex(where: { $0.pin == pin }) else { return false }
        let next = others.remove(at: index)
        if let shown { others.insert(shown, at: 0) }
        shown = next
        return true
    }

    /// The shown computer's newer record, such as its new addresses; any other record is left as it is.
    public mutating func update(_ mac: JoinedMac) {
        guard shown?.pin == mac.pin else { return }
        shown = mac
    }

    /// Forgets the shown computer: the kept computer shown most recently shows next, or none is left.
    public mutating func forgetShown() {
        shown = others.isEmpty ? nil : others.removeFirst()
    }

    /// Forgets one of the others, such as one whose record is damaged.
    public mutating func forget(other pin: String) {
        others.removeAll { $0.pin == pin }
    }
}

/// Where the kept computers live: one record, `KeptMacs.json`, written whole at once, so a switch or a forget cut short
/// leaves the list as it was before or after, never a computer missing (the captain's pick on INF-5265's review, "Save
/// both together; older versions may not see the latest selection"). A phone that saved one computer before has only
/// `JoinedMac.json`, which is read as that computer, shown, until the first save replaces it. It is readable after the
/// first unlock and left out of backups, as the one record was.
public struct PhoneKeptMacsFiles: Sendable {
    public let url: URL
    /// The one computer a build before this one saved.
    public let legacyURL: URL

    public init(folder: URL) {
        url = folder.appendingPathComponent("KeptMacs.json")
        legacyURL = folder.appendingPathComponent("JoinedMac.json")
    }

    private struct Record: Codable {
        var shown: JoinedMac?
        var others: [JoinedMac]
    }

    /// The kept computers, or none before the first join.
    public func read() throws -> PhoneKeptMacs {
        if FileManager.default.fileExists(atPath: url.path) {
            let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: url))
            return PhoneKeptMacs(shown: record.shown, others: record.others)
        }
        guard FileManager.default.fileExists(atPath: legacyURL.path) else { return PhoneKeptMacs() }
        return PhoneKeptMacs(shown: try JSONDecoder().decode(JoinedMac.self, from: Data(contentsOf: legacyURL)))
    }

    /// Writes the whole list at once, then lets go of the one record from before, which this list now holds. The new
    /// list is written beside the old one, protected and left out of backups, and only then renamed over it, so the
    /// list on disk is always whole and never one a backup may take (INF-5265's review). The rename is the save: once
    /// it lands, it throws no more, so a caller never keeps the list from before while the next launch reads this one.
    /// Removing the record from before is tried again on each save, and it is never read once this one exists.
    public func save(_ kept: PhoneKeptMacs) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var staged = folder.appendingPathComponent(".KeptMacs-\(UUID().uuidString).json")
        do {
            try JSONEncoder().encode(Record(shown: kept.shown, others: kept.others))
                .write(to: staged, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try staged.setResourceValues(values)
            guard rename(staged.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        } catch {
            try? FileManager.default.removeItem(at: staged)
            throw error
        }
        try? FileManager.default.removeItem(at: legacyURL)
    }
}
